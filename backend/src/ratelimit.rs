//! Lightweight in-memory fixed-window rate limiter + Axum middleware.
//!
//! Matches the Node server's semantics (per-IP fixed window). For multi-instance
//! deployments this can later be swapped for a Redis-backed limiter; the
//! middleware seam stays the same.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

use crate::error::AppError;
use crate::state::AppState;

pub struct RateLimiter {
    window: Duration,
    max: u32,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(window: Duration, max: u32) -> Self {
        Self {
            window,
            max,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `true` if the request is allowed (and records it), `false` if the
    /// caller has exceeded `max` within the current window.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();

        // Opportunistic cleanup so the map can't grow without bound.
        if buckets.len() > 10_000 {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }

        let entry = buckets.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.max {
            return false;
        }
        entry.1 += 1;
        true
    }
}

/// Best-effort client identity: first `X-Forwarded-For` hop, then `X-Real-IP`.
/// (`trust proxy` is the deployment's responsibility — set these at nginx.)
fn client_key(req: &Request) -> String {
    let headers = req.headers();
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            let ip = first.trim();
            if !ip.is_empty() {
                return ip.to_string();
            }
        }
    }
    if let Some(rip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if !rip.is_empty() {
            return rip.to_string();
        }
    }
    "unknown".to_string()
}

/// Strict limiter for the login route.
pub async fn login_rate_limit(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let key = format!("login:{}", client_key(&req));
    if !state.login_rl.check(&key) {
        return Err(AppError::TooManyRequests);
    }
    Ok(next.run(req).await)
}

/// General limiter for the rest of the API. The daemon's high-frequency
/// `/api/signals` ingestion and the health/readiness probes are exempt.
pub async fn general_rate_limit(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let path = req.uri().path();
    if path.starts_with("/api/signals") || path == "/api/health" || path == "/api/ready" {
        return Ok(next.run(req).await);
    }
    let key = format!("gen:{}", client_key(&req));
    if !state.general_rl.check(&key) {
        return Err(AppError::TooManyRequests);
    }
    Ok(next.run(req).await)
}
