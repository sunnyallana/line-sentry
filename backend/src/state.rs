//! Shared application state passed to every handler via Axum's `State`.

use std::sync::Arc;

use mongodb::Database;

use crate::config::Config;
use crate::pipeline::PipelineState;
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
    /// Socket.IO handle for emitting real-time events.
    pub io: socketioxide::SocketIo,
    /// Shared in-memory state for the signal pipeline.
    pub pipeline: Arc<PipelineState>,
}
