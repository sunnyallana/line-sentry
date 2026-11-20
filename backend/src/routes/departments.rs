//! Department routes (mirrors server/routes/departments.js).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::departments::{self, Search};
use crate::persist::users::OPERATOR;
use crate::persist::Page;
use crate::routes::common::*;
use crate::state::AppState;

/// Active departments (operator-scoped), each with its machines + machineCount.
pub async fn list(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let only = if user.role == OPERATOR {
        user.department_id.map(|d| d.oid())
    } else {
        None
    };
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|l| *l > 0);
    let docs = state
        .store
        .departments
        .active_with_machines(only, limit)
        .await?;
    Ok(Json(docs_to_json(docs)))
}

/// Paginated departments for admin (with machineCount).
pub async fn admin_all(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let page = page_of(&q);
    let limit = limit_of(&q);
    let skip = (page - 1) * limit;

    let search = Search {
        text: search_pattern(&q_str(&q, "search")),
        // Any value but "true" narrows to the inactive ones.
        active: match q_str(&q, "isActive").as_str() {
            "" => None,
            v => Some(v == "true"),
        },
    };
    let sort_by = sort_field(&q);
    let sort_by = if sort_by.is_empty() {
        departments::f::CREATED
    } else {
        &sort_by
    };
    let rows = if q_str(&q, "sortOrder") == "asc" {
        Page::all().ascending(sort_by)
    } else {
        Page::all().descending(sort_by)
    };

    let (docs, total) = state
        .store
        .departments
        .search(search, rows.skip(skip as u64).limit(limit))
        .await?;

    Ok(Json(json!({
        "departments": docs_to_json(docs),
        "pagination": pagination(page, limit, total as i64, "totalDepartments"),
        "filters": {
            "search": q_str(&q, "search"),
            "isActive": q_str(&q, "isActive"),
            "sortBy": sort_field(&q),
            "sortOrder": q_str(&q, "sortOrder"),
        }
    })))
}

/// The pattern that finds what a person typed, taken literally, or `None`
/// when they typed nothing.
fn search_pattern(typed: &str) -> Option<String> {
    let typed = typed.trim();
    if typed.is_empty() {
        return None;
    }
    let capped: String = typed.chars().take(100).collect();
    Some(escape_regex(&capped))
}

/// One department with its active machines (operator-scoped).
pub async fn get_one(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    if user.role == OPERATOR && user.department_id.map(|d| d.oid()) != Some(oid) {
        return Err(AppError::Forbidden);
    }
    let dept = state
        .store
        .departments
        .with_machines(oid)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(doc_to_json(dept)))
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
    body.id = Some(Id(state.store.departments.create(&body).await?));
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Department>,
) -> AppResult<Json<Department>> {
    let oid = parse_oid(&id)?;
    let now = Utc::now();
    let stored = state
        .store
        .departments
        .edit(oid, &body, now)
        .await?
        .ok_or(AppError::NotFound)?;
    body.id = Some(Id(oid));
    body.created_at = stored.created_at;
    body.updated_at = Some(now);
    Ok(Json(body))
}

/// Delete a department and cascade to its machines + molds.
pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    if !state.store.departments.remove_with_contents(oid).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({
        "message": "Department, associated machines, and associated molds deleted successfully"
    })))
}
