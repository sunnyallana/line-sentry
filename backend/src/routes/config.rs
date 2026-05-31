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
use crate::models::CONFIGS;
use crate::routes::common::doc_to_json;
use crate::state::AppState;

/// Default configuration document (matches the Mongoose schema defaults).
fn default_config() -> Document {
    let band = |e: i32, g: i32, f: i32| doc! { "excellent": e, "good": g, "fair": f };
    doc! {
        "plc": { "ip": "192.168.1.11", "rack": 0, "slot": 1 },
        "signalTimeouts": { "powerSignalTimeout": 5, "cycleSignalTimeout": 2 },
        "shifts": Bson::Array(vec![]),
        "email": {
            "senderEmail": "admin@dawlance.com",
            "senderPassword": "admin123",
            "recipients": Bson::Array(vec![]),
        },
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
    let cfg = state
        .db
        .collection::<Document>(CONFIGS)
        .find_one(doc! {})
        .await?;
    match cfg.and_then(|c| c.get("shifts").cloned()) {
        Some(Bson::Array(arr)) => Ok(Json(Value::Array(
            arr.into_iter()
                .map(crate::routes::common::bson_to_json)
                .collect(),
        ))),
        _ => Ok(Json(json!({ "shifts": [] }))),
    }
}

/// Full configuration (admin). Creates defaults if none exist.
pub async fn get(_admin: AdminUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let coll = state.db.collection::<Document>(CONFIGS);
    if let Some(cfg) = coll.find_one(doc! {}).await? {
        return Ok(Json(doc_to_json(cfg)));
    }
    let mut cfg = default_config();
    let res = coll.insert_one(&cfg).await?;
    if let Some(oid) = res.inserted_id.as_object_id() {
        cfg.insert("_id", oid);
    }
    Ok(Json(doc_to_json(cfg)))
}

/// Upsert configuration (admin).
pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let mut set = bson::to_document(&body)
        .map_err(|_| AppError::bad_request("invalid configuration body"))?;
    set.remove("_id");
    set.insert("updatedAt", Bson::DateTime(bson::DateTime::now()));

    let updated = state
        .db
        .collection::<Document>(CONFIGS)
        .find_one_and_update(doc! {}, doc! { "$set": set })
        .upsert(true)
        .return_document(mongodb::options::ReturnDocument::After)
        .await?;

    match updated {
        Some(d) => Ok(Json(doc_to_json(d))),
        None => Ok(Json(json!({}))),
    }
}
