mod auth;
mod config;
mod db;
mod error;
mod models;
mod ratelimit;
mod routes;
mod state;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use mongodb::Database;
use serde_json::json;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::ratelimit::RateLimiter;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Arc::new(Config::from_env().inspect_err(|e| {
        eprintln!("FATAL: {e}");
    })?);

    // Connect to MongoDB, retrying with backoff until it is reachable.
    let db = connect_with_retry(&config).await;

    // Ensure indexes (non-fatal: a conflicting/legacy index shouldn't block boot).
    if let Err(e) = models::ensure_indexes(&db).await {
        tracing::warn!("failed to ensure indexes: {e:#}");
    }

    let state = AppState {
        db,
        config: config.clone(),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?,
        login_rl: Arc::new(RateLimiter::new(
            config.rate_limit_window,
            config.rate_limit_auth_max,
        )),
        general_rl: Arc::new(RateLimiter::new(
            config.rate_limit_window,
            config.rate_limit_general_max,
        )),
    };

    let app = build_router(state, &config);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .map_err(|e| anyhow::anyhow!("binding {}: {e}", config.bind_addr))?;
    tracing::info!("LineSentry backend listening on http://{}", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("shutdown complete");
    Ok(())
}

fn build_router(state: AppState, config: &Config) -> Router {
    // Auth routes; the login route carries the strict per-IP limiter.
    let auth_routes = Router::new()
        .route(
            "/login",
            post(routes::auth::login)
                .route_layer(from_fn_with_state(state.clone(), ratelimit::login_rate_limit)),
        )
        .route("/me", get(routes::auth::me))
        .route("/init-demo", post(routes::auth::init_demo));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(ready))
        .nest("/api/auth", auth_routes)
        // General limiter wraps the whole API (it internally exempts /api/signals
        // and the probes).
        .layer(from_fn_with_state(state.clone(), ratelimit::general_rate_limit))
        .layer(TraceLayer::new_for_http())
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
        .layer(build_cors(config))
        .with_state(state)
}

fn build_cors(config: &Config) -> CorsLayer {
    let origins: Vec<HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|o| o.parse::<HeaderValue>().ok())
        .collect();

    CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
        ])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
            HeaderName::from_static("x-requested-with"),
            HeaderName::from_static("x-api-key"),
        ])
        .allow_credentials(true)
        .allow_origin(origins)
}

/// Liveness + DB-aware health (mirrors the Node server's `/api/health`).
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db_up = db::ping(&state.db).await;
    let status = if db_up {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "status": if db_up { "OK" } else { "DEGRADED" },
            "db": if db_up { "connected" } else { "disconnected" },
        })),
    )
}

/// Readiness probe — ready only when the database answers.
async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    if db::ping(&state.db).await {
        (StatusCode::OK, Json(json!({ "ready": true })))
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ready": false })))
    }
}

async fn connect_with_retry(config: &Config) -> Database {
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        match db::connect(config).await {
            Ok(db) => {
                tracing::info!("connected to MongoDB");
                return db;
            }
            Err(e) => {
                let delay = std::cmp::min(30, 2u64.pow(attempt.min(5)));
                tracing::error!(
                    "MongoDB connection failed (attempt {attempt}): {e:#}. retrying in {delay}s"
                );
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
        }
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,linesentry_backend=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
