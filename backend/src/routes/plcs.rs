//! PLC registry routes — the devices the daemon(s) read from. Each PLC owns a
//! pin space of `8 * byteCount` outputs (Q0.0 … Q{byteCount-1}.7); signal
//! mappings are scoped to its `plcId`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::Filter;
use crate::routes::common::*;
use crate::state::AppState;

/// All active PLCs (any authenticated user — the signal-wiring UI needs them).
pub async fn list(_user: AuthUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let plcs = state.store.plcs.active().await?;
    Ok(Json(
        serde_json::to_value(plcs).unwrap_or_else(|_| Value::Array(vec![])),
    ))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<Plc>,
) -> AppResult<(StatusCode, Json<Plc>)> {
    body.id = None;
    body.last_seen_at = None;
    body.plc_id = body.plc_id.trim().to_string();
    if body.plc_id.is_empty() {
        return Err(AppError::bad_request("plcId is required"));
    }
    if body.byte_count < 1 {
        body.byte_count = 1;
    }
    let plcs = &state.store.plcs;
    if plcs.is_registered(&body.plc_id).await? {
        return Err(AppError::bad_request("A PLC with that id already exists"));
    }
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);
    body.id = Some(Id(plcs.rows.insert(&body).await?));
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Plc>,
) -> AppResult<Json<Plc>> {
    let oid = parse_oid(&id)?;
    let plcs = &state.store.plcs;
    let existing = plcs.rows.get(oid).await?.ok_or(AppError::NotFound)?;
    body.id = Some(Id(oid));
    body.plc_id = existing.plc_id; // immutable: mappings + daemons reference the slug
    body.created_at = existing.created_at;
    body.last_seen_at = existing.last_seen_at;
    body.updated_at = Some(Utc::now());
    if body.byte_count < 1 {
        body.byte_count = 1;
    }
    plcs.edit(oid, &body).await?;
    Ok(Json(body))
}

pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let plcs = &state.store.plcs;
    let plc = plcs.rows.get(oid).await?.ok_or(AppError::NotFound)?;
    if state.store.pins.any_on_plc(&plc.plc_id).await? {
        return Err(AppError::bad_request(
            "This PLC still has wired signals — remove them before deleting it",
        ));
    }
    plcs.rows.delete(Filter::id(oid)).await?;
    Ok(Json(json!({ "message": "PLC removed" })))
}
