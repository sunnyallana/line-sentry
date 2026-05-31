//! Shared application state passed to every handler via Axum's `State`.

use std::sync::Arc;

use mongodb::Database;

use crate::config::Config;
use crate::ratelimit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub config: Arc<Config>,
    /// HTTP client reused for outbound calls (e.g. reCAPTCHA verification).
    pub http: reqwest::Client,
    /// Strict per-IP limiter applied to the login route.
    pub login_rl: Arc<RateLimiter>,
    /// General per-IP limiter applied to the rest of the API.
    pub general_rl: Arc<RateLimiter>,
}
