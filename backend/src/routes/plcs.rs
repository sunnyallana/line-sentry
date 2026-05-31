//! PLC registry routes — the devices the daemon(s) read from. Each PLC owns a
//! pin space of `8 * byteCount` outputs (Q0.0 … Q{byteCount-1}.7); signal
//! mappings are scoped to its `plcId`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use bson::doc;
use chrono::Utc;
use futures::TryStreamExt;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::routes::common::*;
use crate::state::AppState;

/// All active PLCs (any authenticated user — the signal-wiring UI needs them).
pub async fn list(_user: AuthUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let plcs: Vec<Plc> = state
        .db
        .collection::<Plc>(PLCS)
        .find(doc! { "isActive": true })
        .await?
        .try_collect()
        .await?;
    Ok(Json(serde_json::to_value(plcs).unwrap_or_else(|_| Value::Array(vec![]))))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<Plc>,
) -> AppResult<(StatusCode, Json<Plc>)> {
    body.id = None;
    body.plc_id = body.plc_id.trim().to_string();
    if body.plc_id.is_empty() {
        return Err(AppError::bad_request("plcId is required"));
    }
    if body.byte_count < 1 {
        body.byte_count = 1;
    }
    let coll = state.db.collection::<Plc>(PLCS);
    if coll.find_one(doc! { "plcId": &body.plc_id }).await?.is_some() {
        return Err(AppError::bad_request("A PLC with that id already exists"));
    }
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);
    let res = coll.insert_one(&body).await?;
    body.id = res.inserted_id.as_object_id().map(Id);
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Plc>,
) -> AppResult<Json<Plc>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Plc>(PLCS);
    let existing = coll.find_one(doc! { "_id": oid }).await?.ok_or(AppError::NotFound)?;
    body.id = Some(Id(oid));
    body.plc_id = existing.plc_id; // immutable: mappings + daemons reference the slug
    body.created_at = existing.created_at;
    body.updated_at = Some(Utc::now());
    if body.byte_count < 1 {
        body.byte_count = 1;
    }
    coll.replace_one(doc! { "_id": oid }, &body).await?;
    Ok(Json(body))
}

pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Plc>(PLCS);
    let plc = coll.find_one(doc! { "_id": oid }).await?.ok_or(AppError::NotFound)?;
    let in_use = state
        .db
        .collection::<bson::Document>(SENSOR_PIN_MAPPINGS)
        .count_documents(doc! { "plcId": &plc.plc_id })
        .await?;
    if in_use > 0 {
        return Err(AppError::bad_request(
            "This PLC still has wired signals — remove them before deleting it",
        ));
    }
    coll.delete_one(doc! { "_id": oid }).await?;
    Ok(Json(json!({ "message": "PLC removed" })))
}
