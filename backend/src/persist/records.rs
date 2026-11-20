//! Production records: one row per machine per factory day, with a bucket per
//! hour. Every change the pipeline makes to a bucket is a single atomic write
//! guarded by its own condition, so concurrent payloads cannot overwrite each
//! other.

use std::collections::HashMap;

use bson::{doc, oid::ObjectId, Bson};
use chrono::{DateTime, NaiveDate, Timelike, Utc};
use mongodb::Database;

use super::{is_duplicate_key, Batch, Changes, DbResult, Entity, Filter, Persister};
use crate::models::{HourlyData, Id, ProductionRecord, PRODUCTION_RECORDS};

impl Entity for ProductionRecord {
    const COLLECTION: &'static str = PRODUCTION_RECORDS;
}

/// Field names. `HOUR_*` are relative to an hour bucket.
pub mod f {
    pub const MACHINE: &str = "machineId";
    pub const DAY: &str = "startTime";
    pub const UNITS: &str = "unitsProduced";
    pub const HOURS: &str = "hourlyData";
    pub const HOUR: &str = "hour";
    pub const HOUR_UNITS: &str = "unitsProduced";
    pub const HOUR_STATUS: &str = "status";
    pub const HOUR_RUNNING: &str = "runningMinutes";
    pub const HOUR_STOPPED: &str = "stoppageMinutes";
    pub const HOUR_STOPPAGES: &str = "stoppages";
    pub const HOUR_CYCLES: &str = "cycleBuckets";
    pub const STOP_REASON: &str = "reason";
    pub const STOP_PENDING: &str = "isPending";
    pub const DEFECTIVE: &str = "defectiveUnits";
    pub const HOUR_DEFECTIVE: &str = "defectiveUnits";
    pub const HOUR_OPERATOR: &str = "operatorId";
    pub const HOUR_MOLD: &str = "moldId";
    pub const STOP_DESCRIPTION: &str = "description";
    pub const STOP_SAP_NUMBER: &str = "sapNotificationNumber";
    pub const STOP_START: &str = "startTime";
    pub const STOP_END: &str = "endTime";
    pub const STOP_DURATION: &str = "duration";
    pub const STOP_CLASSIFIED: &str = "isClassified";
}

/// The reason a stoppage carries until a person gives it one.
pub const NO_REASON: &str = "unclassified";

/// First and last instant of a factory day, as stored.
pub fn day_bounds(d: NaiveDate) -> (bson::DateTime, bson::DateTime) {
    let start = d.and_hms_opt(0, 0, 0).unwrap().and_utc();
    let end = d.and_hms_milli_opt(23, 59, 59, 999).unwrap().and_utc();
    (
        bson::DateTime::from_chrono(start),
        bson::DateTime::from_chrono(end),
    )
}

/// A stoppage with no reason that is still running.
fn open_stoppage() -> Filter {
    Filter::all()
        .eq(f::STOP_REASON, NO_REASON)
        .eq(f::STOP_PENDING, true)
}

/// Path of a field in the hour bucket the filter matched.
fn in_hour(field: &str) -> String {
    format!("{}.$.{field}", f::HOURS)
}

pub struct Records {
    pub rows: Persister<ProductionRecord>,
}

impl Records {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// The machine's row for the day of `t`.
    fn day(machine: Id, t: DateTime<Utc>) -> Filter {
        let (start, end) = day_bounds(t.date_naive());
        Filter::all()
            .eq(f::MACHINE, machine.oid())
            .gte(f::DAY, start)
            .lte(f::DAY, end)
    }

    /// The bucket for the hour of `t`, with extra conditions on that bucket.
    fn hour(machine: Id, t: DateTime<Utc>, when: Filter) -> Filter {
        Self::day(machine, t).has(
            f::HOURS,
            Filter::all().eq(f::HOUR, t.hour() as i64).and(when),
        )
    }

    /// Count `units` for the hour of `t`, and optionally one gap in the hour's
    /// cycle-time histogram. `matched == 0` in the result means the hour has
    /// no bucket yet: call [`Records::ensure_hour`] and queue it again.
    pub fn queue_units(
        &self,
        batch: &mut Batch,
        machine: Id,
        t: DateTime<Utc>,
        units: u32,
        cycle_bucket: Option<usize>,
    ) -> usize {
        let mut changes = Changes::new()
            .add(&in_hour(f::HOUR_UNITS), units as f64)
            .add(f::UNITS, units as f64)
            .set(&in_hour(f::HOUR_STATUS), "running")
            .set("lastActivityTime", bson::DateTime::from_chrono(t))
            .set("updatedAt", bson::DateTime::now());
        if let Some(b) = cycle_bucket {
            changes = changes.add(&in_hour(&format!("{}.b{b}", f::HOUR_CYCLES)), 1);
        }
        batch.update(&self.rows, Self::hour(machine, t, Filter::all()), changes)
    }

    /// Count one running minute for the hour of `t`, up to the hour's 60.
    /// `matched == 0` means the bucket is missing or already full.
    pub fn queue_running_minute(&self, batch: &mut Batch, machine: Id, t: DateTime<Utc>) -> usize {
        batch.update(
            &self.rows,
            Self::hour(machine, t, Filter::all().lt(f::HOUR_RUNNING, 60.0)),
            Changes::new()
                .add(&in_hour(f::HOUR_RUNNING), 1.0)
                .set(&in_hour(f::HOUR_STATUS), "running")
                .set("updatedAt", bson::DateTime::now()),
        )
    }

    /// The hour buckets of several machines for the hour of `t`, in one read
    /// that returns only that bucket of each row.
    pub async fn hours_at(
        &self,
        machines: &[Id],
        t: DateTime<Utc>,
    ) -> DbResult<HashMap<Id, HourlyData>> {
        if machines.is_empty() {
            return Ok(HashMap::new());
        }
        let (start, end) = day_bounds(t.date_naive());
        let hour = t.hour() as i64;
        let rows = self
            .rows
            .raw()
            .find(
                Filter::all()
                    .any_of(f::MACHINE, machines.iter().map(|m| m.oid()))
                    .gte(f::DAY, start)
                    .lte(f::DAY, end)
                    .into_doc(),
            )
            .projection(doc! { f::MACHINE: 1, f::HOURS: { "$elemMatch": { f::HOUR: hour } } })
            .await?;
        use futures::TryStreamExt;
        let rows: Vec<bson::Document> = rows.try_collect().await?;
        let mut buckets = HashMap::with_capacity(rows.len());
        for mut row in rows {
            let Ok(machine) = row.get_object_id(f::MACHINE) else {
                continue;
            };
            let Some(Bson::Array(mut hours)) = row.remove(f::HOURS) else {
                continue; // the machine's day has no bucket for this hour
            };
            let Some(Bson::Document(bucket)) = hours.pop() else {
                continue;
            };
            // Through the raw form, as the driver itself decodes: ids and dates
            // are native BSON here, not the strings the JSON form uses.
            let bucket: HourlyData = bson::from_slice(&bson::to_vec(&bucket)?)?;
            buckets.insert(Id(machine), bucket);
        }
        Ok(buckets)
    }

    /// The `_id` of the machine's row for the day of `t`, created empty if
    /// there is none. Safe when several payloads try at once.
    async fn day_row(&self, machine: Id, t: DateTime<Utc>) -> DbResult<ObjectId> {
        if let Some(id) = self.rows.ids(Self::day(machine, t)).await?.first() {
            return Ok(*id);
        }
        let (start, _) = day_bounds(t.date_naive());
        let now = bson::DateTime::now();
        let created = self
            .rows
            .upsert(
                Filter::all()
                    .eq(f::MACHINE, machine.oid())
                    .eq(f::DAY, start),
                Changes::new()
                    .set_on_insert(f::UNITS, 0.0)
                    .set_on_insert("defectiveUnits", 0.0)
                    .set_on_insert(f::HOURS, Bson::Array(Vec::new()))
                    .set_on_insert("createdAt", now)
                    .set_on_insert("updatedAt", now),
            )
            .await;
        match created {
            Ok(w) => {
                if let Some(id) = w.inserted {
                    return Ok(id);
                }
            }
            // Another payload created it in the same instant.
            Err(e) if is_duplicate_key(&e) => {}
            Err(e) => return Err(e),
        }
        match self.rows.ids(Self::day(machine, t)).await?.first() {
            Some(id) => Ok(*id),
            None => Err(mongodb::error::Error::custom(
                "production record vanished while being created",
            )),
        }
    }

    /// Add the bucket for the hour of `t` if it is not there yet.
    pub async fn ensure_hour(&self, machine: Id, t: DateTime<Utc>) -> DbResult<()> {
        let id = self.day_row(machine, t).await?;
        let hour = t.hour() as i64;
        self.rows
            .update(
                Filter::id(id).ne(&format!("{}.{}", f::HOURS, f::HOUR), hour),
                Changes::new().append(
                    f::HOURS,
                    doc! {
                        f::HOUR: hour as f64,
                        f::HOUR_UNITS: 0.0,
                        "defectiveUnits": 0.0,
                        f::HOUR_STATUS: "running",
                        f::HOUR_STOPPAGES: [],
                        f::HOUR_RUNNING: 0.0,
                        f::HOUR_STOPPED: 0.0,
                    },
                ),
            )
            .await?;
        Ok(())
    }

    /// Open a stoppage with no reason in the hour of `t`, unless the hour
    /// already has one open. Returns whether one was opened.
    pub async fn open_stoppage(
        &self,
        machine: Id,
        t: DateTime<Utc>,
        stoppage_id: ObjectId,
    ) -> DbResult<bool> {
        let unless_open = Filter::all().has_no(f::HOUR_STOPPAGES, open_stoppage());
        let changes = Changes::new()
            .append(
                &in_hour(f::HOUR_STOPPAGES),
                doc! {
                    "_id": stoppage_id,
                    f::STOP_REASON: NO_REASON,
                    "description": "Automatic stoppage detection - awaiting categorization",
                    "startTime": bson::DateTime::from_chrono(t),
                    "duration": 0.0,
                    f::STOP_PENDING: true,
                    "isClassified": false,
                },
            )
            .set(&in_hour(f::HOUR_STATUS), "stoppage")
            .set("updatedAt", bson::DateTime::now());
        let filter = Self::hour(machine, t, unless_open);
        if self
            .rows
            .update(filter.clone(), changes.clone())
            .await?
            .modified
            == 1
        {
            return Ok(true);
        }
        self.ensure_hour(machine, t).await?;
        Ok(self.rows.update(filter, changes).await?.modified == 1)
    }

    /// The machine is cycling again at `t`. A stoppage with no reason in the
    /// current hour was a pause and is dropped; one from an earlier hour is
    /// closed and keeps waiting for its reason.
    pub async fn close_stoppages(&self, machine: Id, t: DateTime<Utc>) -> DbResult<()> {
        let with_unexplained = Filter::all().eq(
            &format!("{}.{}", f::HOUR_STOPPAGES, f::STOP_REASON),
            NO_REASON,
        );
        let after = self
            .rows
            .update_returning(
                Self::hour(machine, t, with_unexplained),
                Changes::new()
                    .remove_where(
                        &in_hour(f::HOUR_STOPPAGES),
                        Filter::all().eq(f::STOP_REASON, NO_REASON),
                    )
                    .set(&in_hour(f::HOUR_STATUS), "running")
                    .set("updatedAt", bson::DateTime::now()),
            )
            .await?;
        if let Some(rec) = after {
            // The hour's stopped minutes follow the stoppages that remain.
            let hour = t.hour() as i64;
            let remaining: f64 = rec
                .hourly_data
                .iter()
                .find(|h| h.hour as i64 == hour)
                .map(|h| h.stoppages.iter().map(|s| s.duration).sum())
                .unwrap_or(0.0);
            self.rows
                .update(
                    Self::hour(machine, t, Filter::all()),
                    Changes::new().set(&in_hour(f::HOUR_STOPPED), remaining.min(60.0)),
                )
                .await?;
        }

        let (yesterday, _) = day_bounds(t.date_naive() - chrono::Duration::days(1));
        self.rows
            .update_all(
                Filter::all()
                    .eq(f::MACHINE, machine.oid())
                    .gte(f::DAY, yesterday)
                    .has(
                        &format!("{}.{}", f::HOURS, f::HOUR_STOPPAGES),
                        open_stoppage(),
                    ),
                Changes::new()
                    .set(
                        &format!(
                            "{}.$[].{}.$[open].{}",
                            f::HOURS,
                            f::HOUR_STOPPAGES,
                            f::STOP_PENDING
                        ),
                        false,
                    )
                    .set(
                        &format!("{}.$[].{}.$[open].endTime", f::HOURS, f::HOUR_STOPPAGES),
                        bson::DateTime::from_chrono(t),
                    )
                    .where_element("open", open_stoppage()),
            )
            .await?;
        Ok(())
    }

    /// Rows since the day before `today` that still have an open stoppage.
    pub async fn with_open_stoppages(&self, today: NaiveDate) -> DbResult<Vec<ProductionRecord>> {
        let (since, _) = day_bounds(today - chrono::Duration::days(1));
        self.rows
            .find(Filter::all().gte(f::DAY, since).has(
                &format!("{}.{}", f::HOURS, f::HOUR_STOPPAGES),
                open_stoppage(),
            ))
            .await
    }

    /// Set an open stoppage's duration and its hour's stopped minutes, and
    /// nothing else on the row. Returns whether it was still open.
    pub async fn set_stoppage_duration(
        &self,
        record: ObjectId,
        hour: i64,
        stoppage: ObjectId,
        duration: f64,
        hour_stopped: f64,
    ) -> DbResult<bool> {
        let written = self
            .rows
            .update(
                Filter::id(record),
                Changes::new()
                    .set(
                        &format!("{}.$[h].{}.$[s].duration", f::HOURS, f::HOUR_STOPPAGES),
                        duration,
                    )
                    .set(
                        &format!("{}.$[h].{}", f::HOURS, f::HOUR_STOPPED),
                        hour_stopped,
                    )
                    .set("updatedAt", bson::DateTime::now())
                    .where_element("h", Filter::all().eq(f::HOUR, hour))
                    .where_element("s", Filter::id(stoppage).eq(f::STOP_PENDING, true)),
            )
            .await?;
        Ok(written.modified == 1)
    }

    /// Every row of the given machines between two factory days, inclusive.
    pub async fn between(
        &self,
        machines: &[ObjectId],
        from: NaiveDate,
        to: NaiveDate,
    ) -> DbResult<Vec<ProductionRecord>> {
        if machines.is_empty() {
            return Ok(Vec::new());
        }
        self.rows
            .find(
                Filter::all()
                    .any_of(f::MACHINE, machines.iter().copied())
                    .gte(f::DAY, day_bounds(from).0)
                    .lte(f::DAY, day_bounds(to).1),
            )
            .await
    }

    /// The machine's row for a factory day, if any.
    pub async fn for_day(
        &self,
        machine: ObjectId,
        day: NaiveDate,
    ) -> DbResult<Option<ProductionRecord>> {
        let (start, end) = day_bounds(day);
        self.rows
            .find_one(
                Filter::all()
                    .eq(f::MACHINE, machine)
                    .gte(f::DAY, start)
                    .lte(f::DAY, end),
            )
            .await
    }

    /// Rows whose day starts within the two instants, optionally of one
    /// machine. Unlike [`Records::between`] the instants are taken as given,
    /// so a period that starts mid-day leaves that day out.
    pub async fn started_between(
        &self,
        machine: Option<ObjectId>,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> DbResult<Vec<ProductionRecord>> {
        let mut filter = Filter::all()
            .gte(f::DAY, bson::DateTime::from_chrono(from))
            .lte(f::DAY, bson::DateTime::from_chrono(to));
        if let Some(m) = machine {
            filter = filter.eq(f::MACHINE, m);
        }
        self.rows.find(filter).await
    }

    /// How many stoppages, on any day, still have no reason. Counted on the
    /// server so the rows holding them are not loaded.
    pub async fn unclassified_stoppages(&self) -> DbResult<u64> {
        let stoppages = format!("{}.{}", f::HOURS, f::HOUR_STOPPAGES);
        let reason = format!("{stoppages}.{}", f::STOP_REASON);
        let counted = self
            .rows
            .aggregate(vec![
                doc! { "$match": { reason.as_str(): NO_REASON } },
                doc! { "$unwind": format!("${}", f::HOURS) },
                doc! { "$unwind": format!("${stoppages}") },
                doc! { "$match": { reason.as_str(): NO_REASON } },
                doc! { "$count": "stoppages" },
            ])
            .await?;
        Ok(match counted.first().and_then(|d| d.get("stoppages")) {
            Some(Bson::Int32(n)) => *n as u64,
            Some(Bson::Int64(n)) => *n as u64,
            _ => 0,
        })
    }

    /// Like [`Records::ensure_hour`], for a bucket a person creates ahead of
    /// production: it starts in `status` instead of running.
    pub async fn ensure_hour_as(
        &self,
        machine: Id,
        t: DateTime<Utc>,
        status: &str,
    ) -> DbResult<()> {
        let id = self.day_row(machine, t).await?;
        let hour = t.hour() as i64;
        self.rows
            .update(
                Filter::id(id).ne(&format!("{}.{}", f::HOURS, f::HOUR), hour),
                Changes::new().append(
                    f::HOURS,
                    doc! {
                        f::HOUR: hour as f64,
                        f::HOUR_UNITS: 0.0,
                        f::HOUR_DEFECTIVE: 0.0,
                        f::HOUR_STATUS: status,
                        f::HOUR_STOPPAGES: [],
                        f::HOUR_RUNNING: 0.0,
                        f::HOUR_STOPPED: 0.0,
                    },
                ),
            )
            .await?;
        Ok(())
    }

    /// Give a stoppage in the hour of `t` its reason: the one with id
    /// `wanted`, or else the first that has none. A stoppage that is still
    /// running ends at `now` (factory-local, like its start); one that already
    /// ended keeps its end and duration. Only that stoppage and the hour's
    /// stopped minutes and status are written. Returns false when the hour
    /// has no such stoppage.
    pub async fn classify_stoppage(
        &self,
        machine: Id,
        t: DateTime<Utc>,
        wanted: Option<ObjectId>,
        note: &StoppageNote<'_>,
        now: DateTime<Utc>,
    ) -> DbResult<bool> {
        let Some(record) = self.for_day(machine.oid(), t.date_naive()).await? else {
            return Ok(false);
        };
        let hour = t.hour() as i64;
        let Some(bucket) = record.hourly_data.iter().find(|h| h.hour as i64 == hour) else {
            return Ok(false);
        };
        let is_wanted =
            |s: &crate::models::Stoppage| wanted.is_some() && s.id.map(|i| i.oid()) == wanted;
        let Some(found) = bucket
            .stoppages
            .iter()
            .position(|s| is_wanted(s) || s.reason == NO_REASON)
        else {
            return Ok(false);
        };
        let stoppage = &bucket.stoppages[found];

        let (end, duration) = match stoppage.end_time {
            Some(end) if !stoppage.is_pending => (end, stoppage.duration),
            _ => {
                let start = stoppage.start_time.unwrap_or(now);
                (now, ((now - start).num_seconds() / 60).max(0) as f64)
            }
        };
        let others: f64 = bucket
            .stoppages
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != found)
            .map(|(_, s)| s.duration)
            .sum();

        // Stoppages written by the old server may have no id of their own.
        let this = match stoppage.id {
            Some(id) => Filter::id(id.oid()),
            None => Filter::all().eq(f::STOP_REASON, NO_REASON),
        };
        let in_stoppage =
            |field: &str| format!("{}.$[h].{}.$[s].{field}", f::HOURS, f::HOUR_STOPPAGES);
        let optional = |changes: Changes, field: &str, value: Option<&str>| match value {
            Some(v) => changes.set(&in_stoppage(field), v),
            None => changes.clear(&in_stoppage(field)),
        };
        let changes = Changes::new()
            .set(&in_stoppage(f::STOP_REASON), note.reason)
            .set(&in_stoppage(f::STOP_END), bson::DateTime::from_chrono(end))
            .set(&in_stoppage(f::STOP_DURATION), duration)
            .set(&in_stoppage(f::STOP_PENDING), false)
            .set(&in_stoppage(f::STOP_CLASSIFIED), true)
            .set(
                &format!("{}.$[h].{}", f::HOURS, f::HOUR_STOPPED),
                (others + duration).min(60.0),
            )
            .set(&format!("{}.$[h].{}", f::HOURS, f::HOUR_STATUS), "stoppage")
            .set("updatedAt", bson::DateTime::now())
            .where_element("h", Filter::all().eq(f::HOUR, hour))
            .where_element("s", this.clone());
        let changes = optional(changes, f::STOP_DESCRIPTION, note.description);
        let changes = optional(changes, f::STOP_SAP_NUMBER, note.sap_number);

        // The machine may have restarted since the read, which drops a
        // stoppage that had no reason: then there is nothing left to classify.
        let still_there = Self::hour(machine, t, Filter::all().has(f::HOUR_STOPPAGES, this));
        Ok(self.rows.update(still_there, changes).await?.matched == 1)
    }

    /// Record a stoppage a person reports for the hour of `t`, lasting
    /// `minutes` from the start of that hour. Appends it and raises the hour's
    /// stopped minutes by its duration, up to the hour's 60.
    pub async fn add_stoppage(
        &self,
        machine: Id,
        t: DateTime<Utc>,
        minutes: f64,
        note: &StoppageNote<'_>,
    ) -> DbResult<()> {
        let mut stoppage = doc! { "_id": ObjectId::new(), f::STOP_REASON: note.reason };
        if let Some(d) = note.description {
            stoppage.insert(f::STOP_DESCRIPTION, d);
        }
        if let Some(n) = note.sap_number {
            stoppage.insert(f::STOP_SAP_NUMBER, n);
        }
        stoppage.insert(f::STOP_START, bson::DateTime::from_chrono(t));
        stoppage.insert(
            f::STOP_END,
            bson::DateTime::from_chrono(t + chrono::Duration::minutes(minutes as i64)),
        );
        stoppage.insert(f::STOP_DURATION, minutes);
        stoppage.insert(f::STOP_PENDING, false);
        stoppage.insert(f::STOP_CLASSIFIED, true);

        let hour = Self::hour(machine, t, Filter::all());
        let changes = Changes::new()
            .append(&in_hour(f::HOUR_STOPPAGES), stoppage)
            .add(&in_hour(f::HOUR_STOPPED), minutes)
            .set(&in_hour(f::HOUR_STATUS), "stoppage")
            .set("updatedAt", bson::DateTime::now());
        if self
            .rows
            .update(hour.clone(), changes.clone())
            .await?
            .matched
            == 0
        {
            self.ensure_hour(machine, t).await?;
            self.rows.update(hour, changes).await?;
        }
        self.rows
            .update(
                Self::hour(machine, t, Filter::all().gt(f::HOUR_STOPPED, 60.0)),
                Changes::new().set(&in_hour(f::HOUR_STOPPED), 60.0),
            )
            .await?;
        Ok(())
    }

    /// Set (or, with `None`, remove) the operator and mold of the hour of `t`
    /// and nothing else on the row. `matched == 0` in the result means the
    /// hour has no bucket yet: call [`Records::ensure_hour_as`] and queue it
    /// again.
    pub fn queue_assignment(
        &self,
        batch: &mut Batch,
        machine: Id,
        t: DateTime<Utc>,
        operator: Option<ObjectId>,
        mold: Option<ObjectId>,
    ) -> usize {
        let assign = |changes: Changes, field: &str, to: Option<ObjectId>| match to {
            Some(id) => changes.set(&in_hour(field), id),
            None => changes.clear(&in_hour(field)),
        };
        let changes = Changes::new().set("updatedAt", bson::DateTime::now());
        let changes = assign(changes, f::HOUR_OPERATOR, operator);
        let changes = assign(changes, f::HOUR_MOLD, mold);
        batch.update(&self.rows, Self::hour(machine, t, Filter::all()), changes)
    }

    /// Set the defective units of the hour of `t` and make the row's total
    /// the sum of its hours again, in one statement that reads the row as it
    /// is at that moment: units counted meanwhile are kept. Returns false
    /// when the hour has no bucket.
    pub async fn set_defective(&self, machine: Id, t: DateTime<Utc>, units: f64) -> DbResult<bool> {
        let hours = format!("${}", f::HOURS);
        let written = self
            .rows
            .raw()
            .update_one(
                Self::hour(machine, t, Filter::all()).into_doc(),
                vec![
                    doc! { "$set": { f::HOURS: { "$map": {
                        "input": hours.as_str(),
                        "as": "h",
                        "in": { "$cond": [
                            { "$eq": [format!("$$h.{}", f::HOUR), t.hour() as i64] },
                            { "$mergeObjects": ["$$h", { f::HOUR_DEFECTIVE: { "$literal": units } }] },
                            "$$h",
                        ] },
                    } } } },
                    doc! { "$set": {
                        f::DEFECTIVE: { "$sum": format!("{hours}.{}", f::HOUR_DEFECTIVE) },
                        "updatedAt": "$$NOW",
                    } },
                ],
            )
            .await?;
        Ok(written.matched_count == 1)
    }
}

/// What a person says about a stoppage.
pub struct StoppageNote<'a> {
    pub reason: &'a str,
    pub description: Option<&'a str>,
    /// The SAP notification raised for a breakdown.
    pub sap_number: Option<&'a str>,
}
