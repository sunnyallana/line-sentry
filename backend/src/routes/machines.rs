//! Machine routes (mirrors server/routes/machines.js).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
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
