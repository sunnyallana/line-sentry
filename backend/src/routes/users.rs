//! User routes (mirrors server/routes/users.js). Password hashing happens here
//! (the Node Mongoose pre-save hook has no equivalent in the Rust driver).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};

use crate::auth::{self, AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::users::{self, DepartmentEdit, Edit, Search, Taken};
use crate::persist::Page;
use crate::routes::common::*;
use crate::state::AppState;

/// A rejected write as the client should see it: a taken username or email
/// is a conflict with a friendly message, anything else a server fault.
fn write_error(e: mongodb::error::Error) -> AppError {
    match users::taken(&e) {
        Some(Taken::Username) => AppError::Conflict("Username already exists".into()),
        Some(Taken::Email) => AppError::Conflict("Email already exists".into()),
        Some(Taken::Other) => AppError::Conflict("Duplicate value".into()),
        None => e.into(),
    }
}

/// Active users (operators see only their department), password stripped.
pub async fn list(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let department = if user.role == users::OPERATOR {
        user.department_id.map(|d| d.oid())
    } else {
        None
    };
    let docs = state.store.users.active_with_department(department).await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn admin_all(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let page = page_of(&q);
    let limit = limit_of(&q);
    let skip = (page - 1) * limit;

    let role = q_str(&q, "role");
    let department = q_str(&q, "department");
    let search = Search {
        text: search_pattern(&q_str(&q, "search")),
        role: (!role.trim().is_empty()).then_some(role),
        department: if department.trim().is_empty() {
            None
        } else {
            Some(parse_oid(&department)?)
        },
        active: match q_str(&q, "isActive").as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
    };
    let sort_by = sort_field(&q);
    let sort_by = if sort_by.is_empty() {
        users::f::CREATED
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
        .users
        .search(search, rows.skip(skip as u64).limit(limit))
        .await?;

    Ok(Json(json!({
        "users": docs_to_json(docs),
        "pagination": pagination(page, limit, total as i64, "totalUsers"),
        "filters": {
            "search": q_str(&q, "search"), "role": q_str(&q, "role"),
            "department": department, "isActive": q_str(&q, "isActive"),
            "sortBy": sort_field(&q), "sortOrder": q_str(&q, "sortOrder"),
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

    let id = state.store.users.create(&body).await.map_err(write_error)?;
    body.id = Some(Id(id));
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
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::bad_request("invalid body"))?;

    let target = state
        .store
        .users
        .by_id(oid)
        .await?
        .ok_or(AppError::NotFound)?;
    // Deactivation guards.
    if obj.get("isActive") == Some(&json!(false)) {
        if target.id.map(|i| i.to_hex()) == admin.id.map(|i| i.to_hex()) {
            return Err(AppError::bad_request(
                "You cannot deactivate your own account",
            ));
        }
        if target.role == users::ADMIN {
            return Err(AppError::bad_request(
                "You cannot deactivate other admin accounts",
            ));
        }
    }

    let text = |key: &str| obj.get(key).and_then(|v| v.as_str());
    let mut edit = Edit {
        username: text("username").map(str::to_string),
        email: text("email").map(str::to_string),
        role: text("role").map(str::to_string),
        active: obj.get("isActive").and_then(|v| v.as_bool()),
        ..Edit::default()
    };
    // Only operators belong to a department.
    edit.department = match (text("role"), text("departmentId")) {
        (Some(role), _) if role != users::OPERATOR => DepartmentEdit::Clear,
        (_, Some(department)) if !department.is_empty() => {
            DepartmentEdit::Assign(parse_oid(department)?)
        }
        _ => DepartmentEdit::Keep,
    };
    if let Some(password) = text("password").filter(|p| !p.trim().is_empty()) {
        edit.password_hash = Some(auth::hash_password(password)?);
    }

    let updated = state
        .store
        .users
        .edit(oid, edit)
        .await
        .map_err(write_error)?
        .ok_or(AppError::NotFound)?;
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
    if !state.store.users.remove(oid).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "message": "User deleted successfully" })))
}
