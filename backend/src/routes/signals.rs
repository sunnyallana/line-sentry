//! Signal routes:
//!   POST /api/signals/pin-data                 (daemon, X-API-Key)
//!   GET  /api/signals/unclassified-stoppages-count   (auth)
//!   GET  /api/signals/machine/{machineId}/recent     (auth)
//!   POST /api/signals                          (auth)

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use bson::{oid::ObjectId, Bson};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{AuthUser, DaemonKey};
use crate::error::{AppError, AppResult};
use crate::models::{Id, DEFAULT_PLC};
use crate::persist::signals::unclassified_stoppages;
use crate::pipeline;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct PinDataReq {
    #[serde(rename = "pinData")]
    pin_data: Option<String>,
    timestamp: Option<String>,
    /// Which PLC posted this byte (registry `plcId`). Defaults to "default".
    #[serde(rename = "plcId")]
    plc_id: Option<String>,
}

#[derive(Deserialize)]
pub struct Reading {
    #[serde(rename = "pinData")]
    pin_data: String,
    timestamp: Option<String>,
}

#[derive(Deserialize)]
pub struct PinBatchReq {
    #[serde(rename = "plcId")]
    plc_id: Option<String>,
    readings: Vec<Reading>,
}

/// Most readings one batch may carry (ten minutes at one per second).
const MAX_BATCH: usize = 600;

/// Ingest readings a daemon held back while the backend was unreachable, oldest
/// first. Each carries its own timestamp, so a batch can be resent safely.
pub async fn pin_data_batch(
    _key: DaemonKey,
    State(state): State<AppState>,
    Json(body): Json<PinBatchReq>,
) -> AppResult<Json<Value>> {
    if body.readings.is_empty() {
        return Err(AppError::bad_request("readings must not be empty"));
    }
    if body.readings.len() > MAX_BATCH {
        return Err(AppError::bad_request(format!(
            "a batch can carry at most {MAX_BATCH} readings"
        )));
    }
    if body
        .readings
        .iter()
        .any(|r| r.timestamp.as_deref().unwrap_or("").is_empty())
    {
        return Err(AppError::bad_request(
            "every reading in a batch needs its own timestamp",
        ));
    }
    let plc_id = body
        .plc_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PLC);
    let readings: Vec<(String, Option<String>)> = body
        .readings
        .into_iter()
        .map(|r| (r.pin_data, r.timestamp))
        .collect();
    let (applied, rejected) = pipeline::process_batch(&state, plc_id, &readings).await?;
    Ok(Json(json!({ "applied": applied, "rejected": rejected })))
}

/// Ingest one pin byte from the daemon. Guarded by the daemon API key.
pub async fn pin_data(
    _key: DaemonKey,
    State(state): State<AppState>,
    Json(body): Json<PinDataReq>,
) -> AppResult<Json<Value>> {
    let pin = body.pin_data.unwrap_or_default();
    if pin.is_empty() {
        return Err(AppError::bad_request("pinData is required"));
    }
    let plc_id = body
        .plc_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PLC);
    let processed =
        pipeline::process_pin_data(&state, plc_id, &pin, body.timestamp.as_deref()).await?;
    Ok(Json(json!({
        "message": "Pin data processed successfully",
        "processedMachines": processed,
    })))
}

/// Count of unclassified stoppages across all production records.
pub async fn unclassified_stoppages_count(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let count = unclassified_stoppages(&state.store.records).await?;
    Ok(Json(json!({ "count": count })))
}

/// Current signals for a machine (one per sensor), sensor populated.
pub async fn recent(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(machine_id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = ObjectId::parse_str(&machine_id)
        .map_err(|_| AppError::bad_request("invalid machine id"))?;
    // The newest readings may still be waiting in the bulk writer.
    state.store.flush().await;
    let docs = state.store.signals.latest_on(oid).await?;
    Ok(Json(crate::routes::common::docs_to_json(docs)))
}

#[derive(Deserialize)]
pub struct SignalReq {
    #[serde(rename = "sensorId")]
    sensor_id: Id,
    #[serde(rename = "machineId")]
    machine_id: Id,
    value: Value,
    timestamp: Option<String>,
}

/// Upsert a single signal value (one per sensor).
pub async fn post_signal(
    _user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SignalReq>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let ts = body
        .timestamp
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let value_bson = bson::to_bson(&body.value).unwrap_or(Bson::Null);

    state
        .store
        .signals
        .set_latest(body.sensor_id.oid(), body.machine_id.oid(), value_bson, ts)
        .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "message": "Signal data updated successfully" })),
    ))
}
