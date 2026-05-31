//! Authentication & authorization: JWT, bcrypt, request extractors, the daemon
//! API-key check, and reCAPTCHA verification.

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use bson::doc;
use bson::oid::ObjectId;
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::error::AppError;
use crate::models::{User, USERS};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
    pub exp: usize,
}

pub fn sign_jwt(user_id: &str, role: &str, secret: &str, ttl: Duration) -> Result<String, AppError> {
    let exp = Utc::now().timestamp() as usize + ttl.as_secs() as usize;
    let claims = Claims {
        user_id: user_id.to_string(),
        role: role.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("jwt sign: {e}")))
}

pub fn verify_jwt(token: &str, secret: &str) -> Result<Claims, AppError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized)
}

pub fn hash_password(password: &str) -> Result<String, AppError> {
    bcrypt::hash(password, 12).map_err(|e| AppError::Internal(anyhow::anyhow!("bcrypt: {e}")))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

/// Constant-time comparison for the daemon's `X-API-Key`.
pub fn verify_api_key(provided: &[u8], expected: &[u8]) -> bool {
    if expected.is_empty() || provided.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in provided.iter().zip(expected.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Verify a reCAPTCHA v2 token with Google. Fails closed.
pub async fn verify_captcha(http: &reqwest::Client, secret: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let resp = http
        .post("https://www.google.com/recaptcha/api/siteverify")
        .form(&[("secret", secret), ("response", token)])
        .send()
        .await;
    match resp {
        Ok(r) => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
            .unwrap_or(false),
        Err(e) => {
            tracing::warn!("captcha verification request failed: {e}");
            false
        }
    }
}

fn bearer_token(parts: &Parts) -> Option<&str> {
    parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
}

/// Extractor: an authenticated, active user (any role).
pub struct AuthUser(pub User);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = bearer_token(parts).ok_or(AppError::Unauthorized)?;
        let claims = verify_jwt(token, &state.config.jwt_secret)?;
        let oid = ObjectId::parse_str(&claims.user_id).map_err(|_| AppError::Unauthorized)?;
        let user = state
            .db
            .collection::<User>(USERS)
            .find_one(doc! { "_id": oid })
            .await?
            .ok_or(AppError::Unauthorized)?;
        if !user.is_active {
            return Err(AppError::Unauthorized);
        }
        Ok(AuthUser(user))
    }
}

/// Extractor: an authenticated user with the `admin` role.
pub struct AdminUser(pub User);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;
        if user.role != "admin" {
            return Err(AppError::Forbidden);
        }
        Ok(AdminUser(user))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_compare_is_correct() {
        assert!(verify_api_key(b"secret-key", b"secret-key"));
        assert!(!verify_api_key(b"secret-key", b"secret-keys"));
        assert!(!verify_api_key(b"", b"expected"));
        assert!(!verify_api_key(b"provided", b"")); // empty expected always fails
        assert!(!verify_api_key(b"wrong", b"right"));
    }

    #[test]
    fn jwt_round_trip() {
        let secret = "test-secret";
        let token = sign_jwt("65a1f2c3d4e5f60718293a4b", "admin", secret, Duration::from_secs(60))
            .unwrap();
        let claims = verify_jwt(&token, secret).unwrap();
        assert_eq!(claims.user_id, "65a1f2c3d4e5f60718293a4b");
        assert_eq!(claims.role, "admin");
        assert!(verify_jwt(&token, "wrong-secret").is_err());
    }

    #[test]
    fn password_hash_and_verify() {
        let hash = hash_password("hunter2").unwrap();
        assert!(verify_password("hunter2", &hash));
        assert!(!verify_password("wrong", &hash));
    }
}
