//! Sensor + pin-mapping routes (mirrors server/routes/sensors.js).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use bson::{doc, Document};
use chrono::Utc;
use futures::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::routes::common::*;
use crate::state::AppState;

fn with_machine() -> Vec<Document> {
    vec![
        doc! { "$lookup": { "from": MACHINES, "localField": "machineId", "foreignField": "_id", "as": "machineId" } },
        doc! { "$unwind": { "path": "$machineId", "preserveNullAndEmptyArrays": true } },
    ]
}

/// All active sensors, machine populated.
pub async fn list(_user: AuthUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let mut stages = vec![doc! { "$match": { "isActive": true } }];
    stages.extend(with_machine());
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(SENSORS)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn by_machine(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(machine_id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&machine_id)?;
    let mut stages = vec![doc! { "$match": { "machineId": oid, "isActive": true } }];
    stages.extend(with_machine());
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(SENSORS)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

/// Paginated sensors for admin, machine + department populated, filterable.
pub async fn admin_all(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let page = q_int(&q, "page", 1).max(1);
    let limit = q_int(&q, "limit", 10).max(1);
    let skip = (page - 1) * limit;

    let mut match_stage = Document::new();
    if let Some(rx) = search_regex(&q_str(&q, "search")) {
        match_stage.insert(
            "$or",
            vec![
                doc! { "name": &rx },
                doc! { "description": &rx },
                doc! { "sensorType": &rx },
            ],
        );
    }
    if let "true" | "false" = q_str(&q, "status").as_str() {
        match_stage.insert("isActive", q_str(&q, "status") == "true");
    }
    let sensor_type = q_str(&q, "sensorType");
    if !sensor_type.trim().is_empty() {
        match_stage.insert("sensorType", sensor_type);
    }

    let mut pipeline = vec![doc! { "$match": match_stage }];
    pipeline.push(doc! { "$lookup": {
        "from": MACHINES, "localField": "machineId", "foreignField": "_id", "as": "machineId",
        "pipeline": [
            { "$lookup": { "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id", "as": "departmentId" } },
            { "$unwind": "$departmentId" }
        ]
    }});
    pipeline.push(doc! { "$unwind": "$machineId" });
    let department = q_str(&q, "department");
    if !department.trim().is_empty() {
        let dep_oid = parse_oid(&department)?;
        pipeline.push(doc! { "$match": { "machineId.departmentId._id": dep_oid } });
    }
    pipeline.push(doc! { "$sort": sort_doc(&q_str(&q, "sortBy"), &q_str(&q, "sortOrder")) });

    let mut count_pipeline = pipeline.clone();
    count_pipeline.push(doc! { "$count": "total" });
    pipeline.push(doc! { "$skip": skip });
    pipeline.push(doc! { "$limit": limit });

    let coll = state.db.collection::<Document>(SENSORS);
    let docs: Vec<Document> = coll.aggregate(pipeline).await?.try_collect().await?;
    let total = coll
        .aggregate(count_pipeline)
        .await?
        .try_collect::<Vec<Document>>()
        .await?
        .first()
        .and_then(|d| {
            d.get_i32("total")
                .ok()
                .map(|v| v as i64)
                .or_else(|| d.get_i64("total").ok())
        })
        .unwrap_or(0);

    Ok(Json(json!({
        "sensors": docs_to_json(docs),
        "pagination": pagination(page, limit, total, "totalSensors"),
        "filters": {
            "search": q_str(&q, "search"), "department": department,
            "status": q_str(&q, "status"), "sensorType": q_str(&q, "sensorType"),
            "sortBy": q_str(&q, "sortBy"), "sortOrder": q_str(&q, "sortOrder"),
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
    let res = state
        .db
        .collection::<Sensor>(SENSORS)
        .insert_one(&body)
        .await?;
    body.id = res.inserted_id.as_object_id().map(Id);
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Sensor>,
) -> AppResult<Json<Sensor>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Sensor>(SENSORS);
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

/// Hard-delete a sensor and its pin mapping(s).
pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    state
        .db
        .collection::<Document>(SENSOR_PIN_MAPPINGS)
        .delete_many(doc! { "sensorId": oid })
        .await?;
    let res = state
        .db
        .collection::<Sensor>(SENSORS)
        .delete_one(doc! { "_id": oid })
        .await?;
    if res.deleted_count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "message": "Sensor permanently deleted" })))
}

#[derive(Deserialize)]
pub struct PinMappingReq {
    #[serde(rename = "sensorId")]
    sensor_id: Id,
    #[serde(rename = "pinId")]
    pin_id: String,
}

pub async fn create_pin_mapping(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(body): Json<PinMappingReq>,
) -> AppResult<(StatusCode, Json<SensorPinMapping>)> {
    let coll = state.db.collection::<SensorPinMapping>(SENSOR_PIN_MAPPINGS);
    if coll
        .find_one(doc! { "pinId": &body.pin_id })
        .await?
        .is_some()
    {
        return Err(AppError::bad_request("Pin is already occupied"));
    }
    if coll
        .find_one(doc! { "sensorId": body.sensor_id.oid() })
        .await?
        .is_some()
    {
        return Err(AppError::bad_request("Sensor is already mapped to a pin"));
    }
    let mut mapping = SensorPinMapping {
        id: None,
        sensor_id: body.sensor_id,
        pin_id: body.pin_id,
    };
    let res = coll.insert_one(&mapping).await?;
    mapping.id = res.inserted_id.as_object_id().map(Id);
    Ok((StatusCode::CREATED, Json(mapping)))
}

pub async fn pin_mappings(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let stages = vec![
        doc! { "$lookup": {
            "from": SENSORS, "localField": "sensorId", "foreignField": "_id", "as": "sensorId",
            "pipeline": [
                { "$lookup": { "from": MACHINES, "localField": "machineId", "foreignField": "_id", "as": "machineId" } },
                { "$unwind": "$machineId" }
            ]
        }},
        doc! { "$unwind": "$sensorId" },
    ];
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(SENSOR_PIN_MAPPINGS)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn delete_pin_mapping(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let res = state
        .db
        .collection::<Document>(SENSOR_PIN_MAPPINGS)
        .delete_one(doc! { "_id": oid })
        .await?;
    if res.deleted_count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(
        json!({ "message": "Pin mapping deleted successfully" }),
    ))
}
