//! Configuration routes (mirrors server/routes/config.js).
//!
//! NOTE: `email.senderPassword` is stored as provided (parity with Node). A
//! follow-up should encrypt it at rest with an env-derived key.

use axum::extract::State;
use axum::Json;
use bson::{doc, Bson, Document};
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::persist::configs::{default_reasons, validate_reasons, StoppageReason};
use crate::routes::common::{bson_to_json, doc_to_json};
use crate::state::AppState;

/// Default configuration document (matches the Mongoose schema defaults).
fn default_config() -> Document {
    let band = |e: i32, g: i32, f: i32| doc! { "excellent": e, "good": g, "fair": f };
    doc! {
        "plc": { "ip": "192.168.1.11", "rack": 0, "slot": 1 },
        "signalTimeouts": { "powerSignalTimeout": 5, "cycleSignalTimeout": 2 },
        "shifts": Bson::Array(vec![]),
        "stoppageReasons": default_reasons().iter().map(Bson::from).collect::<Vec<_>>(),
        "email": {
            "senderEmail": "admin@dawlance.com",
            "senderPassword": "admin123",
            "recipients": Bson::Array(vec![]),
        },
        "reportSchedule": { "enabled": false, "hour": 6, "email": true },
        "metricsThresholds": {
            "oee": band(85, 70, 50),
            "availability": band(90, 80, 70),
            "quality": band(95, 90, 85),
            "performance": band(90, 80, 70),
            "mtbf": band(500, 300, 150),
            "mttr": band(20, 40, 60),
            "reliability": band(10, 5, 2),
        },
        "createdAt": Bson::DateTime(bson::DateTime::now()),
        "updatedAt": Bson::DateTime(bson::DateTime::now()),
    }
}

/// Shifts only (any authenticated user).
pub async fn shifts(_user: AuthUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    match state.store.configs.shift_documents().await? {
        Some(shifts) => Ok(Json(Value::Array(
            shifts.into_iter().map(bson_to_json).collect(),
        ))),
        None => Ok(Json(json!({ "shifts": [] }))),
    }
}

/// The reasons a person can give for a stoppage (any authenticated user).
pub async fn stoppage_reasons(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<StoppageReason>>> {
    Ok(Json(state.store.configs.stoppage_reasons().await?))
}

/// Full configuration (admin). Creates defaults if none exist.
pub async fn get(_admin: AdminUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    if let Some(cfg) = state.store.configs.document().await? {
        return Ok(Json(doc_to_json(cfg)));
    }
    let mut cfg = default_config();
    let id = state.store.configs.create(&cfg).await?;
    cfg.insert("_id", id);
    Ok(Json(doc_to_json(cfg)))
}

/// Upsert configuration (admin).
pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let sections = bson::to_document(&body)
        .map_err(|_| AppError::bad_request("invalid configuration body"))?;
    if let Some(reasons) = sections.get("stoppageReasons") {
        validate_reasons(reasons).map_err(AppError::bad_request)?;
    }

    match state.store.configs.save(sections).await? {
        Some(d) => Ok(Json(doc_to_json(d))),
        None => Ok(Json(json!({}))),
    }
}
