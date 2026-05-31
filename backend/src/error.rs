//! Unified application error that converts into clean HTTP responses.
//!
//! Client-facing variants carry a safe message; server faults (`Mongo`,
//! `Internal`) are logged in full but always return a generic message so we
//! never leak internals/stack detail to clients.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    /// 401 with a specific client-safe message (e.g. "Invalid credentials").
    #[error("{0}")]
    Auth(String),
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("too many requests")]
    TooManyRequests,
    #[error(transparent)]
    Mongo(#[from] mongodb::error::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError::BadRequest(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError::Conflict(msg.into())
    }

    fn parts(&self) -> (StatusCode, String) {
        match self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".into()),
            AppError::Auth(m) => (StatusCode::UNAUTHORIZED, m.clone()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".into()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found".into()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::TooManyRequests => {
                (StatusCode::TOO_MANY_REQUESTS, "Too many requests".into())
            }
            AppError::Mongo(_) | AppError::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error".into(),
            ),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match &self {
            AppError::Mongo(e) => tracing::error!(error = %e, "database error"),
            AppError::Internal(e) => tracing::error!(error = ?e, "internal error"),
            _ => {}
        }
        let (status, message) = self.parts();
        (status, Json(json!({ "message": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
