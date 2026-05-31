//! Machine routes (mirrors server/routes/machines.js).

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use bson::oid::ObjectId;
use bson::{doc, Document};
use chrono::Utc;
use futures::TryStreamExt;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::routes::common::*;
use crate::state::AppState;

fn with_department() -> Vec<Document> {
    vec![
        doc! { "$lookup": { "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id", "as": "departmentId" } },
        doc! { "$unwind": { "path": "$departmentId", "preserveNullAndEmptyArrays": true } },
    ]
}

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
    let mut stages = vec![doc! { "$match": { "departmentId": oid, "isActive": true } }];
    stages.extend(with_department());
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(MACHINES)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn get_one(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let machine = state
        .db
        .collection::<Machine>(MACHINES)
        .find_one(doc! { "_id": oid })
        .await?
        .ok_or(AppError::NotFound)?;
    if user.role == "operator" && user.department_id != Some(machine.department_id) {
        return Err(AppError::Forbidden);
    }
    let mut stages = vec![doc! { "$match": { "_id": oid } }];
    stages.extend(with_department());
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(MACHINES)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    let first = docs.into_iter().next().ok_or(AppError::NotFound)?;
    Ok(Json(doc_to_json(first)))
}

/// All active machines (admin), department populated.
pub async fn list(_admin: AdminUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let mut stages = vec![doc! { "$match": { "isActive": true } }];
    stages.extend(with_department());
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(MACHINES)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
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
    let res = state
        .db
        .collection::<Machine>(MACHINES)
        .insert_one(&body)
        .await?;
    body.id = res.inserted_id.as_object_id().map(Id);
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Machine>,
) -> AppResult<Json<Machine>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Machine>(MACHINES);
    let existing = coll
        .find_one(doc! { "_id": oid })
        .await?
        .ok_or(AppError::NotFound)?;
    body.id = Some(Id(oid));
    body.created_at = existing.created_at;
    body.updated_at = Some(Utc::now());
    coll.replace_one(doc! { "_id": oid }, &body).await?;
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
        .db
        .collection::<Document>(MACHINES)
        .find_one_and_update(
            doc! { "_id": oid },
            doc! { "$set": {
                "position": { "x": p.x, "y": p.y },
                "dimensions": { "width": p.width, "height": p.height },
                "updatedAt": bson::DateTime::now(),
            }},
        )
        .return_document(mongodb::options::ReturnDocument::After)
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
    let coll = state.db.collection::<Machine>(MACHINES);
    if coll.find_one(doc! { "_id": oid }).await?.is_none() {
        return Err(AppError::NotFound);
    }
    state
        .db
        .collection::<Document>(SENSORS)
        .delete_many(doc! { "machineId": oid })
        .await?;
    state
        .db
        .collection::<Document>(PRODUCTION_RECORDS)
        .delete_many(doc! { "machineId": oid })
        .await?;
    state
        .db
        .collection::<Document>(SIGNAL_DATA)
        .delete_many(doc! { "machineId": oid })
        .await?;
    coll.delete_one(doc! { "_id": oid }).await?;
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
    let sensors: Vec<Sensor> = state
        .db
        .collection::<Sensor>(SENSORS)
        .find(doc! { "machineId": oid, "isActive": true })
        .await?
        .try_collect()
        .await?;
    let mappings: Vec<SensorPinMapping> = state
        .db
        .collection::<SensorPinMapping>(SENSOR_PIN_MAPPINGS)
        .find(doc! {})
        .await?
        .try_collect()
        .await?;
    let out: Vec<Value> = sensors
        .iter()
        .map(|s| {
            let m = s.id.and_then(|sid| mappings.iter().find(|m| m.sensor_id == sid));
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
    if b.role != "power" && b.role != "unit-cycle" {
        return Err(AppError::bad_request("role must be 'power' or 'unit-cycle'"));
    }
    if state
        .db
        .collection::<Machine>(MACHINES)
        .find_one(doc! { "_id": oid })
        .await?
        .is_none()
    {
        return Err(AppError::NotFound);
    }
    let plc_id = b
        .plc_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PLC.to_string());
    let pin_coll = state.db.collection::<SensorPinMapping>(SENSOR_PIN_MAPPINGS);
    if pin_coll
        .find_one(doc! { "plcId": &plc_id, "pinId": &b.pin_id })
        .await?
        .is_some()
    {
        return Err(AppError::bad_request("That pin is already in use on this PLC"));
    }

    let now = Utc::now();
    let mut sensor = Sensor {
        id: None,
        name: format!(
            "{} signal",
            if b.role == "power" { "Power" } else { "Cycle" }
        ),
        description: None,
        machine_id: Id(oid),
        sensor_type: b.role.clone(),
        is_active: true,
        created_at: Some(now),
        updated_at: Some(now),
    };
    let res = state
        .db
        .collection::<Sensor>(SENSORS)
        .insert_one(&sensor)
        .await?;
    let sensor_id = res
        .inserted_id
        .as_object_id()
        .map(Id)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("sensor insert returned no id")))?;
    sensor.id = Some(sensor_id);

    let mapping = SensorPinMapping {
        id: None,
        sensor_id,
        plc_id: plc_id.clone(),
        pin_id: b.pin_id.clone(),
    };
    pin_coll.insert_one(&mapping).await?;
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
    state
        .db
        .collection::<Document>(SENSOR_PIN_MAPPINGS)
        .delete_many(doc! { "sensorId": sid })
        .await?;
    let res = state
        .db
        .collection::<Sensor>(SENSORS)
        .delete_one(doc! { "_id": sid })
        .await?;
    if res.deleted_count == 0 {
        return Err(AppError::NotFound);
    }
    state.pipeline.invalidate_pin_cache();
    Ok(Json(json!({ "message": "Signal removed" })))
}

/// Plant-wide setup readiness: what each machine still needs before its
/// OEE / MTTR / MTBF are meaningful.
pub async fn setup_status(_admin: AdminUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let machines: Vec<Machine> = state
        .db
        .collection::<Machine>(MACHINES)
        .find(doc! { "isActive": true })
        .await?
        .try_collect()
        .await?;
    let sensors: Vec<Sensor> = state
        .db
        .collection::<Sensor>(SENSORS)
        .find(doc! { "isActive": true })
        .await?
        .try_collect()
        .await?;
    let mappings: Vec<SensorPinMapping> = state
        .db
        .collection::<SensorPinMapping>(SENSOR_PIN_MAPPINGS)
        .find(doc! {})
        .await?
        .try_collect()
        .await?;
    let molds: Vec<Mold> = state
        .db
        .collection::<Mold>(MOLDS)
        .find(doc! { "isActive": true })
        .await?
        .try_collect()
        .await?;
    let depts: Vec<Department> = state
        .db
        .collection::<Department>(DEPARTMENTS)
        .find(doc! { "isActive": true })
        .await?
        .try_collect()
        .await?;

    let mapped: HashSet<ObjectId> = mappings.iter().map(|m| m.sensor_id.oid()).collect();
    let dept_has_mold: HashSet<ObjectId> = molds.iter().map(|m| m.department_id.oid()).collect();
    let dept_name: HashMap<ObjectId, String> = depts
        .iter()
        .filter_map(|d| d.id.map(|i| (i.oid(), d.name.clone())))
        .collect();

    let role_mapped = |machine: ObjectId, role: &str| {
        sensors.iter().any(|s| {
            s.machine_id.oid() == machine
                && s.sensor_type == role
                && s.id.map(|i| mapped.contains(&i.oid())).unwrap_or(false)
        })
    };

    let out: Vec<Value> = machines
        .iter()
        .filter_map(|m| {
            let mid = m.id?.oid();
            let power_mapped = role_mapped(mid, "power");
            let cycle_mapped = role_mapped(mid, "unit-cycle");
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
