//! Machine routes (mirrors server/routes/machines.js).

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use bson::oid::ObjectId;
use chrono::Utc;
use futures::future::{try_join, try_join3, try_join5};
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::machines::active_department_names;
use crate::persist::{records, sensors, Filter};
use crate::routes::common::*;
use crate::state::AppState;

/// Active machines in a department (operator-scoped), department populated.
pub async fn by_department(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(department_id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&department_id)?;
    if user.role == "operator" && user.department_id.map(|d| d.oid()) != Some(oid) {
        return Err(AppError::Forbidden);
    }
    let docs = state
        .store
        .machines
        .active_with_department(Some(oid))
        .await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn get_one(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let machines = &state.store.machines;
    let (machine, populated) =
        try_join(machines.rows.get(oid), machines.one_with_department(oid)).await?;
    let machine = machine.ok_or(AppError::NotFound)?;
    if user.role == "operator" && user.department_id != Some(machine.department_id) {
        return Err(AppError::Forbidden);
    }
    Ok(Json(doc_to_json(populated.ok_or(AppError::NotFound)?)))
}

/// All active machines (admin), department populated.
pub async fn list(_admin: AdminUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let docs = state.store.machines.active_with_department(None).await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<Machine>,
) -> AppResult<(StatusCode, Json<Machine>)> {
    body.id = None;
    if body.position.is_none() {
        body.position = Some(Position { x: 0.0, y: 0.0 });
    }
    if body.dimensions.is_none() {
        body.dimensions = Some(Dimensions {
            width: 200.0,
            height: 200.0,
        });
    }
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);
    body.id = Some(Id(state.store.machines.rows.insert(&body).await?));
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Machine>,
) -> AppResult<Json<Machine>> {
    let oid = parse_oid(&id)?;
    let machines = &state.store.machines;
    let existing = machines.rows.get(oid).await?.ok_or(AppError::NotFound)?;
    machines.edit(oid, &body).await?;

    // Hand back what is stored, with the state fields the client did not send.
    body.id = Some(Id(oid));
    body.status = existing.status;
    body.status_since = existing.status_since;
    body.created_at = existing.created_at;
    body.updated_at = Some(Utc::now());
    Ok(Json(body))
}

#[derive(serde::Deserialize)]
pub struct PositionReq {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Drag-and-drop position/size update.
pub async fn position(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(p): Json<PositionReq>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let updated = state
        .store
        .machines
        .place(oid, (p.x, p.y), (p.width, p.height))
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(doc_to_json(updated)))
}

/// Delete a machine and cascade to its sensors, production records, and signals.
pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let store = &state.store;
    if !store.machines.rows.exists(Filter::id(oid)).await? {
        return Err(AppError::NotFound);
    }
    // The sensors' pins are freed first: a mapping left behind would keep its
    // pin "in use" and its PLC undeletable.
    let sensor_ids = store
        .sensors
        .rows
        .ids(Filter::all().eq(sensors::f::MACHINE, oid))
        .await?;
    store.pins.of_machine_sensors_delete(&sensor_ids).await?;
    // The machine goes last, so a cascade that failed part-way can be retried.
    try_join3(
        store.sensors.delete_on(oid),
        store
            .records
            .rows
            .delete_all(Filter::all().eq(records::f::MACHINE, oid)),
        store.signals.delete_on(oid),
    )
    .await?;
    store.machines.rows.delete(Filter::id(oid)).await?;
    state.pipeline.invalidate_pin_cache();
    Ok(Json(
        json!({ "message": "Machine and all related data deleted successfully" }),
    ))
}

// ── Per-machine signal wiring ────────────────────────────────────────────────
// A "signal" is a sensor (role = power | unit-cycle) bound to a PLC pin. Wiring
// one in a single step replaces the old create-sensor-then-map-pin two-step.

#[derive(serde::Deserialize)]
pub struct SignalReq {
    #[serde(rename = "plcId")]
    plc_id: Option<String>,
    #[serde(rename = "pinId")]
    pin_id: String,
    role: String,
}

/// List a machine's wired signals: role, sensor name, and pin (if mapped).
pub async fn signals_list(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let sensors = state.store.sensors.active_on(oid).await?;
    let ids: Vec<ObjectId> = sensors
        .iter()
        .filter_map(|s| s.id)
        .map(|i| i.oid())
        .collect();
    let mut wired: HashMap<Id, SensorPinMapping> = HashMap::new();
    for m in state.store.pins.of_sensors(&ids).await? {
        wired.entry(m.sensor_id).or_insert(m);
    }
    let out: Vec<Value> = sensors
        .iter()
        .map(|s| {
            let m = s.id.and_then(|sid| wired.get(&sid));
            json!({
                "sensorId": s.id.map(|i| i.to_hex()),
                "name": s.name,
                "role": s.sensor_type,
                "plcId": m.map(|m| m.plc_id.clone()),
                "pinId": m.map(|m| m.pin_id.clone()),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

/// Wire a signal to a machine: creates the sensor and its pin mapping at once.
pub async fn signals_create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<SignalReq>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let oid = parse_oid(&id)?;
    if b.role != sensors::POWER && b.role != sensors::UNIT_CYCLE {
        return Err(AppError::bad_request(
            "role must be 'power' or 'unit-cycle'",
        ));
    }
    let plc_id = b
        .plc_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PLC.to_string());
    let store = &state.store;
    let (machine_exists, pin_taken) = try_join(
        store.machines.rows.exists(Filter::id(oid)),
        store.pins.is_taken(&plc_id, &b.pin_id),
    )
    .await?;
    if !machine_exists {
        return Err(AppError::NotFound);
    }
    if pin_taken {
        return Err(AppError::bad_request(
            "That pin is already in use on this PLC",
        ));
    }

    let now = Utc::now();
    let mut sensor = Sensor {
        id: None,
        name: format!(
            "{} signal",
            if b.role == sensors::POWER {
                "Power"
            } else {
                "Cycle"
            }
        ),
        description: None,
        machine_id: Id(oid),
        sensor_type: b.role.clone(),
        is_active: true,
        created_at: Some(now),
        updated_at: Some(now),
    };
    // The sensor first: one left without a pin is harmless, a pin held for a
    // sensor that does not exist is not.
    let sensor_id = Id(store.sensors.rows.insert(&sensor).await?);
    sensor.id = Some(sensor_id);
    store.pins.wire(sensor_id, &plc_id, &b.pin_id).await?;
    state.pipeline.invalidate_pin_cache();

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "sensorId": sensor_id.to_hex(),
            "name": sensor.name,
            "role": sensor.sensor_type,
            "plcId": plc_id,
            "pinId": b.pin_id,
        })),
    ))
}

/// Remove a wired signal (deletes the sensor and frees its pin).
pub async fn signals_delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path((_machine_id, sensor_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let sid = parse_oid(&sensor_id)?;
    let store = &state.store;
    let (_, deleted) = try_join(
        store.pins.unwire(sid),
        store.sensors.rows.delete(Filter::id(sid)),
    )
    .await?;
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    state.pipeline.invalidate_pin_cache();
    Ok(Json(json!({ "message": "Signal removed" })))
}

/// Plant-wide setup readiness: what each machine still needs before its
/// OEE / MTTR / MTBF are meaningful.
pub async fn setup_status(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let store = &state.store;
    let (machines, sensors, mappings, dept_has_mold, dept_name) = try_join5(
        store.machines.active(None, None),
        store.sensors.active(),
        store.pins.all(),
        store.molds.departments_with_active(),
        active_department_names(&store.departments.rows),
    )
    .await?;

    let mapped: HashSet<Id> = mappings.iter().map(|m| m.sensor_id).collect();
    // Every (machine, role) with an active sensor wired to a pin.
    let wired: HashSet<(ObjectId, &str)> = sensors
        .iter()
        .filter(|s| s.id.is_some_and(|i| mapped.contains(&i)))
        .map(|s| (s.machine_id.oid(), s.sensor_type.as_str()))
        .collect();

    let out: Vec<Value> = machines
        .iter()
        .filter_map(|m| {
            let mid = m.id?.oid();
            let power_mapped = wired.contains(&(mid, sensors::POWER));
            let cycle_mapped = wired.contains(&(mid, sensors::UNIT_CYCLE));
            let mold = dept_has_mold.contains(&m.department_id.oid());
            Some(json!({
                "machineId": mid.to_hex(),
                "name": m.name,
                "status": m.status,
                "departmentId": m.department_id.to_hex(),
                "departmentName": dept_name.get(&m.department_id.oid()).cloned().unwrap_or_default(),
                "powerMapped": power_mapped,
                "cycleMapped": cycle_mapped,
                "departmentHasMold": mold,
                "ready": power_mapped && cycle_mapped && mold,
            }))
        })
        .collect();
    Ok(Json(json!(out)))
}
