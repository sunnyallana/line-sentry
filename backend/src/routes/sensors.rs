//! Sensor + pin-mapping routes (mirrors server/routes/sensors.js).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use futures::future::try_join;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::sensors::{Listing, Slice};
use crate::persist::Filter;
use crate::routes::common::*;
use crate::state::AppState;

/// All active sensors, machine populated.
pub async fn list(_user: AuthUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let docs = state.store.sensors.active_with_machine(None).await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn by_machine(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(machine_id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&machine_id)?;
    let docs = state.store.sensors.active_with_machine(Some(oid)).await?;
    Ok(Json(docs_to_json(docs)))
}

/// Paginated sensors for admin, machine + department populated, filterable.
pub async fn admin_all(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let page = page_of(&q);
    let limit = limit_of(&q);

    let search = q_str(&q, "search");
    let pattern: String = search.trim().chars().take(100).collect();
    let pattern = (!pattern.is_empty()).then(|| escape_regex(&pattern));
    let status = q_str(&q, "status");
    let sensor_type = q_str(&q, "sensorType");
    let department = q_str(&q, "department");
    let (sort_by, sort_order) = (sort_field(&q), q_str(&q, "sortOrder"));

    let listing = Listing {
        search: pattern.as_deref(),
        active: match status.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        kind: (!sensor_type.trim().is_empty()).then_some(sensor_type.as_str()),
        department: if department.trim().is_empty() {
            None
        } else {
            Some(parse_oid(&department)?)
        },
        slice: Slice {
            sort_by: &sort_by,
            ascending: sort_order == "asc",
            skip: (page - 1) * limit,
            limit,
        },
    };
    let (docs, total) = state.store.sensors.admin_page(&listing).await?;

    Ok(Json(json!({
        "sensors": docs_to_json(docs),
        "pagination": pagination(page, limit, total, "totalSensors"),
        "filters": {
            "search": search, "department": department,
            "status": status, "sensorType": sensor_type,
            "sortBy": sort_by, "sortOrder": sort_order,
        }
    })))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<Sensor>,
) -> AppResult<(StatusCode, Json<Sensor>)> {
    body.id = None;
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);
    body.id = Some(Id(state.store.sensors.rows.insert(&body).await?));
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Sensor>,
) -> AppResult<Json<Sensor>> {
    let oid = parse_oid(&id)?;
    let sensors = &state.store.sensors;
    let existing = sensors.rows.get(oid).await?.ok_or(AppError::NotFound)?;
    sensors.edit(oid, &body).await?;
    // The pipeline caches each pin's sensor type and machine.
    state.pipeline.invalidate_pin_cache();
    body.id = Some(Id(oid));
    body.created_at = existing.created_at;
    body.updated_at = Some(Utc::now());
    Ok(Json(body))
}

/// Hard-delete a sensor and its pin mapping(s).
pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let store = &state.store;
    let (_, deleted) = try_join(
        store.pins.unwire(oid),
        store.sensors.rows.delete(Filter::id(oid)),
    )
    .await?;
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    state.pipeline.invalidate_pin_cache();
    Ok(Json(json!({ "message": "Sensor permanently deleted" })))
}

#[derive(Deserialize)]
pub struct PinMappingReq {
    #[serde(rename = "sensorId")]
    sensor_id: Id,
    #[serde(rename = "pinId")]
    pin_id: String,
    #[serde(rename = "plcId")]
    plc_id: Option<String>,
}

pub async fn create_pin_mapping(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(body): Json<PinMappingReq>,
) -> AppResult<(StatusCode, Json<SensorPinMapping>)> {
    let plc_id = body
        .plc_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PLC.to_string());
    let pins = &state.store.pins;
    let (pin_taken, sensor_wired) = try_join(
        pins.is_taken(&plc_id, &body.pin_id),
        pins.is_wired(body.sensor_id.oid()),
    )
    .await?;
    if pin_taken {
        return Err(AppError::bad_request(
            "That pin is already in use on this PLC",
        ));
    }
    if sensor_wired {
        return Err(AppError::bad_request("Sensor is already mapped to a pin"));
    }
    let mapping = pins.wire(body.sensor_id, &plc_id, &body.pin_id).await?;
    state.pipeline.invalidate_pin_cache();
    Ok((StatusCode::CREATED, Json(mapping)))
}

pub async fn pin_mappings(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let docs = state.store.pins.with_sensor().await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn delete_pin_mapping(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    if state.store.pins.rows.delete(Filter::id(oid)).await? == 0 {
        return Err(AppError::NotFound);
    }
    state.pipeline.invalidate_pin_cache();
    Ok(Json(
        json!({ "message": "Pin mapping deleted successfully" }),
    ))
}
