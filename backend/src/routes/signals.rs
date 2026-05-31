//! Signal routes:
//!   POST /api/signals/pin-data                 (daemon, X-API-Key)
//!   GET  /api/signals/unclassified-stoppages-count   (auth)
//!   GET  /api/signals/machine/{machineId}/recent     (auth)
//!   POST /api/signals                          (auth)

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use bson::{doc, oid::ObjectId, Bson, Document};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{AuthUser, DaemonKey};
use crate::error::{AppError, AppResult};
use crate::models::{Id, DEFAULT_PLC, PRODUCTION_RECORDS, SIGNAL_DATA};
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
    let plc_id = body.plc_id.as_deref().filter(|s| !s.is_empty()).unwrap_or(DEFAULT_PLC);
    let processed = pipeline::process_pin_data(&state, plc_id, &pin, body.timestamp.as_deref()).await?;
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
    let stages = vec![
        doc! { "$match": { "hourlyData.stoppages.reason": "unclassified" } },
        doc! { "$project": { "unclassifiedCount": { "$size": { "$filter": {
            "input": { "$reduce": {
                "input": "$hourlyData",
                "initialValue": [],
                "in": { "$concatArrays": ["$$value", "$$this.stoppages"] },
            }},
            "cond": { "$eq": ["$$this.reason", "unclassified"] },
        }}}}},
        doc! { "$group": { "_id": Bson::Null, "total": { "$sum": "$unclassifiedCount" } } },
    ];

    let mut cursor = state
        .db
        .collection::<Document>(PRODUCTION_RECORDS)
        .aggregate(stages)
        .await?;

    let count = match cursor.try_next().await? {
        Some(d) => match d.get("total") {
            Some(Bson::Int32(i)) => *i as i64,
            Some(Bson::Int64(i)) => *i,
            Some(Bson::Double(f)) => *f as i64,
            _ => 0,
        },
        None => 0,
    };
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
    let stages = vec![
        doc! { "$match": { "machineId": oid } },
        doc! { "$lookup": {
            "from": "sensors",
            "localField": "sensorId",
            "foreignField": "_id",
            "as": "sensorId",
        }},
        doc! { "$unwind": "$sensorId" },
    ];

    let docs: Vec<Document> = state
        .db
        .collection::<Document>(SIGNAL_DATA)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
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
        .db
        .collection::<Document>(SIGNAL_DATA)
        .update_one(
            doc! { "sensorId": body.sensor_id.oid() },
            doc! { "$set": {
                "machineId": body.machine_id.oid(),
                "value": value_bson,
                "timestamp": bson::DateTime::from_chrono(ts),
            }},
        )
        .upsert(true)
        .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "message": "Signal data updated successfully" })),
    ))
}
