mod auth;
mod config;
mod db;
mod error;
mod models;
mod pipeline;
mod ratelimit;
mod realtime;
mod routes;
mod state;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
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

    // Build the (lazily-connecting) MongoDB handle.
    let db = db::connect(&config).await?;

    // Ensure indexes in the background so a momentarily-unavailable DB doesn't
    // delay serving (non-fatal: a legacy/conflicting index shouldn't block boot).
    {
        let db = db.clone();
        tokio::spawn(async move {
            if let Err(e) = models::ensure_indexes(&db).await {
                tracing::warn!("failed to ensure indexes (will retry on next boot): {e:#}");
            }
        });
    }

    // Socket.IO layer + handle (the handle goes into AppState so handlers emit).
    let (socket_layer, io) = realtime::build();

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
        io,
        pipeline: Arc::new(pipeline::PipelineState::new()),
    };

    // Background monitor: tick ongoing unclassified-stoppage durations every 60s
    // (replaces the per-request setInterval that leaked timers in the Node app).
    {
        let monitor_state = state.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                pipeline::update_ongoing_stoppages(&monitor_state, chrono::Utc::now()).await;
            }
        });
    }

    // CORS and the Socket.IO layer wrap the router from the outside so that
    // CORS headers also apply to the /socket.io/ polling transport.
    let app = build_router(state)
        .layer(socket_layer)
        .layer(build_cors(&config));

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .map_err(|e| anyhow::anyhow!("binding {}: {e}", config.bind_addr))?;
    tracing::info!(
        "LineSentry backend listening on http://{}",
        config.bind_addr
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("shutdown complete");
    Ok(())
}

fn build_router(state: AppState) -> Router {
    // Auth routes; the login route carries the strict per-IP limiter.
    let auth_routes = Router::new()
        .route(
            "/login",
            post(routes::auth::login).route_layer(from_fn_with_state(
                state.clone(),
                ratelimit::login_rate_limit,
            )),
        )
        .route("/me", get(routes::auth::me))
        .route("/init-demo", post(routes::auth::init_demo));

    // Signal routes. /pin-data is guarded by the daemon API key (in-handler);
    // it is exempt from the general rate limiter (high-frequency ingestion).
    let signal_routes = Router::new()
        .route("/pin-data", post(routes::signals::pin_data))
        .route(
            "/unclassified-stoppages-count",
            get(routes::signals::unclassified_stoppages_count),
        )
        .route("/machine/{machineId}/recent", get(routes::signals::recent))
        .route("/", post(routes::signals::post_signal));

    let department_routes = Router::new()
        .route(
            "/",
            get(routes::departments::list).post(routes::departments::create),
        )
        .route("/admin/all", get(routes::departments::admin_all))
        .route(
            "/{id}",
            get(routes::departments::get_one)
                .put(routes::departments::update)
                .delete(routes::departments::delete),
        );

    let machine_routes = Router::new()
        .route(
            "/",
            get(routes::machines::list).post(routes::machines::create),
        )
        .route(
            "/department/{departmentId}",
            get(routes::machines::by_department),
        )
        .route("/{id}/position", patch(routes::machines::position))
        .route(
            "/{id}",
            get(routes::machines::get_one)
                .put(routes::machines::update)
                .delete(routes::machines::delete),
        );

    let sensor_routes = Router::new()
        .route(
            "/",
            get(routes::sensors::list).post(routes::sensors::create),
        )
        .route("/admin/all", get(routes::sensors::admin_all))
        .route("/machine/{machineId}", get(routes::sensors::by_machine))
        .route("/pin-mappings", get(routes::sensors::pin_mappings))
        .route("/pin-mapping", post(routes::sensors::create_pin_mapping))
        .route(
            "/pin-mapping/{id}",
            delete(routes::sensors::delete_pin_mapping),
        )
        .route(
            "/{id}",
            put(routes::sensors::update).delete(routes::sensors::delete),
        );

    let mold_routes = Router::new()
        .route("/", get(routes::molds::list).post(routes::molds::create))
        .route("/admin/all", get(routes::molds::admin_all))
        .route("/{id}/status", patch(routes::molds::toggle_status))
        .route(
            "/{id}",
            put(routes::molds::update).delete(routes::molds::delete),
        );

    let user_routes = Router::new()
        .route("/", get(routes::users::list).post(routes::users::create))
        .route("/admin/all", get(routes::users::admin_all))
        .route(
            "/{id}",
            put(routes::users::update).delete(routes::users::delete),
        );

    let config_routes = Router::new()
        .route("/", get(routes::config::get).put(routes::config::update))
        .route("/shifts", get(routes::config::shifts));

    let analytics_routes = Router::new()
        .route(
            "/production-timeline/{machineId}",
            get(routes::analytics::production_timeline),
        )
        .route(
            "/machine-stats/{machineId}",
            get(routes::analytics::machine_stats),
        )
        .route(
            "/department-stats/{departmentId}",
            get(routes::analytics::department_stats),
        )
        .route("/factory-stats", get(routes::analytics::factory_stats))
        .route("/stoppage", post(routes::analytics::add_stoppage))
        .route(
            "/production-assignment",
            post(routes::analytics::production_assignment),
        );

    let report_routes = Router::new()
        .route("/", get(routes::reports::list))
        .route("/generate", post(routes::reports::generate))
        .route("/{id}", delete(routes::reports::delete))
        .route("/{id}/pdf", get(routes::reports::reports_pdf))
        .route("/{id}/email", post(routes::reports::reports_email));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(ready))
        .nest("/api/auth", auth_routes)
        .nest("/api/signals", signal_routes)
        .nest("/api/departments", department_routes)
        .nest("/api/machines", machine_routes)
        .nest("/api/sensors", sensor_routes)
        .nest("/api/molds", mold_routes)
        .nest("/api/users", user_routes)
        .nest("/api/config", config_routes)
        .nest("/api/analytics", analytics_routes)
        .nest("/api/reports", report_routes)
        // General limiter wraps the whole API (it internally exempts /api/signals
        // and the probes).
        .layer(from_fn_with_state(
            state.clone(),
            ratelimit::general_rate_limit,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
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
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ready": false })),
        )
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
