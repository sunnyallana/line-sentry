//! User routes (mirrors server/routes/users.js). Password hashing happens here
//! (the Node Mongoose pre-save hook has no equivalent in the Rust driver).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use bson::{doc, Document};
use chrono::Utc;
use futures::TryStreamExt;
use serde_json::{json, Value};

use crate::auth::{self, AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::routes::common::*;
use crate::state::AppState;

/// Map a Mongo duplicate-key (11000) error to a friendly message.
fn dup_field(e: &mongodb::error::Error) -> Option<String> {
    use mongodb::error::{ErrorKind, WriteFailure};
    if let ErrorKind::Write(WriteFailure::WriteError(we)) = e.kind.as_ref() {
        if we.code == 11000 {
            let msg = we.message.to_lowercase();
            if msg.contains("username") {
                return Some("Username already exists".into());
            }
            if msg.contains("email") {
                return Some("Email already exists".into());
            }
            return Some("Duplicate value".into());
        }
    }
    None
}

fn populate_dept_no_password(match_stage: Document) -> Vec<Document> {
    vec![
        doc! { "$match": match_stage },
        doc! { "$lookup": {
            "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id", "as": "departmentId",
            "pipeline": [ { "$project": { "name": 1 } } ]
        }},
        doc! { "$unwind": { "path": "$departmentId", "preserveNullAndEmptyArrays": true } },
        doc! { "$project": { "password": 0 } },
    ]
}

/// Active users (operators see only their department), password stripped.
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
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(USERS)
        .aggregate(populate_dept_no_password(m))
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

    let mut m = Document::new();
    if let Some(rx) = search_regex(&q_str(&q, "search")) {
        m.insert("$or", vec![doc! { "username": &rx }, doc! { "email": &rx }]);
    }
    let role = q_str(&q, "role");
    if !role.trim().is_empty() {
        m.insert("role", role);
    }
    let department = q_str(&q, "department");
    if !department.trim().is_empty() {
        m.insert("departmentId", parse_oid(&department)?);
    }
    if let "true" | "false" = q_str(&q, "isActive").as_str() {
        m.insert("isActive", q_str(&q, "isActive") == "true");
    }

    let coll = state.db.collection::<Document>(USERS);
    let total = coll.count_documents(m.clone()).await? as i64;

    let mut stages = populate_dept_no_password(m);
    stages.push(doc! { "$sort": sort_doc(&q_str(&q, "sortBy"), &q_str(&q, "sortOrder")) });
    stages.push(doc! { "$skip": skip });
    stages.push(doc! { "$limit": limit });
    let docs: Vec<Document> = coll.aggregate(stages).await?.try_collect().await?;

    Ok(Json(json!({
        "users": docs_to_json(docs),
        "pagination": pagination(page, limit, total, "totalUsers"),
        "filters": {
            "search": q_str(&q, "search"), "role": q_str(&q, "role"),
            "department": department, "isActive": q_str(&q, "isActive"),
            "sortBy": q_str(&q, "sortBy"), "sortOrder": q_str(&q, "sortOrder"),
        }
    })))
}

pub async fn create(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(mut body): Json<User>,
) -> AppResult<(StatusCode, Json<Value>)> {
    if body.role == "operator" && body.department_id.is_none() {
        return Err(AppError::bad_request(
            "Department is required for operators",
        ));
    }
    if body.role != "operator" {
        body.department_id = None;
    }
    body.id = None;
    body.password = auth::hash_password(&body.password)?;
    let now = Utc::now();
    body.created_at = Some(now);
    body.updated_at = Some(now);

    let res = match state.db.collection::<User>(USERS).insert_one(&body).await {
        Ok(r) => r,
        Err(e) => {
            if let Some(msg) = dup_field(&e) {
                return Err(AppError::Conflict(msg));
            }
            return Err(e.into());
        }
    };
    body.id = res.inserted_id.as_object_id().map(Id);
    let public = body.into_public().ok_or(AppError::Unauthorized)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(public).unwrap()),
    ))
}

pub async fn update(
    AdminUser(admin): AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    let coll = state.db.collection::<User>(USERS);
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::bad_request("invalid body"))?;
    let admin_id = admin.id.map(|i| i.to_hex());

    // Deactivation guards.
    if obj.get("isActive") == Some(&json!(false)) {
        let target = coll
            .find_one(doc! { "_id": oid })
            .await?
            .ok_or(AppError::NotFound)?;
        if target.id.map(|i| i.to_hex()) == admin_id {
            return Err(AppError::bad_request(
                "You cannot deactivate your own account",
            ));
        }
        if target.role == "admin" {
            return Err(AppError::bad_request(
                "You cannot deactivate other admin accounts",
            ));
        }
    }
    if coll.find_one(doc! { "_id": oid }).await?.is_none() {
        return Err(AppError::NotFound);
    }

    let mut set = Document::new();
    let mut unset = Document::new();
    if let Some(v) = obj.get("username").and_then(|v| v.as_str()) {
        set.insert("username", v);
    }
    if let Some(v) = obj.get("email").and_then(|v| v.as_str()) {
        set.insert("email", v);
    }
    let mut cleared_dept = false;
    if let Some(v) = obj.get("role").and_then(|v| v.as_str()) {
        set.insert("role", v);
        if v != "operator" {
            unset.insert("departmentId", "");
            cleared_dept = true;
        }
    }
    if !cleared_dept {
        if let Some(v) = obj.get("departmentId").and_then(|v| v.as_str()) {
            if !v.is_empty() {
                set.insert("departmentId", parse_oid(v)?);
            }
        }
    }
    if let Some(v) = obj.get("isActive").and_then(|v| v.as_bool()) {
        set.insert("isActive", v);
    }
    if let Some(p) = obj.get("password").and_then(|v| v.as_str()) {
        if !p.trim().is_empty() {
            set.insert("password", auth::hash_password(p)?);
        }
    }
    set.insert("updatedAt", bson::DateTime::now());

    let mut update_doc = doc! { "$set": set };
    if !unset.is_empty() {
        update_doc.insert("$unset", unset);
    }

    let updated = match coll
        .find_one_and_update(doc! { "_id": oid }, update_doc)
        .return_document(mongodb::options::ReturnDocument::After)
        .await
    {
        Ok(u) => u.ok_or(AppError::NotFound)?,
        Err(e) => {
            if let Some(msg) = dup_field(&e) {
                return Err(AppError::Conflict(msg));
            }
            return Err(e.into());
        }
    };
    let public = updated.into_public().ok_or(AppError::Unauthorized)?;
    Ok(Json(serde_json::to_value(public).unwrap()))
}

pub async fn delete(
    AdminUser(admin): AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    if admin.id.map(|i| i.to_hex()).as_deref() == Some(id.as_str()) {
        return Err(AppError::bad_request("You cannot delete your own account"));
    }
    let oid = parse_oid(&id)?;
    let res = state
        .db
        .collection::<User>(USERS)
        .delete_one(doc! { "_id": oid })
        .await?;
    if res.deleted_count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "message": "User deleted successfully" })))
}
