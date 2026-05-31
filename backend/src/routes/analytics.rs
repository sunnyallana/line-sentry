//! Analytics routes (mirrors server/routes/analytics.js).
//!
//! OEE/MTTR/MTBF are computed in Rust from the production records (rather than
//! a Mongo aggregation) — same formulas, more maintainable. All time bucketing
//! is UTC, matching the Node server's `setUTCHours`/`toISOString` usage.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use bson::{doc, oid::ObjectId, Document};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use futures::TryStreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::pipeline;
use crate::routes::common::doc_to_json;
use crate::state::AppState;

// ── Time helpers (UTC) ───────────────────────────────────────────────────────
fn parse_date(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc())
        })
}

fn day_start(d: DateTime<Utc>) -> bson::DateTime {
    bson::DateTime::from_chrono(d.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc())
}
fn day_end(d: DateTime<Utc>) -> bson::DateTime {
    bson::DateTime::from_chrono(
        d.date_naive()
            .and_hms_milli_opt(23, 59, 59, 999)
            .unwrap()
            .and_utc(),
    )
}
fn fmt_date(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn get_date_range(tf: &str) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let now = Utc::now();
    match tf {
        "today" => Some((
            now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc(),
            now,
        )),
        "week" => {
            let wd = now.weekday().num_days_from_sunday() as i64;
            let s = (now.date_naive() - Duration::days(wd))
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc();
            Some((s, now))
        }
        "month" => {
            let s = now
                .date_naive()
                .with_day(1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc();
            Some((s, now))
        }
        "custom" => None,
        _ => Some((now - Duration::days(7), now)),
    }
}

// ── Metrics ──────────────────────────────────────────────────────────────────
#[derive(Serialize, Clone)]
pub struct MachineStats {
    #[serde(rename = "totalUnitsProduced")]
    total_units_produced: f64,
    #[serde(rename = "totalDefectiveUnits")]
    total_defective_units: f64,
    oee: i64,
    mtbf: i64,
    mttr: i64,
    availability: i64,
    quality: i64,
    performance: i64,
    #[serde(rename = "totalRunningMinutes")]
    total_running_minutes: f64,
    #[serde(rename = "totalStoppageMinutes")]
    total_stoppage_minutes: f64,
    #[serde(rename = "breakdownStoppages")]
    breakdown_stoppages: i64,
    #[serde(rename = "totalBreakdownMinutes")]
    total_breakdown_minutes: f64,
}

impl MachineStats {
    fn zero() -> Self {
        MachineStats {
            total_units_produced: 0.0,
            total_defective_units: 0.0,
            oee: 0,
            mtbf: 0,
            mttr: 0,
            availability: 0,
            quality: 0,
            performance: 0,
            total_running_minutes: 0.0,
            total_stoppage_minutes: 0.0,
            breakdown_stoppages: 0,
            total_breakdown_minutes: 0.0,
        }
    }
}

async fn calculate_machine_stats(
    db: &mongodb::Database,
    machine_id: ObjectId,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> AppResult<MachineStats> {
    let recs: Vec<ProductionRecord> = db
        .collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .find(doc! { "machineId": machine_id, "startTime": { "$gte": day_start(start), "$lte": day_end(end) } })
        .await?
        .try_collect()
        .await?;

    if recs.is_empty() {
        return Ok(MachineStats::zero());
    }

    // Mold capacities referenced by the hourly data.
    let mold_ids: Vec<ObjectId> = recs
        .iter()
        .flat_map(|r| {
            r.hourly_data
                .iter()
                .filter_map(|h| h.mold_id.map(|m| m.oid()))
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut capacity: HashMap<ObjectId, f64> = HashMap::new();
    if !mold_ids.is_empty() {
        let molds: Vec<Mold> = db
            .collection::<Mold>(MOLDS)
            .find(doc! { "_id": { "$in": mold_ids } })
            .await?
            .try_collect()
            .await?;
        for m in molds {
            if let Some(id) = m.id {
                capacity.insert(id.oid(), m.production_capacity_per_hour);
            }
        }
    }

    let (mut units, mut defective, mut running, mut stoppage_min, mut expected) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut total_stoppages, mut breakdown_count, mut breakdown_min) = (0i64, 0i64, 0.0);
    for r in &recs {
        for h in &r.hourly_data {
            units += h.units_produced;
            defective += h.defective_units;
            running += h.running_minutes;
            stoppage_min += h.stoppage_minutes;
            total_stoppages += h.stoppages.len() as i64;
            for s in &h.stoppages {
                if s.reason == "breakdown" {
                    breakdown_count += 1;
                    breakdown_min += s.duration;
                }
            }
            if let Some(mid) = h.mold_id {
                if let Some(cap) = capacity.get(&mid.oid()) {
                    if *cap > 0.0 {
                        expected += (cap / 60.0) * h.running_minutes;
                    }
                }
            }
        }
    }
    let _ = total_stoppages;

    let available = running + stoppage_min;
    let availability = if available > 0.0 {
        running / available
    } else {
        0.0
    };
    let quality = if units > 0.0 {
        (units - defective) / units
    } else {
        0.0
    };
    let performance = if expected > 0.0 {
        units / expected
    } else {
        0.0
    };
    let oee = availability * quality * performance;
    let mtbf = if breakdown_count > 0 {
        running / breakdown_count as f64
    } else {
        0.0
    };
    let mttr = if breakdown_count > 0 {
        breakdown_min / breakdown_count as f64
    } else {
        0.0
    };

    Ok(MachineStats {
        total_units_produced: units,
        total_defective_units: defective,
        oee: (oee * 100.0).round() as i64,
        mtbf: mtbf.round() as i64,
        mttr: mttr.round() as i64,
        availability: (availability * 100.0).round() as i64,
        quality: (quality * 100.0).round() as i64,
        performance: (performance * 100.0).round() as i64,
        total_running_minutes: running,
        total_stoppage_minutes: stoppage_min,
        breakdown_stoppages: breakdown_count,
        total_breakdown_minutes: breakdown_min,
    })
}

async fn assert_machine_access(
    state: &AppState,
    user: &User,
    machine_id: ObjectId,
) -> AppResult<Machine> {
    let machine = state
        .db
        .collection::<Machine>(MACHINES)
        .find_one(doc! { "_id": machine_id })
        .await?
        .ok_or(AppError::NotFound)?;
    if user.role == "operator" && user.department_id != Some(machine.department_id) {
        return Err(AppError::Forbidden);
    }
    Ok(machine)
}

// ── Routes ───────────────────────────────────────────────────────────────────
pub async fn machine_stats(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(machine_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let oid = ObjectId::parse_str(&machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?;
    let (start, end) = match (q.get("startDate"), q.get("endDate")) {
        (Some(s), Some(e)) => (
            parse_date(s).ok_or_else(|| AppError::bad_request("invalid startDate"))?,
            parse_date(e).ok_or_else(|| AppError::bad_request("invalid endDate"))?,
        ),
        _ => {
            return Err(AppError::bad_request(
                "Both startDate and endDate are required",
            ))
        }
    };
    let machine = assert_machine_access(&state, &user, oid).await?;
    let stats = calculate_machine_stats(&state.db, oid, start, end).await?;
    let mut v = serde_json::to_value(&stats).unwrap();
    if let Value::Object(ref mut m) = v {
        m.insert("currentStatus".into(), json!(machine.status));
    }
    Ok(Json(v))
}

pub async fn department_stats(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(department_id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = ObjectId::parse_str(&department_id)
        .map_err(|_| AppError::bad_request("invalid department id"))?;
    if user.role == "operator" && user.department_id.map(|d| d.oid()) != Some(oid) {
        return Err(AppError::Forbidden);
    }
    let end = Utc::now();
    let start = end - Duration::days(1);
    let machines: Vec<Machine> = state
        .db
        .collection::<Machine>(MACHINES)
        .find(doc! { "departmentId": oid, "isActive": true })
        .await?
        .try_collect()
        .await?;

    let mut oees = Vec::new();
    for m in &machines {
        if let Some(id) = m.id {
            if let Ok(s) = calculate_machine_stats(&state.db, id.oid(), start, end).await {
                if s.oee > 0 {
                    oees.push(s.oee);
                }
            }
        }
    }
    let avg = if oees.is_empty() {
        0
    } else {
        (oees.iter().sum::<i64>() as f64 / oees.len() as f64).round() as i64
    };
    Ok(Json(json!({ "avgOEE": avg })))
}

pub async fn factory_stats(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let end = Utc::now();
    let start = end - Duration::days(1);
    let machines: Vec<Machine> = state
        .db
        .collection::<Machine>(MACHINES)
        .find(doc! { "isActive": true })
        .await?
        .try_collect()
        .await?;

    let (mut total_units, mut total_oee, mut valid_oees, mut active) = (0.0, 0i64, 0i64, 0i64);
    for m in &machines {
        if m.status == "running" {
            active += 1;
        }
        if let Some(id) = m.id {
            if let Ok(s) = calculate_machine_stats(&state.db, id.oid(), start, end).await {
                total_units += s.total_units_produced;
                if s.oee > 0 {
                    total_oee += s.oee;
                    valid_oees += 1;
                }
            }
        }
    }

    // Unclassified stoppage count.
    let unclassified = state
        .db
        .collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .find(doc! { "hourlyData.stoppages.reason": "unclassified" })
        .await?
        .try_collect::<Vec<ProductionRecord>>()
        .await?
        .iter()
        .flat_map(|r| r.hourly_data.iter())
        .flat_map(|h| h.stoppages.iter())
        .filter(|s| s.reason == "unclassified")
        .count() as i64;

    Ok(Json(json!({
        "totalUnits": total_units,
        "avgOEE": if valid_oees > 0 { (total_oee as f64 / valid_oees as f64).round() as i64 } else { 0 },
        "unclassifiedStoppages": unclassified,
        "activeMachines": active,
    })))
}

pub async fn production_timeline(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(machine_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let oid = ObjectId::parse_str(&machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?;
    let timeframe = q.get("timeframe").cloned().unwrap_or_default();

    let (start, end) = if timeframe == "custom" {
        match (q.get("startDate"), q.get("endDate")) {
            (Some(s), Some(e)) => (
                parse_date(s).ok_or_else(|| AppError::bad_request("Invalid start date"))?,
                parse_date(e).ok_or_else(|| AppError::bad_request("Invalid end date"))?,
            ),
            _ => return Err(AppError::bad_request("Invalid timeframe or missing dates")),
        }
    } else {
        get_date_range(&timeframe)
            .ok_or_else(|| AppError::bad_request("Invalid timeframe or missing dates"))?
    };
    if start > end {
        return Err(AppError::bad_request("Start date must be before end date"));
    }
    assert_machine_access(&state, &user, oid).await?;

    let recs: Vec<ProductionRecord> = state
        .db
        .collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .find(doc! { "machineId": oid, "startTime": { "$gte": bson::DateTime::from_chrono(start), "$lte": bson::DateTime::from_chrono(end) } })
        .await?
        .try_collect()
        .await?;

    // Collect referenced operator + mold ids (record- and hour-level).
    let mut op_ids: HashSet<ObjectId> = HashSet::new();
    let mut mold_ids: HashSet<ObjectId> = HashSet::new();
    for r in &recs {
        if let Some(o) = r.operator_id {
            op_ids.insert(o.oid());
        }
        if let Some(m) = r.mold_id {
            mold_ids.insert(m.oid());
        }
        for h in &r.hourly_data {
            if let Some(o) = h.operator_id {
                op_ids.insert(o.oid());
            }
            if let Some(m) = h.mold_id {
                mold_ids.insert(m.oid());
            }
        }
    }
    let operators = load_doc_map(&state.db, USERS, &op_ids, true).await?;
    let molds = load_doc_map(&state.db, MOLDS, &mold_ids, false).await?;

    // Build timeline for each day in [start, end].
    let mut timeline = Vec::new();
    let mut day = start.date_naive();
    let last = end.date_naive();
    while day <= last {
        let date_str = day.format("%Y-%m-%d").to_string();
        let rec = recs.iter().find(|r| fmt_date(r.start_time) == date_str);
        let mut hours = Vec::with_capacity(24);
        for hour in 0..24i64 {
            let hd = rec.and_then(|r| r.hourly_data.iter().find(|h| h.hour as i64 == hour));
            let running = hd.map(|h| h.running_minutes).unwrap_or(0.0);
            let stoppage_min: f64 = hd
                .map(|h| h.stoppages.iter().map(|s| s.duration).sum())
                .unwrap_or(0.0);
            let computed = if running > 0.0 {
                if stoppage_min > running {
                    "stoppage"
                } else {
                    "running"
                }
            } else if stoppage_min > 0.0 {
                "stoppage"
            } else {
                "inactive"
            };
            let status = hd
                .map(|h| {
                    if h.status.is_empty() {
                        computed.to_string()
                    } else {
                        h.status.clone()
                    }
                })
                .unwrap_or_else(|| computed.to_string());

            let op_id = hd
                .and_then(|h| h.operator_id)
                .or_else(|| rec.and_then(|r| r.operator_id));
            let mold_id = hd
                .and_then(|h| h.mold_id)
                .or_else(|| rec.and_then(|r| r.mold_id));
            let operator = op_id
                .and_then(|i| operators.get(&i.to_hex()).cloned())
                .unwrap_or(Value::Null);
            let mold = mold_id
                .and_then(|i| molds.get(&i.to_hex()).cloned())
                .unwrap_or(Value::Null);
            let stoppages = hd
                .map(|h| serde_json::to_value(&h.stoppages).unwrap_or(Value::Array(vec![])))
                .unwrap_or(Value::Array(vec![]));

            hours.push(json!({
                "hour": hour,
                "unitsProduced": hd.map(|h| h.units_produced).unwrap_or(0.0),
                "defectiveUnits": hd.map(|h| h.defective_units).unwrap_or(0.0),
                "status": status,
                "operator": operator,
                "mold": mold,
                "stoppages": stoppages,
                "runningMinutes": running,
                "stoppageMinutes": stoppage_min,
            }));
        }
        timeline.push(json!({ "date": date_str, "hours": hours }));
        day += Duration::days(1);
    }

    Ok(Json(json!({
        "timeline": timeline,
        "timeframe": timeframe,
        "startDate": fmt_date(start),
        "endDate": fmt_date(end),
    })))
}

/// Load `_id`→clean-JSON map for the given ids (password stripped for users).
async fn load_doc_map(
    db: &mongodb::Database,
    collection: &str,
    ids: &HashSet<ObjectId>,
    strip_password: bool,
) -> AppResult<HashMap<String, Value>> {
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let id_vec: Vec<ObjectId> = ids.iter().copied().collect();
    let coll = db.collection::<Document>(collection);
    let mut find = coll.find(doc! { "_id": { "$in": id_vec } });
    if strip_password {
        find = find.projection(doc! { "password": 0 });
    }
    let docs: Vec<Document> = find.await?.try_collect().await?;
    for d in docs {
        if let Ok(id) = d.get_object_id("_id") {
            map.insert(id.to_hex(), doc_to_json(d));
        }
    }
    Ok(map)
}

// ── Writes ───────────────────────────────────────────────────────────────────
fn day_bounds_str(date: &str) -> (bson::DateTime, bson::DateTime) {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap_or_else(|_| Utc::now().date_naive());
    (
        bson::DateTime::from_chrono(d.and_hms_opt(0, 0, 0).unwrap().and_utc()),
        bson::DateTime::from_chrono(d.and_hms_milli_opt(23, 59, 59, 999).unwrap().and_utc()),
    )
}

async fn load_or_new(
    db: &mongodb::Database,
    machine_id: ObjectId,
    date: &str,
) -> AppResult<ProductionRecord> {
    let (start, end) = day_bounds_str(date);
    if let Some(r) = db
        .collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .find_one(doc! { "machineId": machine_id, "startTime": { "$gte": start, "$lt": end } })
        .await?
    {
        return Ok(r);
    }
    Ok(ProductionRecord {
        id: None,
        machine_id: Id(machine_id),
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

fn ensure_hour(rec: &mut ProductionRecord, hour: i64, default_status: &str) -> usize {
    if let Some(i) = rec.hourly_data.iter().position(|h| h.hour as i64 == hour) {
        return i;
    }
    rec.hourly_data.push(HourlyData {
        hour: hour as f64,
        units_produced: 0.0,
        defective_units: 0.0,
        status: default_status.to_string(),
        operator_id: None,
        mold_id: None,
        stoppages: Vec::new(),
        running_minutes: 0.0,
        stoppage_minutes: 0.0,
    });
    rec.hourly_data.len() - 1
}

#[derive(serde::Deserialize)]
pub struct StoppageReq {
    #[serde(rename = "machineId")]
    machine_id: String,
    hour: i64,
    date: String,
    reason: String,
    description: Option<String>,
    duration: Option<f64>,
    #[serde(rename = "pendingStoppageId")]
    pending_stoppage_id: Option<String>,
    #[serde(rename = "sapNotificationNumber")]
    sap_notification_number: Option<String>,
}

pub async fn add_stoppage(
    _user: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<StoppageReq>,
) -> AppResult<(StatusCode, Json<Value>)> {
    if b.reason == "breakdown" {
        let sap = b
            .sap_notification_number
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        if sap.is_empty() {
            return Err(AppError::bad_request("SAP number required"));
        }
        if !sap.chars().all(|c| c.is_ascii_digit()) {
            return Err(AppError::bad_request("Invalid SAP number format"));
        }
    }
    let machine_oid = ObjectId::parse_str(&b.machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?;
    let coll = state.db.collection::<ProductionRecord>(PRODUCTION_RECORDS);
    let mut rec = load_or_new(&state.db, machine_oid, &b.date).await?;
    let idx = ensure_hour(&mut rec, b.hour, "stoppage");

    if let Some(pending_id) = b.pending_stoppage_id.as_deref().filter(|s| !s.is_empty()) {
        let pos = rec.hourly_data[idx].stoppages.iter().position(|s| {
            s.id.map(|i| i.to_hex()).as_deref() == Some(pending_id) || s.reason == "unclassified"
        });
        match pos {
            Some(p) => {
                let now = Utc::now();
                let start = rec.hourly_data[idx].stoppages[p].start_time.unwrap_or(now);
                let actual = ((now - start).num_seconds() / 60).max(0) as f64;
                let s = &mut rec.hourly_data[idx].stoppages[p];
                s.reason = b.reason.clone();
                s.description = b.description.clone();
                s.end_time = Some(now);
                s.duration = actual;
                s.sap_notification_number = if b.reason == "breakdown" {
                    b.sap_notification_number.clone()
                } else {
                    None
                };
                s.is_pending = false;
                s.is_classified = true;
            }
            None => return Err(AppError::NotFound),
        }
    } else {
        let dur = b.duration.unwrap_or(0.0);
        let start = Utc
            .with_ymd_and_hms(
                NaiveDate::parse_from_str(&b.date, "%Y-%m-%d")
                    .map(|d| d.year())
                    .unwrap_or(1970),
                NaiveDate::parse_from_str(&b.date, "%Y-%m-%d")
                    .map(|d| d.month())
                    .unwrap_or(1),
                NaiveDate::parse_from_str(&b.date, "%Y-%m-%d")
                    .map(|d| d.day())
                    .unwrap_or(1),
                b.hour.clamp(0, 23) as u32,
                0,
                0,
            )
            .single()
            .unwrap_or_else(Utc::now);
        rec.hourly_data[idx].stoppages.push(Stoppage {
            id: Some(Id::new()),
            reason: b.reason.clone(),
            description: b.description.clone(),
            sap_notification_number: if b.reason == "breakdown" {
                b.sap_notification_number.clone()
            } else {
                None
            },
            start_time: Some(start),
            end_time: Some(start + Duration::minutes(dur as i64)),
            duration: dur,
            is_pending: false,
            is_classified: true,
        });
    }

    let total: f64 = rec.hourly_data[idx]
        .stoppages
        .iter()
        .map(|s| s.duration)
        .sum();
    rec.hourly_data[idx].stoppage_minutes = total;
    rec.hourly_data[idx].status = "stoppage".to_string();
    pipeline::save(&coll, &mut rec).await?;

    crate::realtime::broadcast(
        &state.io,
        "stoppage-added",
        &json!({
            "machineId": b.machine_id, "hour": b.hour, "date": b.date,
            "stoppage": { "reason": b.reason, "description": b.description, "duration": b.duration, "sapNotificationNumber": b.sap_notification_number },
            "timestamp": Utc::now(),
        }),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "message": "Stoppage recorded" })),
    ))
}

#[derive(serde::Deserialize)]
pub struct AssignmentReq {
    #[serde(rename = "machineId")]
    machine_id: String,
    hour: i64,
    date: String,
    #[serde(rename = "operatorId")]
    operator_id: Option<String>,
    #[serde(rename = "moldId")]
    mold_id: Option<String>,
    #[serde(rename = "defectiveUnits")]
    defective_units: Option<f64>,
    #[serde(rename = "applyToShift")]
    apply_to_shift: Option<bool>,
}

pub async fn production_assignment(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(b): Json<AssignmentReq>,
) -> AppResult<Json<Value>> {
    let machine_oid = ObjectId::parse_str(&b.machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?;

    // Resolve operator (ObjectId or username lookup).
    let mut operator: Option<ObjectId> = None;
    if let Some(op) = b.operator_id.as_deref().filter(|s| !s.trim().is_empty()) {
        if let Ok(oid) = ObjectId::parse_str(op) {
            operator = Some(oid);
        } else if let Some(u) = state
            .db
            .collection::<User>(USERS)
            .find_one(doc! { "username": op })
            .await?
        {
            operator = u.id.map(|i| i.oid());
        } else {
            return Err(AppError::bad_request("Invalid operator specified"));
        }
    }
    let mut mold: Option<ObjectId> = None;
    if let Some(m) = b.mold_id.as_deref().filter(|s| !s.trim().is_empty()) {
        mold = Some(
            ObjectId::parse_str(m)
                .map_err(|_| AppError::bad_request("Invalid mold ID specified"))?,
        );
    }

    // Operators may only assign themselves.
    if user.role == "operator" {
        if let Some(op) = operator {
            if user.id.map(|i| i.oid()) != Some(op) {
                return Err(AppError::Forbidden);
            }
        }
    }

    let coll = state.db.collection::<ProductionRecord>(PRODUCTION_RECORDS);
    let mut rec = load_or_new(&state.db, machine_oid, &b.date).await?;

    // Determine target hours (optionally the whole shift).
    let mut hours = vec![b.hour];
    if b.apply_to_shift.unwrap_or(false) {
        if let Some(shift_hours) = shift_for_hour(&state.db, b.hour).await? {
            hours = shift_hours;
        }
    }

    for &th in &hours {
        let idx = ensure_hour(&mut rec, th, "inactive");
        rec.hourly_data[idx].operator_id = operator.map(Id);
        rec.hourly_data[idx].mold_id = mold.map(Id);
        if th == b.hour {
            if let Some(d) = b.defective_units {
                rec.hourly_data[idx].defective_units = d;
            }
        }
    }

    rec.units_produced = rec.hourly_data.iter().map(|h| h.units_produced).sum();
    rec.defective_units = rec.hourly_data.iter().map(|h| h.defective_units).sum();
    pipeline::save(&coll, &mut rec).await?;

    crate::realtime::broadcast(
        &state.io,
        "production-assignment-updated",
        &json!({
            "machineId": b.machine_id, "hours": hours, "date": b.date,
            "operatorId": operator.map(|o| o.to_hex()), "moldId": mold.map(|m| m.to_hex()),
            "originalHour": b.hour, "defectiveUnits": b.defective_units, "timestamp": Utc::now(),
        }),
    )
    .await;

    Ok(Json(
        json!({ "message": "Production assignment updated successfully" }),
    ))
}

/// Hours covered by the shift containing `hour` (handles night shifts).
async fn shift_for_hour(db: &mongodb::Database, hour: i64) -> AppResult<Option<Vec<i64>>> {
    let cfg = db.collection::<Document>(CONFIGS).find_one(doc! {}).await?;
    let shifts = cfg
        .and_then(|c| c.get_array("shifts").ok().cloned())
        .unwrap_or_default();
    for s in shifts {
        if let bson::Bson::Document(sd) = s {
            let parse_h = |k: &str| {
                sd.get_str(k)
                    .ok()
                    .and_then(|v| v.split(':').next())
                    .and_then(|h| h.parse::<i64>().ok())
            };
            if let (Some(sh), Some(eh)) = (parse_h("startTime"), parse_h("endTime")) {
                let contains = if sh <= eh {
                    hour >= sh && hour < eh
                } else {
                    hour >= sh || hour < eh
                };
                if contains {
                    let mut out = Vec::new();
                    if sh <= eh {
                        out.extend(sh..eh);
                    } else if hour >= sh {
                        out.extend(sh..24);
                    } else {
                        out.extend(0..eh);
                    }
                    return Ok(Some(out));
                }
            }
        }
    }
    Ok(None)
}
