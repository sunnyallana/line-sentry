//! Analytics routes (mirrors server/routes/analytics.js).
//!
//! The figures come from `routes::metrics`, folded in memory from one read of
//! the production records. All time bucketing is UTC, matching the Node
//! server's `setUTCHours`/`toISOString` usage.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use bson::oid::ObjectId;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use futures::future::{try_join, try_join_all};
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::configs::{reason_kinds, KIND_BREAKDOWN};
use crate::persist::records::StoppageNote;
use crate::persist::{Entity, Filter, Persister};
use crate::routes::common::{doc_to_json, mold_rate, molds_used};
use crate::routes::metrics::{percent, Totals};
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

fn fmt_date(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn get_date_range(tf: &str, now: DateTime<Utc>) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
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

impl From<&Totals> for MachineStats {
    /// These endpoints report 0 where there is no performance or OEE figure.
    fn from(t: &Totals) -> Self {
        MachineStats {
            total_units_produced: t.units,
            total_defective_units: t.defective,
            oee: t.oee().map(percent).unwrap_or(0),
            mtbf: t.mtbf_minutes().round() as i64,
            mttr: t.mttr_minutes().round() as i64,
            availability: percent(t.availability()),
            quality: percent(t.quality()),
            performance: t.performance().map(percent).unwrap_or(0),
            total_running_minutes: t.running_minutes,
            total_stoppage_minutes: t.stopped_minutes,
            breakdown_stoppages: t.breakdowns,
            total_breakdown_minutes: t.breakdown_minutes,
        }
    }
}

/// The totals of each machine between two factory days, inclusive, however
/// many machines there are: one read of their records, one of the stoppage
/// reasons, one of the molds involved. A machine with no record is absent.
async fn totals_by_machine(
    state: &AppState,
    machines: &[ObjectId],
    from: NaiveDate,
    to: NaiveDate,
) -> AppResult<HashMap<ObjectId, Totals>> {
    let (records, reasons) = try_join(
        state.store.records.between(machines, from, to),
        state.store.configs.stoppage_reasons(),
    )
    .await?;
    let molds = molds_used(&state.store, &records).await?;
    let kinds = reason_kinds(&reasons);

    let mut totals: HashMap<ObjectId, Totals> = HashMap::new();
    for r in &records {
        let machine = totals.entry(r.machine_id.oid()).or_default();
        for h in &r.hourly_data {
            machine.add_hour(h, mold_rate(&molds, h), &kinds);
        }
    }
    Ok(totals)
}

/// Rounded mean of the machines' OEE, leaving out machines without one.
fn average_oee(oees: impl Iterator<Item = i64>) -> i64 {
    let known: Vec<i64> = oees.filter(|oee| *oee > 0).collect();
    if known.is_empty() {
        0
    } else {
        (known.iter().sum::<i64>() as f64 / known.len() as f64).round() as i64
    }
}

async fn assert_machine_access(
    state: &AppState,
    user: &User,
    machine_id: ObjectId,
) -> AppResult<Machine> {
    let machine = state
        .store
        .machines
        .rows
        .get(machine_id)
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
    let totals = totals_by_machine(&state, &[oid], start.date_naive(), end.date_naive()).await?;
    let stats = MachineStats::from(totals.get(&oid).unwrap_or(&Totals::default()));
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
    let machines = state.store.machines.active(Some(oid), None).await?;
    let ids: Vec<ObjectId> = machines
        .iter()
        .filter_map(|m| m.id.map(|i| i.oid()))
        .collect();
    let totals = totals_by_machine(&state, &ids, start.date_naive(), end.date_naive()).await?;

    let avg = average_oee(totals.values().map(|t| MachineStats::from(t).oee));
    Ok(Json(json!({ "avgOEE": avg })))
}

pub async fn factory_stats(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let end = Utc::now();
    let start = end - Duration::days(1);
    let machines = state.store.machines.active(None, None).await?;
    let ids: Vec<ObjectId> = machines
        .iter()
        .filter_map(|m| m.id.map(|i| i.oid()))
        .collect();
    let (totals, unclassified) = try_join(
        totals_by_machine(&state, &ids, start.date_naive(), end.date_naive()),
        async { Ok(state.store.records.unclassified_stoppages().await?) },
    )
    .await?;

    let active = machines.iter().filter(|m| m.status == "running").count();
    let total_units: f64 = totals.values().map(|t| t.units).sum();
    let avg = average_oee(totals.values().map(|t| MachineStats::from(t).oee));

    Ok(Json(json!({
        "totalUnits": total_units,
        "avgOEE": avg,
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
        get_date_range(&timeframe, state.config.factory_now())
            .ok_or_else(|| AppError::bad_request("Invalid timeframe or missing dates"))?
    };
    if start > end {
        return Err(AppError::bad_request("Start date must be before end date"));
    }
    assert_machine_access(&state, &user, oid).await?;

    // Whole days, so a `YYYY-MM-DD` end date includes the full end day.
    let recs = state
        .store
        .records
        .between(&[oid], start.date_naive(), end.date_naive())
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
    let (operators, molds) = try_join(
        json_by_id(&state.store.users.rows, op_ids, USER_FIELDS),
        json_by_id(&state.store.molds.rows, mold_ids, MOLD_FIELDS),
    )
    .await?;

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

/// What the timeline shows of an operator: everything stored except the
/// password hash. `__v` is on rows written by the old server.
const USER_FIELDS: &[&str] = &[
    "username",
    "email",
    "role",
    "departmentId",
    "isActive",
    "createdAt",
    "updatedAt",
    "__v",
];
/// Every stored field of a mold, as stored: reading it into `Mold` would turn
/// whole-number rates written by the old server into `120.0`.
const MOLD_FIELDS: &[&str] = &[
    "name",
    "description",
    "productionCapacityPerHour",
    "departmentId",
    "isActive",
    "createdAt",
    "updatedAt",
    "__v",
];

/// The named fields of the rows with the given ids as clean JSON, by hex id.
async fn json_by_id<T: Entity>(
    rows: &Persister<T>,
    ids: HashSet<ObjectId>,
    fields: &[&str],
) -> AppResult<HashMap<String, Value>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let found = rows
        .select(Filter::all().any_of("_id", ids), fields)
        .await?;
    Ok(found
        .into_iter()
        .filter_map(|d| Some((d.get_object_id("_id").ok()?.to_hex(), doc_to_json(d))))
        .collect())
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// The factory day a write names. An unreadable date means today, as it
/// always has.
fn day_of(date: &str) -> NaiveDate {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap_or_else(|_| Utc::now().date_naive())
}

/// The start of an hour of a factory day, as stored. `None` for an hour that
/// is not on the clock.
fn hour_start(day: NaiveDate, hour: i64) -> Option<DateTime<Utc>> {
    let hour = u32::try_from(hour).ok()?;
    Some(day.and_hms_opt(hour, 0, 0)?.and_utc())
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
    let reasons = state.store.configs.stoppage_reasons().await?;
    let reason = reasons
        .iter()
        .find(|r| r.key == b.reason)
        .ok_or_else(|| AppError::bad_request("Unknown stoppage reason"))?;
    let is_breakdown = reason.kind == KIND_BREAKDOWN;
    if is_breakdown {
        let sap = b.sap_notification_number.as_deref().unwrap_or("").trim();
        if sap.is_empty() {
            return Err(AppError::bad_request("SAP number required"));
        }
        if !sap.chars().all(|c| c.is_ascii_digit()) {
            return Err(AppError::bad_request("Invalid SAP number format"));
        }
    }
    let machine = Id(ObjectId::parse_str(&b.machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?);
    let hour =
        hour_start(day_of(&b.date), b.hour).ok_or_else(|| AppError::bad_request("Invalid hour"))?;

    let note = StoppageNote {
        reason: &b.reason,
        description: b.description.as_deref(),
        sap_number: b
            .sap_notification_number
            .as_deref()
            .filter(|_| is_breakdown),
    };
    let records = &state.store.records;
    if let Some(pending_id) = b.pending_stoppage_id.as_deref().filter(|s| !s.is_empty()) {
        let wanted = ObjectId::parse_str(pending_id).ok();
        // Stoppage times are factory-local, so "now" has to be too.
        let now = state.config.factory_now();
        if !records
            .classify_stoppage(machine, hour, wanted, &note, now)
            .await?
        {
            return Err(AppError::NotFound);
        }
    } else {
        records
            .add_stoppage(machine, hour, b.duration.unwrap_or(0.0), &note)
            .await?;
    }

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
    let machine = Id(ObjectId::parse_str(&b.machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?);

    // Resolve operator (ObjectId or username lookup).
    let mut operator: Option<ObjectId> = None;
    if let Some(op) = b.operator_id.as_deref().filter(|s| !s.trim().is_empty()) {
        if let Ok(oid) = ObjectId::parse_str(op) {
            operator = Some(oid);
        } else if let Some(u) = state
            .store
            .users
            .rows
            .find_one(Filter::all().eq("username", op))
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

    let day = day_of(&b.date);
    let edited_hour =
        hour_start(day, b.hour).ok_or_else(|| AppError::bad_request("Invalid hour"))?;

    // Determine target hours (optionally the whole shift).
    let mut hours = vec![b.hour];
    if b.apply_to_shift.unwrap_or(false) {
        if let Some(shift_hours) = shift_for_hour(&state, b.hour).await? {
            hours = shift_hours;
        }
    }

    // One statement per hour, sent together. Each touches only its hour's
    // operator and mold, so units counted meanwhile are not written over.
    let records = &state.store.records;
    let slots: Vec<DateTime<Utc>> = hours.iter().filter_map(|h| hour_start(day, *h)).collect();
    let mut batch = state.store.batch();
    let queued: Vec<usize> = slots
        .iter()
        .map(|t| records.queue_assignment(&mut batch, machine, *t, operator, mold))
        .collect();
    let written = batch.send().await?;
    let without_bucket: Vec<DateTime<Utc>> = slots
        .iter()
        .zip(&queued)
        .filter(|(_, i)| written[**i].matched == 0)
        .map(|(t, _)| *t)
        .collect();
    if !without_bucket.is_empty() {
        try_join_all(
            without_bucket
                .iter()
                .map(|t| records.ensure_hour_as(machine, *t, "inactive")),
        )
        .await?;
        let mut retry = state.store.batch();
        for t in &without_bucket {
            records.queue_assignment(&mut retry, machine, *t, operator, mold);
        }
        retry.send().await?;
    }
    if let Some(defective) = b.defective_units {
        records
            .set_defective(machine, edited_hour, defective)
            .await?;
    }

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
async fn shift_for_hour(state: &AppState, hour: i64) -> AppResult<Option<Vec<i64>>> {
    let shifts = state.store.configs.shifts().await?;
    Ok(shifts.iter().find(|s| s.contains(hour)).map(|s| {
        if s.start_hour <= s.end_hour {
            (s.start_hour..s.end_hour).collect()
        } else if hour >= s.start_hour {
            (s.start_hour..24).collect()
        } else {
            (0..s.end_hour).collect()
        }
    }))
}
