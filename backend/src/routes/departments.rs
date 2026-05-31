//! Department routes (mirrors server/routes/departments.js).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
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

/// Active departments (operator-scoped), each with its machines + machineCount.
pub async fn list(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let mut m = doc! { "isActive": true };
    if user.role == "operator" {
        if let Some(did) = user.department_id {
            m.insert("_id", did.oid());
        }
    }
    let mut pipeline = vec![
        doc! { "$match": m },
        doc! { "$lookup": {
            "from": MACHINES, "localField": "_id", "foreignField": "departmentId", "as": "machines",
            "pipeline": [
                { "$match": { "isActive": true } },
                { "$project": { "_id": 1, "name": 1, "status": 1, "position": 1, "dimensions": 1 } }
            ]
        }},
        doc! { "$addFields": { "machineCount": { "$size": "$machines" } } },
    ];
    if let Some(l) = q.get("limit").and_then(|v| v.parse::<i64>().ok()) {
        if l > 0 {
            pipeline.push(doc! { "$limit": l });
        }
    }
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(DEPARTMENTS)
        .aggregate(pipeline)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

/// Paginated departments for admin (with machineCount).
pub async fn admin_all(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let page = q_int(&q, "page", 1).max(1);
    let limit = q_int(&q, "limit", 10).max(1);
    let skip = (page - 1) * limit;

    let mut m = Document::new();
    if let Some(rx) = search_regex(&q_str(&q, "search")) {
        m.insert(
            "$or",
            vec![doc! { "name": &rx }, doc! { "description": &rx }],
        );
    }
    match q_str(&q, "isActive").as_str() {
        "" => {}
        v => {
            m.insert("isActive", v == "true");
        }
    }

    let lookup = doc! { "$lookup": {
        "from": MACHINES, "localField": "_id", "foreignField": "departmentId", "as": "machines",
        "pipeline": [ { "$match": { "isActive": true } }, { "$project": { "_id": 1, "name": 1, "status": 1 } } ]
    }};
    let add = doc! { "$addFields": { "machineCount": { "$size": "$machines" } } };
    let sort = sort_doc(&q_str(&q, "sortBy"), &q_str(&q, "sortOrder"));

    let coll = state.db.collection::<Document>(DEPARTMENTS);
    let docs: Vec<Document> = coll
        .aggregate(vec![
            doc! { "$match": m.clone() },
            lookup,
            add,
            doc! { "$sort": sort },
            doc! { "$skip": skip },
            doc! { "$limit": limit },
        ])
        .await?
        .try_collect()
        .await?;
    let total = coll.count_documents(m).await? as i64;

    Ok(Json(json!({
        "departments": docs_to_json(docs),
        "pagination": pagination(page, limit, total, "totalDepartments"),
        "filters": {
            "search": q_str(&q, "search"),
            "isActive": q_str(&q, "isActive"),
            "sortBy": q_str(&q, "sortBy"),
            "sortOrder": q_str(&q, "sortOrder"),
        }
    })))
}

/// One department with its active machines (operator-scoped).
pub async fn get_one(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    if user.role == "operator" && user.department_id.map(|d| d.oid()) != Some(oid) {
        return Err(AppError::Forbidden);
    }
    let dept = state
        .db
        .collection::<Document>(DEPARTMENTS)
        .find_one(doc! { "_id": oid })
        .await?
        .ok_or(AppError::NotFound)?;
    let machines: Vec<Document> = state
        .db
        .collection::<Document>(MACHINES)
        .find(doc! { "departmentId": oid, "isActive": true })
        .await?
        .try_collect()
        .await?;

    let mut obj = match doc_to_json(dept) {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("machines".into(), docs_to_json(machines));
    Ok(Json(Value::Object(obj)))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<Department>,
) -> AppResult<(StatusCode, Json<Department>)> {
    body.id = None;
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);
    let res = state
        .db
        .collection::<Department>(DEPARTMENTS)
        .insert_one(&body)
        .await?;
    body.id = res.inserted_id.as_object_id().map(Id);
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Department>,
) -> AppResult<Json<Department>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Department>(DEPARTMENTS);
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

/// Delete a department and cascade to its machines + molds.
pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Department>(DEPARTMENTS);
    if coll.find_one(doc! { "_id": oid }).await?.is_none() {
        return Err(AppError::NotFound);
    }
    state
        .db
        .collection::<Document>(MACHINES)
        .delete_many(doc! { "departmentId": oid })
        .await?;
    state
        .db
        .collection::<Document>(MOLDS)
        .delete_many(doc! { "departmentId": oid })
        .await?;
    coll.delete_one(doc! { "_id": oid }).await?;
    Ok(Json(json!({
        "message": "Department, associated machines, and associated molds deleted successfully"
    })))
}
