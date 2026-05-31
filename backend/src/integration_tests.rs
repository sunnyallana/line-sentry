//! Integration tests that exercise the real Axum router against a MongoDB
//! instance (no network bind — requests are driven via `tower`'s `oneshot`).
//!
//! Requires a reachable MongoDB; set `MONGODB_TEST_URI` or default to
//! `mongodb://localhost:27017`. Each test uses its own throwaway database.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use bson::{doc, oid::ObjectId};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::config::Config;
use crate::models::{MACHINES, PRODUCTION_RECORDS, SENSORS, SENSOR_PIN_MAPPINGS};
use crate::ratelimit::RateLimiter;
use crate::state::AppState;
use crate::{build_router, db, pipeline, realtime};

fn test_config(db_name: &str) -> Config {
    Config {
        bind_addr: "127.0.0.1:0".into(),
        mongodb_uri: std::env::var("MONGODB_TEST_URI")
            .unwrap_or_else(|_| "mongodb://localhost:27017".into()),
        db_name: db_name.into(),
        jwt_secret: "test-secret-0123456789-0123456789-0123456789".into(),
        jwt_expires_in: Duration::from_secs(3600),
        daemon_api_key: "test-daemon-key".into(),
        recaptcha_secret: None,
        cors_origins: vec!["http://localhost:5173".into()],
        redis_url: None,
        is_production: false,
        rate_limit_window: Duration::from_secs(900),
        rate_limit_auth_max: 100_000,
        rate_limit_general_max: 100_000,
        factory_offset_minutes: 0,
    }
}

/// Build the app router against a fresh (dropped) test database.
async fn setup(db_name: &str) -> (Router, mongodb::Database) {
    let config = Arc::new(test_config(db_name));
    let db = db::connect(&config).await.expect("connect to MongoDB");
    db.drop().await.ok(); // start clean
    let (_layer, io) = realtime::build();
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        http: reqwest::Client::new(),
        login_rl: Arc::new(RateLimiter::new(config.rate_limit_window, config.rate_limit_auth_max)),
        general_rl: Arc::new(RateLimiter::new(config.rate_limit_window, config.rate_limit_general_max)),
        io,
        pipeline: Arc::new(pipeline::PipelineState::new()),
    };
    (build_router(state), db)
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn get(uri: &str, token: Option<&str>) -> Request<Body> {
    let mut b = Request::builder().method("GET").uri(uri);
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(Body::empty()).unwrap()
}

fn post_json(uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut b = Request::builder().method("POST").uri(uri).header("content-type", "application/json");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn health_reports_ok_when_db_up() {
    let (app, _db) = setup("linesentry_it_health").await;
    let resp = app.oneshot(get("/api/health", None)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["db"], "connected");
}

#[tokio::test]
async fn protected_routes_require_a_token() {
    let (app, _db) = setup("linesentry_it_guard").await;
    let resp = app.oneshot(get("/api/machines", None)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pin_data_requires_the_daemon_key() {
    let (app, _db) = setup("linesentry_it_key").await;
    // No X-API-Key header → rejected.
    let resp = app
        .oneshot(post_json("/api/signals/pin-data", None, json!({ "pinData": "01" })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_login_then_me_roundtrip() {
    let (app, _db) = setup("linesentry_it_auth").await;

    // Seed demo accounts (admin/admin123) — allowed because is_production = false.
    let resp = app.clone().oneshot(post_json("/api/auth/init-demo", None, json!({}))).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app
        .clone()
        .oneshot(post_json("/api/auth/login", None, json!({ "username": "admin", "password": "admin123" })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let token = body_json(resp).await["token"].as_str().unwrap().to_string();
    assert!(!token.is_empty());

    let resp = app.oneshot(get("/api/auth/me", Some(&token))).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let me = body_json(resp).await;
    assert_eq!(me["username"], "admin");
    assert_eq!(me["role"], "admin");
}

#[tokio::test]
async fn signal_pipeline_records_a_unit() {
    let (app, db) = setup("linesentry_it_pipeline").await;

    // Seed a machine with a unit-cycle sensor wired to pin DQ.0.
    let machine_id = ObjectId::new();
    let sensor_id = ObjectId::new();
    db.collection::<bson::Document>(MACHINES)
        .insert_one(doc! {
            "_id": machine_id, "name": "IT Machine", "departmentId": ObjectId::new(),
            "status": "inactive", "isActive": true,
            "position": { "x": 0.0, "y": 0.0 }, "dimensions": { "width": 200.0, "height": 200.0 },
        })
        .await
        .unwrap();
    db.collection::<bson::Document>(SENSORS)
        .insert_one(doc! {
            "_id": sensor_id, "name": "Cycle", "machineId": machine_id,
            "sensorType": "unit-cycle", "isActive": true,
        })
        .await
        .unwrap();
    db.collection::<bson::Document>(SENSOR_PIN_MAPPINGS)
        .insert_one(doc! { "sensorId": sensor_id, "plcId": "default", "pinId": "Q0.0" })
        .await
        .unwrap();

    // Bit 0 set = DQ.0 cycle pulse → a unit should be recorded for the machine.
    let req = Request::builder()
        .method("POST")
        .uri("/api/signals/pin-data")
        .header("content-type", "application/json")
        .header("x-api-key", "test-daemon-key")
        .body(Body::from(json!({ "pinData": "01", "timestamp": "2026-05-31T20:00:00Z" }).to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let v = body_json(resp).await;
    let processed = v["processedMachines"].as_array().expect("processedMachines array");
    assert!(
        processed.iter().any(|m| m.as_str() == Some(machine_id.to_hex().as_str())),
        "expected the machine to be processed, got: {v:?}",
    );

    let count = db
        .collection::<bson::Document>(PRODUCTION_RECORDS)
        .count_documents(doc! { "machineId": machine_id })
        .await
        .unwrap();
    assert!(count >= 1, "expected a production record to be created");
}
