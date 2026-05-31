//! Mold routes (mirrors server/routes/molds.js).

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

/// Active molds (operator-scoped), department populated.
pub async fn list(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let mut m = doc! { "isActive": true };
    if user.role == "operator" {
        if let Some(did) = user.department_id {
            m.insert("departmentId", did.oid());
        }
    }
    let stages = vec![
        doc! { "$match": m },
        doc! { "$lookup": { "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id", "as": "departmentId" } },
        doc! { "$unwind": { "path": "$departmentId", "preserveNullAndEmptyArrays": true } },
    ];
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(MOLDS)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

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
            vec![doc! { "name": &rx }, doc! { "description": &rx }],
        );
    }
    let department = q_str(&q, "department");
    if !department.trim().is_empty() {
        match_stage.insert("departmentId", parse_oid(&department)?);
    }
    if let "true" | "false" = q_str(&q, "isActive").as_str() {
        match_stage.insert("isActive", q_str(&q, "isActive") == "true");
    }

    let mut pipeline = vec![
        doc! { "$match": match_stage },
        doc! { "$lookup": { "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id", "as": "departmentId" } },
        doc! { "$unwind": "$departmentId" },
        doc! { "$sort": sort_doc(&q_str(&q, "sortBy"), &q_str(&q, "sortOrder")) },
    ];
    let mut count_pipeline = pipeline.clone();
    count_pipeline.push(doc! { "$count": "total" });
    pipeline.push(doc! { "$skip": skip });
    pipeline.push(doc! { "$limit": limit });

    let coll = state.db.collection::<Document>(MOLDS);
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
        "molds": docs_to_json(docs),
        "pagination": pagination(page, limit, total, "totalMolds"),
        "filters": {
            "search": q_str(&q, "search"), "department": department,
            "isActive": q_str(&q, "isActive"),
            "sortBy": q_str(&q, "sortBy"), "sortOrder": q_str(&q, "sortOrder"),
        }
    })))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<Mold>,
) -> AppResult<(StatusCode, Json<Mold>)> {
    body.id = None;
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);
    let res = state.db.collection::<Mold>(MOLDS).insert_one(&body).await?;
    body.id = res.inserted_id.as_object_id().map(Id);
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Mold>,
) -> AppResult<Json<Mold>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Mold>(MOLDS);
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

pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let res = state
        .db
        .collection::<Mold>(MOLDS)
        .delete_one(doc! { "_id": oid })
        .await?;
    if res.deleted_count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "message": "Mold deleted successfully" })))
}

/// Toggle active status.
pub async fn toggle_status(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<Mold>(MOLDS);
    let mut mold = coll
        .find_one(doc! { "_id": oid })
        .await?
        .ok_or(AppError::NotFound)?;
    mold.is_active = !mold.is_active;
    mold.updated_at = Some(Utc::now());
    coll.replace_one(doc! { "_id": oid }, &mold).await?;
    let verb = if mold.is_active {
        "activated"
    } else {
        "deactivated"
    };
    Ok(Json(json!({
        "message": format!("Mold {verb} successfully"),
        "mold": mold,
    })))
}
