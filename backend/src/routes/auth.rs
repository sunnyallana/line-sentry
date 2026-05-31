//! Auth routes: `POST /api/auth/login`, `GET /api/auth/me`,
//! `POST /api/auth/init-demo`. Behaviour mirrors the legacy Node routes.

use axum::extract::State;
use axum::Json;
use bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{self, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::{Department, User, DEPARTMENTS, USERS};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LoginReq {
    username: Option<String>,
    password: Option<String>,
    #[serde(rename = "captchaToken")]
    captcha_token: Option<String>,
}

pub async fn login(State(state): State<AppState>, Json(body): Json<LoginReq>) -> AppResult<Json<Value>> {
    let username = body.username.unwrap_or_default();
    let password = body.password.unwrap_or_default();
    if username.is_empty() || password.is_empty() {
        return Err(AppError::bad_request("Username and password are required"));
    }

    // CAPTCHA is mandatory whenever a secret is configured (always in prod).
    if let Some(secret) = &state.config.recaptcha_secret {
        let token = body.captcha_token.as_deref().unwrap_or("");
        if !auth::verify_captcha(&state.http, secret, token).await {
            return Err(AppError::bad_request("CAPTCHA verification failed"));
        }
    }

    let user = state
        .db
        .collection::<User>(USERS)
        .find_one(doc! { "username": &username })
        .await?
        .ok_or_else(|| AppError::Auth("Invalid credentials".into()))?;

    if !auth::verify_password(&password, &user.password) {
        return Err(AppError::Auth("Invalid credentials".into()));
    }
    if !user.is_active {
        return Err(AppError::Auth("Account is deactivated".into()));
    }

    let uid = user.id.ok_or(AppError::Unauthorized)?.to_hex();
    let token = auth::sign_jwt(
        &uid,
        &user.role,
        &state.config.jwt_secret,
        state.config.jwt_expires_in,
    )?;

    let department = populate_department(&state, &user).await?;

    Ok(Json(json!({
        "token": token,
        "user": {
            "id": uid,
            "username": user.username,
            "email": user.email,
            "role": user.role,
            "department": department,
        }
    })))
}

pub async fn me(AuthUser(user): AuthUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let department = populate_department(&state, &user).await?;
    let id_hex = user.id.ok_or(AppError::Unauthorized)?.to_hex();

    Ok(Json(json!({
        "_id": id_hex,
        "id": id_hex,
        "username": user.username,
        "email": user.email,
        "role": user.role,
        "departmentId": user.department_id,
        "department": department,
        "isActive": user.is_active,
    })))
}

/// Seed demo accounts (dev/seed only). Disabled in production.
pub async fn init_demo(State(state): State<AppState>) -> AppResult<Json<Value>> {
    if state.config.is_production {
        return Err(AppError::Forbidden);
    }

    // Upsert the demo department, then read it back to get its id.
    let depts = state.db.collection::<Document>(DEPARTMENTS);
    depts
        .update_one(
            doc! { "name": "Manufacturing Department" },
            doc! { "$set": {
                "name": "Manufacturing Department",
                "description": "Main manufacturing department with injection molding machines",
                "isActive": true,
            }},
        )
        .upsert(true)
        .await?;
    let dept = state
        .db
        .collection::<Department>(DEPARTMENTS)
        .find_one(doc! { "name": "Manufacturing Department" })
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("demo department not found after upsert")))?;
    let dept_id: Bson = dept.id.map(|i| Bson::ObjectId(i.oid())).unwrap_or(Bson::Null);

    let users = state.db.collection::<Document>(USERS);
    let admin_hash = auth::hash_password("admin123")?;
    users
        .update_one(
            doc! { "username": "admin" },
            doc! { "$set": {
                "username": "admin",
                "email": "admin@company.com",
                "password": admin_hash,
                "role": "admin",
                "isActive": true,
            }},
        )
        .upsert(true)
        .await?;

    let operator_hash = auth::hash_password("operator123")?;
    users
        .update_one(
            doc! { "username": "operator" },
            doc! { "$set": {
                "username": "operator",
                "email": "operator@company.com",
                "password": operator_hash,
                "role": "operator",
                "departmentId": dept_id,
                "isActive": true,
            }},
        )
        .upsert(true)
        .await?;

    Ok(Json(json!({ "message": "Demo accounts initialized successfully" })))
}

/// Fetch the user's department document (mirrors Mongoose `.populate`).
async fn populate_department(state: &AppState, user: &User) -> AppResult<Option<Department>> {
    match user.department_id {
        Some(did) => Ok(state
            .db
            .collection::<Department>(DEPARTMENTS)
            .find_one(doc! { "_id": did.oid() })
            .await?),
        None => Ok(None),
    }
}
