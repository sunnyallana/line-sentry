//! Signal-ingestion pipeline — the heart of LineSentry.
//!
//! Faithful port of `server/routes/signals.js`: a hex byte from the daemon is
//! decoded bit-by-bit into pin states; power/unit-cycle sensors drive a 4-state
//! machine (running / stoppage / stopped_yet_producing / inactive); production
//! records and unclassified stoppages are maintained; and the same Socket.IO
//! events are broadcast. Improvements over Node: cached pin mappings (instead of
//! a per-request aggregation) and payload idempotency (stops unit double-count).
//!
//! Parity caveat: record updates are read-modify-write (like Mongoose `.save()`),
//! not atomic. The daemon posts serially so races are unlikely; moving to atomic
//! `$inc`/array updates is a follow-up.

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use bson::{doc, oid::ObjectId, Document};
use chrono::{DateTime, NaiveDate, Timelike, Utc};
use dashmap::DashMap;
use futures::TryStreamExt;
use mongodb::{Collection, Database};
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::realtime;
use crate::state::AppState;

const PIN_CACHE_TTL: Duration = Duration::from_secs(10);
const DEDUP_TTL: Duration = Duration::from_secs(30);

/// One resolved pin → its sensor and machine.
#[derive(Clone)]
pub struct PinInfo {
    pub sensor_id: Id,
    pub sensor_type: String,
    pub machine_id: Id,
}

#[derive(Clone)]
struct Unclassified {
    id: Id,
    start_time: DateTime<Utc>,
    hour: i64,
    date: String,
}

/// In-memory state shared across requests and the background monitor.
pub struct PipelineState {
    last_power: DashMap<String, DateTime<Utc>>,
    last_cycle: DashMap<String, DateTime<Utc>>,
    last_activity: DashMap<String, DateTime<Utc>>,
    running_minute: DashMap<String, i64>,
    pending_stoppages: DashMap<String, ()>,
    unclassified: DashMap<String, Unclassified>,
    recent_payloads: DashMap<String, Instant>,
    pin_cache: RwLock<Option<(Instant, HashMap<String, PinInfo>)>>,
}

impl PipelineState {
    pub fn new() -> Self {
        Self {
            last_power: DashMap::new(),
            last_cycle: DashMap::new(),
            last_activity: DashMap::new(),
            running_minute: DashMap::new(),
            pending_stoppages: DashMap::new(),
            unclassified: DashMap::new(),
            recent_payloads: DashMap::new(),
            pin_cache: RwLock::new(None),
        }
    }

    /// True if this exact payload was seen within the dedup window.
    fn is_duplicate(&self, key: &str) -> bool {
        let now = Instant::now();
        if self.recent_payloads.len() > 5000 {
            self.recent_payloads.retain(|_, exp| *exp > now);
        }
        if let Some(exp) = self.recent_payloads.get(key) {
            if *exp.value() > now {
                return true;
            }
        }
        self.recent_payloads
            .insert(key.to_string(), now + DEDUP_TTL);
        false
    }

    /// Pin → {sensor, machine} map, cached with a short TTL (was a per-request
    /// aggregation in Node).
    async fn pin_mappings(&self, db: &Database) -> AppResult<HashMap<String, PinInfo>> {
        if let Some((at, map)) = self.pin_cache.read().unwrap().as_ref() {
            if at.elapsed() < PIN_CACHE_TTL {
                return Ok(map.clone());
            }
        }

        let mappings: Vec<SensorPinMapping> = db
            .collection::<SensorPinMapping>(SENSOR_PIN_MAPPINGS)
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        let sensors: Vec<Sensor> = db
            .collection::<Sensor>(SENSORS)
            .find(doc! {})
            .await?
            .try_collect()
            .await?;

        let sensor_by_id: HashMap<Id, &Sensor> = sensors
            .iter()
            .filter_map(|s| s.id.map(|id| (id, s)))
            .collect();

        let mut map = HashMap::new();
        for m in &mappings {
            if let Some(s) = sensor_by_id.get(&m.sensor_id) {
                map.insert(
                    m.pin_id.clone(),
                    PinInfo {
                        sensor_id: m.sensor_id,
                        sensor_type: s.sensor_type.clone(),
                        machine_id: s.machine_id,
                    },
                );
            }
        }

        *self.pin_cache.write().unwrap() = Some((Instant::now(), map.clone()));
        Ok(map)
    }
}

impl Default for PipelineState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Time helpers ─────────────────────────────────────────────────────────────
fn parse_timestamp(ts: Option<&str>) -> DateTime<Utc> {
    match ts {
        Some(s) if !s.is_empty() => DateTime::parse_from_rfc3339(s)
            .map(|d| d.with_timezone(&Utc))
            .or_else(|_| {
                chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
                    .map(|n| n.and_utc())
            })
            .unwrap_or_else(|_| Utc::now()),
        _ => Utc::now(),
    }
}

fn day_bounds(t: DateTime<Utc>) -> (bson::DateTime, bson::DateTime) {
    bounds_for(t.date_naive())
}

fn day_bounds_from_str(date: &str) -> (bson::DateTime, bson::DateTime) {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap_or_else(|_| Utc::now().date_naive());
    bounds_for(d)
}

fn bounds_for(d: NaiveDate) -> (bson::DateTime, bson::DateTime) {
    let start = d.and_hms_opt(0, 0, 0).unwrap().and_utc();
    let end = d.and_hms_milli_opt(23, 59, 59, 999).unwrap().and_utc();
    (
        bson::DateTime::from_chrono(start),
        bson::DateTime::from_chrono(end),
    )
}

fn date_str(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%d").to_string()
}

// ── Record helpers ───────────────────────────────────────────────────────────
fn records(db: &Database) -> Collection<ProductionRecord> {
    db.collection::<ProductionRecord>(PRODUCTION_RECORDS)
}

/// Load today's record for a machine, or build a fresh (unsaved) one.
async fn load_today(
    db: &Database,
    machine_id: Id,
    t: DateTime<Utc>,
) -> AppResult<ProductionRecord> {
    let (start, end) = day_bounds(t);
    if let Some(r) = records(db)
        .find_one(
            doc! { "machineId": machine_id.oid(), "startTime": { "$gte": start, "$lt": end } },
        )
        .await?
    {
        return Ok(r);
    }
    Ok(ProductionRecord {
        id: None,
        machine_id,
        operator_id: None,
        mold_id: None,
        units_produced: 0.0,
        defective_units: 0.0,
        start_time: start.to_chrono(),
        end_time: None,
        hourly_data: Vec::new(),
        last_activity_time: None,
        created_at: None,
        updated_at: None,
    })
}

/// Index of the hour bucket, creating it if missing.
fn ensure_hour(record: &mut ProductionRecord, hour: i64) -> usize {
    if let Some(idx) = record
        .hourly_data
        .iter()
        .position(|h| h.hour as i64 == hour)
    {
        return idx;
    }
    record.hourly_data.push(HourlyData {
        hour: hour as f64,
        units_produced: 0.0,
        defective_units: 0.0,
        status: "running".to_string(),
        operator_id: None,
        mold_id: None,
        stoppages: Vec::new(),
        running_minutes: 0.0,
        stoppage_minutes: 0.0,
    });
    record.hourly_data.len() - 1
}

/// Persist a record (insert or full replace), applying the same invariants as
/// the Mongoose pre-save hook (cap minutes at 60; recompute stoppage minutes).
pub(crate) async fn save(
    coll: &Collection<ProductionRecord>,
    record: &mut ProductionRecord,
) -> AppResult<()> {
    for h in record.hourly_data.iter_mut() {
        h.running_minutes = h.running_minutes.min(60.0);
        h.stoppage_minutes = h.stoppage_minutes.min(60.0);
        if !h.stoppages.is_empty() {
            let calc: f64 = h.stoppages.iter().map(|s| s.duration).sum();
            h.stoppage_minutes = calc.min(60.0);
        }
    }
    let now = Utc::now();
    record.updated_at = Some(now);
    match record.id {
        Some(id) => {
            coll.replace_one(doc! { "_id": id.oid() }, &*record).await?;
        }
        None => {
            record.created_at = Some(now);
            let res = coll.insert_one(&*record).await?;
            record.id = res.inserted_id.as_object_id().map(Id);
        }
    }
    Ok(())
}

async fn signal_timeouts(db: &Database) -> (chrono::Duration, chrono::Duration) {
    let cfg = db
        .collection::<Config>(CONFIGS)
        .find_one(doc! {})
        .await
        .ok()
        .flatten();
    let power_min = cfg
        .as_ref()
        .and_then(|c| c.signal_timeouts.as_ref())
        .and_then(|t| t.power_signal_timeout)
        .unwrap_or(5.0);
    let cycle_min = cfg
        .as_ref()
        .and_then(|c| c.signal_timeouts.as_ref())
        .and_then(|t| t.cycle_signal_timeout)
        .unwrap_or(2.0);
    (
        chrono::Duration::milliseconds((power_min * 60_000.0) as i64),
        chrono::Duration::milliseconds((cycle_min * 60_000.0) as i64),
    )
}

// ── Pipeline entry point ─────────────────────────────────────────────────────
/// Process one pin-data payload. Returns the machine ids that recorded a unit.
pub async fn process_pin_data(
    state: &AppState,
    pin_data: &str,
    timestamp: Option<&str>,
) -> AppResult<Vec<String>> {
    let byte_value = u8::from_str_radix(pin_data, 16)
        .map_err(|_| AppError::bad_request("pinData must be a hex byte string (e.g. \"0f\")"))?;
    let now = parse_timestamp(timestamp);

    // Idempotency: drop exact retries so unit cycles aren't double-counted.
    let dedup_key = format!("{}:{}", timestamp.unwrap_or(""), pin_data);
    if state.pipeline.is_duplicate(&dedup_key) {
        return Ok(Vec::new());
    }

    let pins = state.pipeline.pin_mappings(&state.db).await?;
    let timeouts = signal_timeouts(&state.db).await;

    let mut processed: HashSet<String> = HashSet::new();

    for pin_index in 0u8..8 {
        let pin_id = format!("DQ.{pin_index}");
        let pin_value = (byte_value >> pin_index) & 1;
        let info = match pins.get(&pin_id) {
            Some(i) => i,
            None => continue,
        };
        let machine = info.machine_id.to_hex();

        // Upsert the latest signal value (one per sensor).
        upsert_signal(
            &state.db,
            info.sensor_id,
            info.machine_id,
            pin_value as f64,
            now,
        )
        .await?;

        if info.sensor_type == "power" && pin_value == 1 {
            state.pipeline.last_power.insert(machine.clone(), now);
            realtime::broadcast(
                &state.io,
                "power-signal",
                &json!({ "machineId": machine, "value": pin_value, "timestamp": now }),
            )
            .await;
        }

        if info.sensor_type == "unit-cycle" && pin_value == 1 {
            update_production_record(state, info.machine_id, now).await?;
            processed.insert(machine.clone());
            state.pipeline.last_cycle.insert(machine.clone(), now);
            if state.pipeline.pending_stoppages.contains_key(&machine) {
                resolve_pending_stoppage(state, info.machine_id, now).await?;
                state.pipeline.pending_stoppages.remove(&machine);
            }
        }

        state.pipeline.last_activity.insert(machine.clone(), now);
    }

    let machine_ids: HashSet<Id> = pins.values().map(|p| p.machine_id).collect();
    update_machine_states(state, &machine_ids, now, timeouts).await?;

    Ok(processed.into_iter().collect())
}

async fn upsert_signal(
    db: &Database,
    sensor_id: Id,
    machine_id: Id,
    value: f64,
    t: DateTime<Utc>,
) -> AppResult<()> {
    db.collection::<Document>(SIGNAL_DATA)
        .update_one(
            doc! { "sensorId": sensor_id.oid() },
            doc! { "$set": {
                "machineId": machine_id.oid(),
                "value": value,
                "timestamp": bson::DateTime::from_chrono(t),
            }},
        )
        .upsert(true)
        .await?;
    Ok(())
}

async fn update_machine_states(
    state: &AppState,
    machine_ids: &HashSet<Id>,
    now: DateTime<Utc>,
    (power_to, cycle_to): (chrono::Duration, chrono::Duration),
) -> AppResult<()> {
    for &machine_id in machine_ids {
        let mid = machine_id.to_hex();
        let has_power = state
            .pipeline
            .last_power
            .get(&mid)
            .map(|v| *v.value() >= now - power_to)
            .unwrap_or(false);
        let has_cycle = state
            .pipeline
            .last_cycle
            .get(&mid)
            .map(|v| *v.value() >= now - cycle_to)
            .unwrap_or(false);

        let (status, color) = match (has_power, has_cycle) {
            (true, true) => ("running", "green"),
            (true, false) => ("stoppage", "red"),
            (false, true) => ("stopped_yet_producing", "orange"),
            (false, false) => ("inactive", "gray"),
        };

        if has_power && has_cycle {
            let cur_min = now.timestamp() / 60;
            let last_min = state
                .pipeline
                .running_minute
                .get(&mid)
                .map(|v| *v.value())
                .unwrap_or(0);
            if cur_min > last_min {
                state.pipeline.running_minute.insert(mid.clone(), cur_min);
                update_running_minutes(state, machine_id, now).await?;
            }
        } else if has_power && !has_cycle && !state.pipeline.pending_stoppages.contains_key(&mid) {
            create_pending_stoppage(state, machine_id, now).await?;
            state.pipeline.pending_stoppages.insert(mid.clone(), ());
        }

        if let Err(e) = state
            .db
            .collection::<Document>(MACHINES)
            .update_one(
                doc! { "_id": machine_id.oid() },
                doc! { "$set": { "status": status } },
            )
            .await
        {
            tracing::warn!("failed to update machine {mid} status: {e}");
        }

        realtime::broadcast(
            &state.io,
            "machine-state-update",
            &json!({
                "machineId": mid,
                "status": status,
                "color": color,
                "hasPower": has_power,
                "hasCycle": has_cycle,
                "dbStatus": status,
                "timestamp": now,
            }),
        )
        .await;
    }
    Ok(())
}

async fn update_running_minutes(
    state: &AppState,
    machine_id: Id,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let coll = records(&state.db);
    let mut rec = load_today(&state.db, machine_id, now).await?;
    let hour = now.hour() as i64;
    let idx = ensure_hour(&mut rec, hour);
    rec.hourly_data[idx].running_minutes = (rec.hourly_data[idx].running_minutes + 1.0).min(60.0);
    rec.hourly_data[idx].status = "running".to_string();
    save(&coll, &mut rec).await?;

    realtime::broadcast(
        &state.io,
        "running-time-update",
        &json!({
            "machineId": machine_id.to_hex(),
            "hour": hour,
            "date": date_str(now),
            "runningMinutes": rec.hourly_data[idx].running_minutes,
            "timestamp": now,
        }),
    )
    .await;
    Ok(())
}

async fn create_pending_stoppage(
    state: &AppState,
    machine_id: Id,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let coll = records(&state.db);
    let mut rec = load_today(&state.db, machine_id, now).await?;
    let hour = now.hour() as i64;
    let idx = ensure_hour(&mut rec, hour);

    let already = rec.hourly_data[idx]
        .stoppages
        .iter()
        .any(|s| s.reason == "unclassified" && s.is_pending);
    if already {
        return Ok(());
    }

    let stoppage_id = Id::new();
    rec.hourly_data[idx].stoppages.push(Stoppage {
        id: Some(stoppage_id),
        reason: "unclassified".to_string(),
        description: Some("Automatic stoppage detection - awaiting categorization".to_string()),
        sap_notification_number: None,
        start_time: Some(now),
        end_time: None,
        duration: 0.0,
        is_pending: true,
        is_classified: false,
    });
    rec.hourly_data[idx].status = "stoppage".to_string();
    save(&coll, &mut rec).await?;

    state.pipeline.unclassified.insert(
        machine_id.to_hex(),
        Unclassified {
            id: stoppage_id,
            start_time: now,
            hour,
            date: date_str(now),
        },
    );

    realtime::broadcast(
        &state.io,
        "unclassified-stoppage-detected",
        &json!({
            "machineId": machine_id.to_hex(),
            "hour": hour,
            "date": date_str(now),
            "stoppageStart": now,
            "pendingStoppageId": stoppage_id.to_hex(),
            "timestamp": now,
        }),
    )
    .await;
    Ok(())
}

async fn resolve_pending_stoppage(
    state: &AppState,
    machine_id: Id,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let coll = records(&state.db);
    let (start, end) = day_bounds(now);
    if let Some(mut rec) = coll
        .find_one(
            doc! { "machineId": machine_id.oid(), "startTime": { "$gte": start, "$lt": end } },
        )
        .await?
    {
        let hour = now.hour() as i64;
        if let Some(idx) = rec.hourly_data.iter().position(|h| h.hour as i64 == hour) {
            rec.hourly_data[idx]
                .stoppages
                .retain(|s| s.reason != "unclassified");
            rec.hourly_data[idx].status = "running".to_string();
            save(&coll, &mut rec).await?;
        }
    }
    state.pipeline.unclassified.remove(&machine_id.to_hex());

    realtime::broadcast(
        &state.io,
        "stoppage-resolved",
        &json!({ "machineId": machine_id.to_hex(), "timestamp": now }),
    )
    .await;
    Ok(())
}

async fn update_production_record(
    state: &AppState,
    machine_id: Id,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let coll = records(&state.db);
    let mut rec = load_today(&state.db, machine_id, now).await?;
    let hour = now.hour() as i64;
    let idx = ensure_hour(&mut rec, hour);

    rec.hourly_data[idx].units_produced += 1.0;
    rec.hourly_data[idx].status = "running".to_string();
    rec.units_produced = rec.hourly_data.iter().map(|h| h.units_produced).sum();
    rec.last_activity_time = Some(now);
    save(&coll, &mut rec).await?;

    let hd = &rec.hourly_data[idx];
    realtime::broadcast(
        &state.io,
        "production-update",
        &json!({
            "machineId": machine_id.to_hex(),
            "hour": hour,
            "date": date_str(now),
            "unitsProduced": hd.units_produced,
            "status": hd.status,
            "runningMinutes": hd.running_minutes,
            "stoppageMinutes": hd.stoppage_minutes,
            "timestamp": now,
        }),
    )
    .await;
    Ok(())
}

/// Tick ongoing unclassified-stoppage durations. Called every 60s by the monitor.
pub async fn update_ongoing_stoppages(state: &AppState, now: DateTime<Utc>) {
    let entries: Vec<(String, Unclassified)> = state
        .pipeline
        .unclassified
        .iter()
        .map(|e| (e.key().clone(), e.value().clone()))
        .collect();

    for (mid, info) in entries {
        let duration = ((now - info.start_time).num_seconds() / 60).max(0) as f64;
        let machine_oid = match ObjectId::parse_str(&mid) {
            Ok(o) => o,
            Err(_) => continue,
        };
        let (start, end) = day_bounds_from_str(&info.date);
        let coll = records(&state.db);
        let found = coll
            .find_one(doc! { "machineId": machine_oid, "startTime": { "$gte": start, "$lt": end } })
            .await;
        if let Ok(Some(mut rec)) = found {
            if let Some(idx) = rec
                .hourly_data
                .iter()
                .position(|h| h.hour as i64 == info.hour)
            {
                if let Some(sidx) = rec.hourly_data[idx]
                    .stoppages
                    .iter()
                    .position(|s| s.id == Some(info.id))
                {
                    rec.hourly_data[idx].stoppages[sidx].duration = duration.min(60.0);
                    if save(&coll, &mut rec).await.is_ok() {
                        realtime::broadcast(
                            &state.io,
                            "stoppage-updated",
                            &json!({
                                "machineId": mid,
                                "hour": info.hour,
                                "date": info.date,
                                "stoppageId": info.id.to_hex(),
                                "duration": duration,
                            }),
                        )
                        .await;
                    }
                }
            }
        }
    }
}
