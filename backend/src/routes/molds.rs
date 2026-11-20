//! Mold routes (mirrors server/routes/molds.js).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::molds::Listing;
use crate::persist::sensors::Slice;
use crate::persist::Filter;
use crate::routes::common::*;
use crate::state::AppState;

/// Active molds (operator-scoped), department populated.
pub async fn list(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let department = if user.role == "operator" {
        user.department_id.map(|d| d.oid())
    } else {
        None
    };
    let docs = state.store.molds.active_with_department(department).await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn admin_all(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let page = page_of(&q);
    let limit = limit_of(&q);

    let search = q_str(&q, "search");
    let pattern: String = search.trim().chars().take(100).collect();
    let pattern = (!pattern.is_empty()).then(|| escape_regex(&pattern));
    let department = q_str(&q, "department");
    let is_active = q_str(&q, "isActive");
    let (sort_by, sort_order) = (sort_field(&q), q_str(&q, "sortOrder"));

    let listing = Listing {
        search: pattern.as_deref(),
        department: if department.trim().is_empty() {
            None
        } else {
            Some(parse_oid(&department)?)
        },
        active: match is_active.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        slice: Slice {
            sort_by: &sort_by,
            ascending: sort_order == "asc",
            skip: (page - 1) * limit,
            limit,
        },
    };
    let (docs, total) = state.store.molds.admin_page(&listing).await?;

    Ok(Json(json!({
        "molds": docs_to_json(docs),
        "pagination": pagination(page, limit, total, "totalMolds"),
        "filters": {
            "search": search, "department": department,
            "isActive": is_active,
            "sortBy": sort_by, "sortOrder": sort_order,
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
    body.id = Some(Id(state.store.molds.rows.insert(&body).await?));
    Ok((StatusCode::CREATED, Json(body)))
}

pub async fn update(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<Mold>,
) -> AppResult<Json<Mold>> {
    let oid = parse_oid(&id)?;
    let molds = &state.store.molds;
    let existing = molds.rows.get(oid).await?.ok_or(AppError::NotFound)?;
    molds.edit(oid, &body).await?;
    body.id = Some(Id(oid));
    body.created_at = existing.created_at;
    body.updated_at = Some(Utc::now());
    Ok(Json(body))
}

pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = parse_oid(&id)?;
    if state.store.molds.rows.delete(Filter::id(oid)).await? == 0 {
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
    let molds = &state.store.molds;
    let mut mold = molds.rows.get(oid).await?.ok_or(AppError::NotFound)?;
    mold.is_active = !mold.is_active;
    mold.updated_at = Some(Utc::now());
    molds.set_active(oid, mold.is_active).await?;
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
