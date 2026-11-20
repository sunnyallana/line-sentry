//! Read-only views built for people rather than for one screen each:
//!
//!   GET /api/analytics/floor   what every machine is doing right now
//!   GET /api/analytics/losses  where time and output were lost in a period
//!
//! Both load the production records once and fold them in memory, so a page
//! needs one request instead of one per machine.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::{Query, State};
use axum::Json;
use bson::oid::ObjectId;
use chrono::{NaiveDate, Timelike, Utc};
use futures::future::{try_join, try_join3};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::configs::reason_kinds;
use crate::persist::records::NO_REASON;
use crate::routes::common::{mold_rate, molds_used, names_by_id};
use crate::routes::metrics::{percent, CycleTimes, Totals};
use crate::state::AppState;

const UNASSIGNED: &str = "unassigned";

fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}

fn optional_oid(q: &HashMap<String, String>, key: &str) -> AppResult<Option<ObjectId>> {
    q.get(key)
        .filter(|s| !s.is_empty())
        .map(ObjectId::parse_str)
        .transpose()
        .map_err(|_| AppError::bad_request(format!("invalid {key}")))
}

/// Machines the user may see, optionally narrowed. Operators only ever get
/// their own department, whatever they ask for.
async fn visible_machines(
    state: &AppState,
    user: &User,
    department: Option<ObjectId>,
    machine: Option<ObjectId>,
) -> AppResult<Vec<Machine>> {
    let department = if user.role == "operator" {
        Some(
            user.department_id
                .map(|d| d.oid())
                .ok_or(AppError::Forbidden)?,
        )
    } else {
        department
    };
    Ok(state.store.machines.active(department, machine).await?)
}

/// The record's bucket for an hour of the day.
fn bucket(r: &ProductionRecord, hour: i64) -> Option<&HourlyData> {
    r.hourly_data.iter().find(|h| h.hour as i64 == hour)
}

/// The operators named on the given hours.
fn operators_of<'a>(hours: impl Iterator<Item = &'a HourlyData>) -> HashSet<ObjectId> {
    hours
        .filter_map(|h| h.operator_id.map(|o| o.oid()))
        .collect()
}

// ── Floor ────────────────────────────────────────────────────────────────────

/// Live snapshot of every visible machine: state, how long it has been in it,
/// today's output, the current hour against what the mold should make, and any
/// stoppage still waiting for a reason.
pub async fn floor(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let machines = visible_machines(&state, &user, None, None).await?;
    let ids: Vec<ObjectId> = machines
        .iter()
        .filter_map(|m| m.id.map(|i| i.oid()))
        .collect();

    let factory_now = state.config.factory_now();
    let hour = factory_now.hour() as i64;
    let minutes_into_hour = factory_now.minute() as f64 + factory_now.second() as f64 / 60.0;
    let day = factory_now.date_naive();

    let store = &state.store;
    let (records, departments) = try_join(
        store.records.between(&ids, day, day),
        names_by_id(
            &store.departments.rows,
            machines.iter().map(|m| m.department_id.oid()).collect(),
            "name",
        ),
    )
    .await?;
    let today: HashMap<ObjectId, &ProductionRecord> =
        records.iter().map(|r| (r.machine_id.oid(), r)).collect();

    let (operators, molds) = try_join(
        names_by_id(
            &store.users.rows,
            operators_of(records.iter().filter_map(|r| bucket(r, hour))),
            "username",
        ),
        molds_used(store, &records),
    )
    .await?;

    let rows: Vec<Value> = machines
        .iter()
        .filter_map(|m| {
            let id = m.id?.oid();
            let record = today.get(&id).copied();
            let this_hour = record.and_then(|r| bucket(r, hour));
            let mold = this_hour
                .and_then(|h| h.mold_id)
                .and_then(|mid| molds.get(&mid.oid()));
            let rate = this_hour.map(|h| mold_rate(&molds, h)).unwrap_or(0.0);
            // A stoppage with no reason yet, anywhere in today's record.
            let waiting = record.and_then(|r| {
                r.hourly_data
                    .iter()
                    .flat_map(|h| h.stoppages.iter().map(move |s| (h.hour as i64, s)))
                    .filter(|(_, s)| s.reason == NO_REASON)
                    .max_by_key(|(h, _)| *h)
            });
            Some(json!({
                "_id": id.to_hex(),
                "name": m.name,
                "departmentId": m.department_id.to_hex(),
                "departmentName": departments.get(&m.department_id.oid()),
                "status": m.status,
                "statusSince": m.status_since,
                "unitsToday": record.map(|r| r.hourly_data.iter().map(|h| h.units_produced).sum::<f64>()).unwrap_or(0.0),
                "unitsThisHour": this_hour.map(|h| h.units_produced).unwrap_or(0.0),
                "expectedPerHour": rate,
                "expectedSoFar": (rate * minutes_into_hour / 60.0).round(),
                "moldName": mold.map(|m| m.name.clone()),
                "operatorName": this_hour.and_then(|h| h.operator_id).and_then(|o| operators.get(&o.oid())),
                "waitingForReason": waiting.map(|(h, s)| json!({ "hour": h, "minutes": s.duration })),
            }))
        })
        .collect();

    Ok(Json(json!({
        "now": Utc::now(),
        "factoryHour": hour,
        "machines": rows,
    })))
}

// ── Losses ───────────────────────────────────────────────────────────────────

/// The figures of one slice of the data (a machine, a shift, a day, ...).
fn slice_json(t: &Totals) -> Value {
    json!({
        "units": t.units,
        "defective": t.defective,
        "runningMinutes": t.running_minutes,
        "stoppedMinutes": t.stopped_minutes,
        "expectedUnits": t.expected_units.round(),
        "stoppages": t.stoppages,
        "breakdowns": t.breakdowns,
        "availability": percent(t.availability()),
        "quality": percent(t.quality()),
        // Without a mold there is no expected rate, so no performance or OEE:
        // null, not 0%.
        "performance": t.performance().map(percent),
        "oee": t.oee().map(percent),
        "mtbfMinutes": t.mtbf_minutes().round() as i64,
        "mttrMinutes": t.mttr_minutes().round() as i64,
        "failureRate": (t.failure_rate() * 10.0).round() / 10.0,
    })
}

/// Totals keyed by id, each with a display name, largest first by `rank`.
struct Groups {
    items: HashMap<String, (String, Totals)>,
}

impl Groups {
    fn new() -> Self {
        Self {
            items: HashMap::new(),
        }
    }

    fn slice(&mut self, key: &str, name: impl FnOnce() -> String) -> &mut Totals {
        &mut self
            .items
            .entry(key.to_string())
            .or_insert_with(|| (name(), Totals::default()))
            .1
    }

    fn to_json(&self, rank: fn(&Totals) -> f64) -> Value {
        let mut rows: Vec<(&String, &(String, Totals))> = self.items.iter().collect();
        rows.sort_by(|a, b| {
            rank(&b.1 .1)
                .total_cmp(&rank(&a.1 .1))
                .then(a.1 .0.cmp(&b.1 .0))
        });
        Value::Array(
            rows.into_iter()
                .map(|(key, (name, slice))| {
                    let mut v = slice_json(slice);
                    v["key"] = json!(key);
                    v["name"] = json!(name);
                    v
                })
                .collect(),
        )
    }
}

/// Where time and output went between two days (inclusive): totals, stoppage
/// time by reason, and the same figures cut by machine, shift, operator, mold
/// and day.
pub async fn losses(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let today = state.config.factory_now().date_naive();
    let from = match q.get("startDate") {
        Some(s) => parse_day(s).ok_or_else(|| AppError::bad_request("invalid startDate"))?,
        None => today,
    };
    let to = match q.get("endDate") {
        Some(s) => parse_day(s).ok_or_else(|| AppError::bad_request("invalid endDate"))?,
        None => today,
    };
    if from > to {
        return Err(AppError::bad_request("startDate must not be after endDate"));
    }

    let machines = visible_machines(
        &state,
        &user,
        optional_oid(&q, "departmentId")?,
        optional_oid(&q, "machineId")?,
    )
    .await?;
    let machine_names: HashMap<ObjectId, String> = machines
        .iter()
        .filter_map(|m| m.id.map(|id| (id.oid(), m.name.clone())))
        .collect();
    let ids: Vec<ObjectId> = machine_names.keys().copied().collect();

    let store = &state.store;
    let (records, shifts, reasons) = try_join3(
        store.records.between(&ids, from, to),
        store.configs.shifts(),
        store.configs.stoppage_reasons(),
    )
    .await?;
    let (molds, operators) = try_join(
        molds_used(store, &records),
        names_by_id(
            &store.users.rows,
            operators_of(records.iter().flat_map(|r| r.hourly_data.iter())),
            "username",
        ),
    )
    .await?;
    let kinds = reason_kinds(&reasons);

    let mut total = Totals::default();
    let mut cycle_times = CycleTimes::default();
    let mut by_machine = Groups::new();
    let mut by_shift = Groups::new();
    let mut by_operator = Groups::new();
    let mut by_mold = Groups::new();
    let mut by_day: BTreeMap<String, Totals> = BTreeMap::new();
    // reason -> (minutes, count)
    let mut by_reason: HashMap<String, (f64, i64)> = HashMap::new();

    for r in &records {
        let machine = r.machine_id.oid();
        let day = r.start_time.format("%Y-%m-%d").to_string();
        for h in &r.hourly_data {
            let mold = h.mold_id.and_then(|m| molds.get(&m.oid()));
            let rate = mold_rate(&molds, h);

            total.add_hour(h, rate, &kinds);
            cycle_times.add_hour(h);
            by_day
                .entry(day.clone())
                .or_default()
                .add_hour(h, rate, &kinds);
            by_machine
                .slice(&machine.to_hex(), || {
                    machine_names.get(&machine).cloned().unwrap_or_default()
                })
                .add_hour(h, rate, &kinds);

            let shift = shifts.iter().find(|s| s.contains(h.hour as i64));
            by_shift
                .slice(shift.map(|s| s.name.as_str()).unwrap_or(UNASSIGNED), || {
                    shift
                        .map(|s| s.name.clone())
                        .unwrap_or_else(|| "Outside shifts".to_string())
                })
                .add_hour(h, rate, &kinds);

            let operator = h.operator_id.map(|o| o.oid());
            by_operator
                .slice(
                    &operator
                        .map(|o| o.to_hex())
                        .unwrap_or_else(|| UNASSIGNED.to_string()),
                    || {
                        operator
                            .and_then(|o| operators.get(&o).cloned())
                            .unwrap_or_else(|| "No operator assigned".to_string())
                    },
                )
                .add_hour(h, rate, &kinds);

            by_mold
                .slice(
                    &h.mold_id
                        .map(|m| m.to_hex())
                        .unwrap_or_else(|| UNASSIGNED.to_string()),
                    || {
                        mold.map(|m| m.name.clone())
                            .unwrap_or_else(|| "No mold assigned".to_string())
                    },
                )
                .add_hour(h, rate, &kinds);

            for s in &h.stoppages {
                let entry = by_reason.entry(s.reason.clone()).or_default();
                entry.0 += s.duration;
                entry.1 += 1;
            }
        }
    }

    let mut reasons: Vec<(String, (f64, i64))> = by_reason.into_iter().collect();
    reasons.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    let reason_minutes: f64 = reasons.iter().map(|(_, (m, _))| m).sum();
    let mut running_share = 0.0;
    let reasons: Vec<Value> = reasons
        .into_iter()
        .map(|(reason, (minutes, count))| {
            running_share += minutes;
            json!({
                "reason": reason,
                "minutes": minutes,
                "count": count,
                "share": if reason_minutes > 0.0 { (minutes / reason_minutes * 100.0).round() } else { 0.0 },
                "cumulativeShare": if reason_minutes > 0.0 { (running_share / reason_minutes * 100.0).round() } else { 0.0 },
            })
        })
        .collect();

    let daily: Vec<Value> = by_day
        .iter()
        .map(|(day, slice)| {
            let mut v = slice_json(slice);
            v["date"] = json!(day);
            v
        })
        .collect();

    // Seconds per unit the molds in use call for, over the time that ran.
    let ideal_seconds =
        (total.expected_units > 0.0).then(|| total.running_minutes * 60.0 / total.expected_units);

    Ok(Json(json!({
        "from": from.format("%Y-%m-%d").to_string(),
        "to": to.format("%Y-%m-%d").to_string(),
        "total": slice_json(&total),
        "byReason": reasons,
        "byMachine": by_machine.to_json(|s| s.stopped_minutes),
        "byShift": by_shift.to_json(|s| s.units),
        "byOperator": by_operator.to_json(|s| s.units),
        "byMold": by_mold.to_json(|s| s.units),
        "daily": daily,
        "cycleTimes": cycle_times.to_json(ideal_seconds),
    })))
}
