//! Integration tests that exercise the real Axum router against a MongoDB
//! instance (no network bind — requests are driven via `tower`'s `oneshot`).
//!
//! Requires a reachable MongoDB; set `MONGODB_TEST_URI` or default to
//! `mongodb://localhost:27017`. Each test uses its own throwaway database.
//!
//! Like feature code, the tests reach the database only through the
//! persisters: they seed typed rows and read them back with `Filter`.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use bson::{doc, oid::ObjectId};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::config::Config;
use crate::lease::{Lease, RunRecord};
use crate::models::{
    HourlyData, Id, Machine, Mold, Plc, ProductionRecord, Sensor, SensorPinMapping, Stoppage,
};
use crate::persist::{machines, pins, records, reports, sensors, Changes, Filter, Store};
use crate::pulse::{self, Done, Job, Outcome};
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
        pulse_enabled: false,
    }
}

/// Build the app router against a fresh (dropped) test database. The state
/// comes back too, so a test can seed and read through its store.
async fn setup(db_name: &str) -> (Router, AppState) {
    let state = setup_state(db_name, 0).await;
    (build_router(state.clone()), state)
}

/// App state against a fresh (dropped) test database, for tests that call the
/// background jobs directly.
async fn setup_state(db_name: &str, factory_offset_minutes: i64) -> AppState {
    let mut config = test_config(db_name);
    config.factory_offset_minutes = factory_offset_minutes;
    let config = Arc::new(config);
    let store = Arc::new(Store::new(
        db::connect(&config).await.expect("connect to MongoDB"),
    ));
    store.drop_everything().await.expect("start clean");
    // Use the server's own batch strategy, so the suite covers `bulkWrite`
    // when it runs against MongoDB 8 and concurrent writes on older servers.
    store
        .detect_capabilities()
        .await
        .expect("ask the server what it supports");
    state_on(store, config)
}

/// App state with its own memory on the given store.
fn state_on(store: Arc<Store>, config: Arc<Config>) -> AppState {
    let (_layer, io) = realtime::build();
    AppState {
        http: reqwest::Client::new(),
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
        store,
        config,
        pulse: Arc::new(crate::pulse::Pulse::new()),
    }
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
    send_json("POST", uri, token, body)
}

fn send_json(method: &str, uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(Body::from(body.to_string())).unwrap()
}

fn delete(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("DELETE")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

/// Send a request and return the status with the JSON body.
async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let resp = app.clone().oneshot(request).await.unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

// ── Seeding and reading through the persisters ───────────────────────────────

fn machine_row(id: ObjectId, name: &str, department: ObjectId, status: &str) -> Machine {
    Machine {
        id: Some(Id(id)),
        name: name.into(),
        description: None,
        department_id: Id(department),
        position: None,
        dimensions: None,
        status: status.into(),
        status_since: None,
        is_active: true,
        created_at: None,
        updated_at: None,
    }
}

fn mold_row(id: ObjectId, name: &str, per_hour: f64, department: ObjectId) -> Mold {
    Mold {
        id: Some(Id(id)),
        name: name.into(),
        description: None,
        production_capacity_per_hour: per_hour,
        department_id: Id(department),
        is_active: true,
        created_at: None,
        updated_at: None,
    }
}

/// A sensor of `sensor_type` on the machine, wired to `pin` of `plc`.
async fn wire_sensor(
    store: &Store,
    name: &str,
    machine: ObjectId,
    sensor_type: &str,
    plc: &str,
    pin: &str,
) -> ObjectId {
    let sensor = ObjectId::new();
    store
        .sensors
        .rows
        .insert(&Sensor {
            id: Some(Id(sensor)),
            name: name.into(),
            description: None,
            machine_id: Id(machine),
            sensor_type: sensor_type.into(),
            is_active: true,
            created_at: None,
            updated_at: None,
        })
        .await
        .unwrap();
    store
        .pins
        .rows
        .insert(&SensorPinMapping {
            id: None,
            sensor_id: Id(sensor),
            plc_id: plc.into(),
            pin_id: pin.into(),
        })
        .await
        .unwrap();
    sensor
}

/// A machine with one sensor of `sensor_type` wired to `pin` on each of `plcs`.
async fn seed_machine(
    store: &Store,
    status: &str,
    sensor_type: &str,
    plcs: &[&str],
    pin: &str,
) -> ObjectId {
    let machine = ObjectId::new();
    store
        .machines
        .rows
        .insert(&machine_row(machine, "M", ObjectId::new(), status))
        .await
        .unwrap();
    for plc in plcs {
        wire_sensor(store, "S", machine, sensor_type, plc, pin).await;
    }
    machine
}

async fn seed_plc(store: &Store, plc_id: &str, last_seen: Option<chrono::DateTime<chrono::Utc>>) {
    store
        .plcs
        .rows
        .insert(&Plc {
            id: None,
            plc_id: plc_id.into(),
            name: plc_id.into(),
            ip: None,
            rack: 0,
            slot: 1,
            byte_count: 1,
            is_active: true,
            last_seen_at: last_seen,
            created_at: None,
            updated_at: None,
        })
        .await
        .unwrap();
}

async fn stored_machine(store: &Store, id: ObjectId) -> Machine {
    store
        .machines
        .rows
        .get(id)
        .await
        .unwrap()
        .expect("the machine")
}

async fn machine_status(store: &Store, id: ObjectId) -> String {
    stored_machine(store, id).await.status
}

/// The production records of one machine.
fn records_of(machine: ObjectId) -> Filter {
    Filter::all().eq(records::f::MACHINE, machine)
}

async fn todays_record(store: &Store, machine: ObjectId) -> ProductionRecord {
    store
        .records
        .rows
        .find_one(records_of(machine))
        .await
        .unwrap()
        .expect("a production record")
}

fn first_hour(rec: &ProductionRecord) -> &HourlyData {
    &rec.hourly_data[0]
}

fn hour_of(rec: &ProductionRecord, hour: i64) -> &HourlyData {
    rec.hourly_data
        .iter()
        .find(|h| h.hour as i64 == hour)
        .unwrap_or_else(|| panic!("no hour {hour} in {rec:?}"))
}

#[tokio::test]
async fn health_reports_ok_when_db_up() {
    let (app, _state) = setup("linesentry_it_health").await;
    let resp = app.oneshot(get("/api/health", None)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["db"], "connected");
}

#[tokio::test]
async fn protected_routes_require_a_token() {
    let (app, _state) = setup("linesentry_it_guard").await;
    let resp = app.oneshot(get("/api/machines", None)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pin_data_requires_the_daemon_key() {
    let (app, _state) = setup("linesentry_it_key").await;
    // No X-API-Key header → rejected.
    let resp = app
        .oneshot(post_json(
            "/api/signals/pin-data",
            None,
            json!({ "pinData": "01" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_login_then_me_roundtrip() {
    let (app, _state) = setup("linesentry_it_auth").await;

    // Seed demo accounts (admin/admin123) — allowed because is_production = false.
    let resp = app
        .clone()
        .oneshot(post_json("/api/auth/init-demo", None, json!({})))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            None,
            json!({ "username": "admin", "password": "admin123" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let token = body_json(resp).await["token"].as_str().unwrap().to_string();
    assert!(!token.is_empty());

    let resp = app
        .oneshot(get("/api/auth/me", Some(&token)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let me = body_json(resp).await;
    assert_eq!(me["username"], "admin");
    assert_eq!(me["role"], "admin");
}

#[tokio::test]
async fn signal_pipeline_records_a_unit() {
    let (app, state) = setup("linesentry_it_pipeline").await;
    let store = &state.store;

    // Seed a machine with a unit-cycle sensor wired to pin DQ.0.
    let machine_id = ObjectId::new();
    store
        .machines
        .rows
        .insert(&Machine {
            position: Some(crate::models::Position { x: 0.0, y: 0.0 }),
            dimensions: Some(crate::models::Dimensions {
                width: 200.0,
                height: 200.0,
            }),
            ..machine_row(machine_id, "IT Machine", ObjectId::new(), "inactive")
        })
        .await
        .unwrap();
    wire_sensor(
        store,
        "Cycle",
        machine_id,
        sensors::UNIT_CYCLE,
        "default",
        "Q0.0",
    )
    .await;

    // Bit 0 set = DQ.0 cycle pulse → a unit should be recorded for the machine.
    let req = Request::builder()
        .method("POST")
        .uri("/api/signals/pin-data")
        .header("content-type", "application/json")
        .header("x-api-key", "test-daemon-key")
        .body(Body::from(
            json!({ "pinData": "01", "timestamp": "2026-05-31T20:00:00Z" }).to_string(),
        ))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let v = body_json(resp).await;
    let processed = v["processedMachines"]
        .as_array()
        .expect("processedMachines array");
    assert!(
        processed
            .iter()
            .any(|m| m.as_str() == Some(machine_id.to_hex().as_str())),
        "expected the machine to be processed, got: {v:?}",
    );

    let count = store
        .records
        .rows
        .count(records_of(machine_id))
        .await
        .unwrap();
    assert!(count >= 1, "expected a production record to be created");
}

// ── Leases ───────────────────────────────────────────────────────────────────

async fn lease_row(state: &AppState, name: &str) -> bson::Document {
    state
        .store
        .leases
        .get(name)
        .await
        .unwrap()
        .expect("lease row")
}

fn ok_run<'a>(detail: &'a str, cursor: Option<&'a str>) -> RunRecord<'a> {
    RunRecord {
        ok: true,
        detail,
        cursor,
    }
}

#[tokio::test]
async fn a_lease_has_one_holder_until_it_is_freed() {
    let state = setup_state("linesentry_it_lease_one", 0).await;
    let ttl = Duration::from_secs(60);

    let first = Lease::try_take(&state.store, "job", "a", ttl)
        .await
        .unwrap();
    let second = Lease::try_take(&state.store, "job", "b", ttl)
        .await
        .unwrap();
    assert!(first.is_some(), "a free lease must be taken");
    assert!(second.is_none(), "a held lease must not be taken again");

    assert!(first.unwrap().finish(ok_run("done", None)).await.unwrap());
    let third = Lease::try_take(&state.store, "job", "b", ttl)
        .await
        .unwrap();
    assert!(third.is_some(), "a freed lease must be takeable");
    assert_eq!(
        lease_row(&state, "job").await.get_str("holder").unwrap(),
        "b"
    );
}

#[tokio::test]
async fn only_one_of_many_concurrent_takers_gets_the_lease() {
    let state = setup_state("linesentry_it_lease_race", 0).await;
    let takers = (0..12).map(|i| {
        let store = state.store.clone();
        async move {
            Lease::try_take(
                &store,
                "race",
                &format!("instance-{i}"),
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .is_some()
        }
    });
    let winners = futures::future::join_all(takers)
        .await
        .into_iter()
        .filter(|won| *won)
        .count();
    assert_eq!(winners, 1);
}

#[tokio::test]
async fn an_expired_lease_is_taken_over_and_the_old_holder_is_locked_out() {
    let state = setup_state("linesentry_it_lease_expiry", 0).await;

    let stale = Lease::try_take(&state.store, "job", "a", Duration::from_millis(200))
        .await
        .unwrap()
        .expect("first take");
    tokio::time::sleep(Duration::from_millis(600)).await;
    let fresh = Lease::try_take(&state.store, "job", "b", Duration::from_secs(60))
        .await
        .unwrap();
    assert!(fresh.is_some(), "an expired lease must be takeable");

    assert!(
        !stale.renew().await.unwrap(),
        "the old holder must not renew"
    );
    assert!(
        !stale
            .finish(ok_run("late", Some("2026-01-09")))
            .await
            .unwrap(),
        "the old holder must not record a run"
    );
    let row = lease_row(&state, "job").await;
    assert_eq!(row.get_str("holder").unwrap(), "b");
    assert!(
        row.get_str("cursor").is_err(),
        "the late run must leave no cursor"
    );
}

#[tokio::test]
async fn renewing_keeps_a_lease_past_its_first_expiry() {
    let state = setup_state("linesentry_it_lease_renew", 0).await;
    let held = Lease::try_take(&state.store, "job", "a", Duration::from_millis(800))
        .await
        .unwrap()
        .expect("take");
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(held.renew().await.unwrap());
    }
    let other = Lease::try_take(&state.store, "job", "b", Duration::from_secs(60))
        .await
        .unwrap();
    assert!(other.is_none(), "a renewed lease must still be held");
}

#[tokio::test]
async fn the_lease_cursor_only_moves_forward() {
    let state = setup_state("linesentry_it_lease_cursor", 0).await;
    let ttl = Duration::from_secs(60);
    for (written, expected) in [
        (Some("2026-01-05"), Some("2026-01-05")),
        (Some("2026-01-03"), Some("2026-01-05")),
        (None, Some("2026-01-05")),
        (Some("$cursor"), Some("2026-01-05")),
        (Some("2026-01-06"), Some("2026-01-06")),
    ] {
        let lease = Lease::try_take(&state.store, "job", "a", ttl)
            .await
            .unwrap()
            .unwrap();
        assert!(lease.finish(ok_run("x", written)).await.unwrap());
        let next = Lease::try_take(&state.store, "job", "a", ttl)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            next.cursor.as_deref(),
            expected,
            "after writing {written:?}"
        );
        assert!(next.finish(ok_run("x", None)).await.unwrap());
    }
}

// ── Pulse ────────────────────────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

fn leased_job(
    name: &'static str,
    ttl: Duration,
    run: fn(AppState, Option<String>) -> pulse::JobFuture,
) -> Job {
    Job {
        name,
        every: Duration::from_secs(60),
        lease: Some(ttl),
        run,
    }
}

#[tokio::test]
async fn a_leased_job_does_not_run_while_another_instance_holds_the_lease() {
    static RUNS: AtomicU32 = AtomicU32::new(0);
    let state = setup_state("linesentry_it_pulse_held", 0).await;
    let job = leased_job("held-job", Duration::from_secs(60), |_, _| {
        Box::pin(async {
            RUNS.fetch_add(1, Ordering::SeqCst);
            Ok(Done::new("ran").with_cursor("c1"))
        })
    });

    let other = Lease::try_take(&state.store, "held-job", "other", Duration::from_secs(60))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        pulse::run_once(&state, &job).await,
        Outcome::HeldElsewhere
    ));
    assert_eq!(RUNS.load(Ordering::SeqCst), 0);

    assert!(other.finish(ok_run("done", None)).await.unwrap());
    assert!(matches!(
        pulse::run_once(&state, &job).await,
        Outcome::Ran(_)
    ));
    assert_eq!(RUNS.load(Ordering::SeqCst), 1);

    let row = lease_row(&state, "held-job").await;
    assert_eq!(row.get_str("lastStatus").unwrap(), "ok");
    assert_eq!(row.get_str("lastDetail").unwrap(), "ran");
    assert_eq!(row.get_str("cursor").unwrap(), "c1");
    assert_eq!(row.get_str("holder").unwrap(), state.pulse.instance);
}

#[tokio::test]
async fn a_failed_run_is_recorded_frees_the_lease_and_keeps_the_cursor() {
    static FAIL: AtomicBool = AtomicBool::new(false);
    let state = setup_state("linesentry_it_pulse_fail", 0).await;
    let job = leased_job("flaky-job", Duration::from_secs(60), |_, cursor| {
        Box::pin(async move {
            if FAIL.load(Ordering::SeqCst) {
                anyhow::bail!("smtp is down");
            }
            Ok(Done::new(format!("saw {cursor:?}")).with_cursor("day-1"))
        })
    });

    assert!(matches!(
        pulse::run_once(&state, &job).await,
        Outcome::Ran(_)
    ));
    FAIL.store(true, Ordering::SeqCst);
    match pulse::run_once(&state, &job).await {
        Outcome::Failed(e) => assert!(e.contains("smtp is down"), "{e}"),
        _ => panic!("expected the run to fail"),
    }
    let row = lease_row(&state, "flaky-job").await;
    assert_eq!(row.get_str("lastStatus").unwrap(), "failed");
    assert_eq!(row.get_str("lastDetail").unwrap(), "smtp is down");
    assert_eq!(row.get_str("cursor").unwrap(), "day-1");

    FAIL.store(false, Ordering::SeqCst);
    match pulse::run_once(&state, &job).await {
        Outcome::Ran(done) => assert_eq!(done.detail, "saw Some(\"day-1\")"),
        _ => panic!("the lease must be free after a failed run"),
    }
}

#[tokio::test]
async fn work_stops_when_the_lease_is_lost_mid_run() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    static FINISHED: AtomicBool = AtomicBool::new(false);
    let state = setup_state("linesentry_it_pulse_lost", 0).await;
    let job = leased_job("long-job", Duration::from_millis(400), |_, _| {
        Box::pin(async {
            STARTED.store(true, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(5)).await;
            FINISHED.store(true, Ordering::SeqCst);
            Ok(Done::new("finished"))
        })
    });

    let run_state = state.clone();
    let run = tokio::spawn(async move { pulse::run_once(&run_state, &job).await });
    while !STARTED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Another instance takes the row over, as it would after an expiry.
    state.store.leases.steal("long-job", "thief").await.unwrap();

    let outcome = tokio::time::timeout(Duration::from_secs(3), run)
        .await
        .expect("the run must stop soon after the lease is lost")
        .unwrap();
    assert!(matches!(outcome, Outcome::LeaseLost));
    assert!(
        !FINISHED.load(Ordering::SeqCst),
        "the work must have been stopped"
    );
    assert_eq!(
        lease_row(&state, "long-job")
            .await
            .get_str("holder")
            .unwrap(),
        "thief"
    );
}

#[tokio::test]
async fn pulse_status_is_admin_only() {
    let (app, _state) = setup("linesentry_it_pulse_status").await;
    let resp = app.clone().oneshot(get("/api/pulse", None)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    app.clone()
        .oneshot(post_json("/api/auth/init-demo", None, json!({})))
        .await
        .unwrap();
    let resp = app
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            None,
            json!({ "username": "admin", "password": "admin123" }),
        ))
        .await
        .unwrap();
    let token = body_json(resp).await["token"].as_str().unwrap().to_string();
    let resp = app.oneshot(get("/api/pulse", Some(&token))).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["enabled"], false);
    assert!(body["leases"].is_array());
}

// ── Silent-PLC sweep ─────────────────────────────────────────────────────────

#[tokio::test]
async fn the_sweep_idles_only_machines_whose_every_plc_went_silent() {
    let state = setup_state("linesentry_it_sweep", 0).await;
    let store = &state.store;
    let now = chrono::Utc::now();
    // Default timeouts are 5 min (power) and 2 min (cycle): silent after 5.
    seed_plc(store, "dead", Some(now - chrono::Duration::minutes(6))).await;
    seed_plc(store, "alive", Some(now - chrono::Duration::minutes(4))).await;
    seed_plc(store, "never-stamped", None).await;

    let on_dead = seed_machine(store, "running", "power", &["dead"], "Q0.0").await;
    let on_alive = seed_machine(store, "running", "power", &["alive"], "Q0.0").await;
    let on_both = seed_machine(store, "stoppage", "power", &["dead", "alive"], "Q0.1").await;
    let on_new = seed_machine(store, "running", "power", &["never-stamped"], "Q0.0").await;
    let unknown_plc = seed_machine(store, "running", "power", &["not-registered"], "Q0.0").await;

    assert_eq!(pipeline::sweep_silent_plcs(&state, now).await.unwrap(), 1);
    assert_eq!(machine_status(store, on_dead).await, "inactive");
    assert_eq!(machine_status(store, on_alive).await, "running");
    assert_eq!(machine_status(store, on_both).await, "stoppage");
    assert_eq!(machine_status(store, on_new).await, "running");
    assert_eq!(machine_status(store, unknown_plc).await, "running");

    // Nothing left to change on the next round.
    assert_eq!(pipeline::sweep_silent_plcs(&state, now).await.unwrap(), 0);

    // The never-stamped PLC got its clock started by the first sweep, so it
    // counts as silent once the timeout has passed from then.
    let later = now + chrono::Duration::minutes(6);
    assert_eq!(pipeline::sweep_silent_plcs(&state, later).await.unwrap(), 3);
    assert_eq!(machine_status(store, on_new).await, "inactive");
    assert_eq!(machine_status(store, unknown_plc).await, "running");
}

#[tokio::test]
async fn a_posting_plc_is_stamped_and_survives_the_sweep() {
    let state = setup_state("linesentry_it_seen", 0).await;
    let store = &state.store;
    let stale = chrono::Utc::now() - chrono::Duration::minutes(30);
    seed_plc(store, "line-1", Some(stale)).await;
    let machine = seed_machine(store, "inactive", "power", &["line-1"], "Q0.0").await;

    pipeline::process_pin_data(&state, "line-1", "01", None)
        .await
        .unwrap();
    assert_eq!(machine_status(store, machine).await, "stoppage");

    let plc = store
        .plcs
        .rows
        .find_one(Filter::all().eq(crate::persist::plcs::f::PLC_ID, "line-1"))
        .await
        .unwrap()
        .unwrap();
    let seen = plc.last_seen_at.unwrap();
    assert!(
        seen > stale + chrono::Duration::minutes(29),
        "lastSeenAt must be refreshed"
    );

    assert_eq!(
        pipeline::sweep_silent_plcs(&state, chrono::Utc::now())
            .await
            .unwrap(),
        0
    );
    assert_eq!(machine_status(store, machine).await, "stoppage");
}

// ── Stoppage tick ────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_stoppage_tick_uses_factory_time_and_leaves_unit_counts_alone() {
    // UTC+5, like the plant: stoppage start times are stored factory-local.
    let state = setup_state("linesentry_it_tick", 300).await;
    let store = &state.store;
    seed_plc(store, "default", None).await;
    let machine = seed_machine(store, "inactive", "power", &["default"], "Q0.0").await;

    // Power without a cycle opens an unclassified stoppage at 10:00 factory time.
    pipeline::process_pin_data(&state, "default", "01", Some("2026-05-31T05:00:00Z"))
        .await
        .unwrap();
    // Units counted by ingestion while the stoppage is open.
    let first_hour_units = format!("{}.0.{}", records::f::HOURS, records::f::HOUR_UNITS);
    store
        .records
        .rows
        .update(
            records_of(machine),
            Changes::new()
                .set(records::f::UNITS, 42.0)
                .set(&first_hour_units, 42.0),
        )
        .await
        .unwrap();

    let seven_minutes_in = chrono::DateTime::parse_from_rfc3339("2026-05-31T10:07:30Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert_eq!(
        pipeline::tick_ongoing_stoppages(&state, seven_minutes_in)
            .await
            .unwrap(),
        1
    );

    let rec = todays_record(store, machine).await;
    let hour = first_hour(&rec);
    assert_eq!(hour.hour, 10.0);
    assert_eq!(hour.stoppages[0].duration, 7.0);
    assert_eq!(hour.stoppage_minutes, 7.0);
    assert_eq!(hour.units_produced, 42.0);
    assert_eq!(rec.units_produced, 42.0);

    // Durations are capped at the hour.
    let much_later = seven_minutes_in + chrono::Duration::hours(3);
    pipeline::tick_ongoing_stoppages(&state, much_later)
        .await
        .unwrap();
    let rec = todays_record(store, machine).await;
    let hour = first_hour(&rec);
    assert_eq!(hour.stoppages[0].duration, 60.0);
    assert_eq!(hour.stoppage_minutes, 60.0);
}

// ── Daily report schedule ────────────────────────────────────────────────────

fn factory_time(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .unwrap()
        .with_timezone(&chrono::Utc)
}

fn scheduled() -> Filter {
    Filter::all().eq(reports::f::SCHEDULED, true)
}

async fn scheduled_reports(store: &Store) -> u64 {
    store.reports.rows.count(scheduled()).await.unwrap()
}

#[tokio::test]
async fn the_daily_report_is_stored_once_per_day_after_the_configured_hour() {
    use crate::routes::reports::run_daily_schedule;
    let state = setup_state("linesentry_it_daily", 0).await;
    let store = &state.store;

    // No schedule section, then a switched-off one.
    let done = run_daily_schedule(&state, None, factory_time("2026-06-02T07:00:00Z"))
        .await
        .unwrap();
    assert_eq!(done.detail, "schedule is off");
    store
        .configs
        .create(&doc! { "reportSchedule": { "enabled": false, "hour": 6, "email": true } })
        .await
        .unwrap();
    let done = run_daily_schedule(&state, None, factory_time("2026-06-02T07:00:00Z"))
        .await
        .unwrap();
    assert_eq!(done.detail, "schedule is off");
    assert_eq!(scheduled_reports(store).await, 0);

    store
        .configs
        .rows
        .update(
            Filter::all(),
            Changes::new().set("reportSchedule.enabled", true),
        )
        .await
        .unwrap();

    // Before the hour: nothing.
    let done = run_daily_schedule(&state, None, factory_time("2026-06-02T05:59:00Z"))
        .await
        .unwrap();
    assert_eq!(done.detail, "not due yet");
    assert!(done.cursor.is_none());
    assert_eq!(scheduled_reports(store).await, 0);

    // From the hour on: yesterday's report, with no email set up.
    let done = run_daily_schedule(&state, None, factory_time("2026-06-02T06:00:00Z"))
        .await
        .unwrap();
    assert_eq!(done.cursor.as_deref(), Some("2026-06-01"));
    assert!(done.detail.contains("not emailed"), "{}", done.detail);
    let report = store
        .reports
        .rows
        .find_one(scheduled())
        .await
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(report.get_str("type").unwrap(), "daily");
    let period = report.get_document("period").unwrap();
    assert_eq!(
        period.get_datetime("start").unwrap().to_chrono(),
        factory_time("2026-06-01T00:00:00Z")
    );
    assert_eq!(
        period.get_datetime("end").unwrap().to_chrono(),
        factory_time("2026-06-01T23:59:59.999Z")
    );

    // Later the same day with the cursor: nothing new.
    let done = run_daily_schedule(
        &state,
        Some("2026-06-01".into()),
        factory_time("2026-06-02T09:00:00Z"),
    )
    .await
    .unwrap();
    assert_eq!(done.detail, "2026-06-01 already done");
    assert_eq!(scheduled_reports(store).await, 1);

    // A round that failed before the cursor moved reuses the stored report.
    let done = run_daily_schedule(&state, None, factory_time("2026-06-02T09:05:00Z"))
        .await
        .unwrap();
    assert_eq!(done.cursor.as_deref(), Some("2026-06-01"));
    assert_eq!(scheduled_reports(store).await, 1);

    // The next day gets its own report.
    let done = run_daily_schedule(
        &state,
        Some("2026-06-01".into()),
        factory_time("2026-06-03T06:30:00Z"),
    )
    .await
    .unwrap();
    assert_eq!(done.cursor.as_deref(), Some("2026-06-02"));
    assert_eq!(scheduled_reports(store).await, 2);
}

// ── Floor and losses ─────────────────────────────────────────────────────────

async fn admin_token(app: &Router) -> String {
    app.clone()
        .oneshot(post_json("/api/auth/init-demo", None, json!({})))
        .await
        .unwrap();
    let resp = app
        .clone()
        .oneshot(post_json(
            "/api/auth/login",
            None,
            json!({ "username": "admin", "password": "admin123" }),
        ))
        .await
        .unwrap();
    body_json(resp).await["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_state_change_stamps_status_since_and_a_repeat_does_not_move_it() {
    let state = setup_state("linesentry_it_since", 0).await;
    let store = &state.store;
    seed_plc(store, "default", None).await;
    let machine = seed_machine(store, "inactive", "power", &["default"], "Q0.0").await;
    let since = || async { stored_machine(store, machine).await.status_since };

    assert!(since().await.is_none());
    pipeline::process_pin_data(&state, "default", "01", Some("2026-05-31T05:00:00Z"))
        .await
        .unwrap();
    let first = since().await.expect("stamped on the change to stoppage");

    tokio::time::sleep(Duration::from_millis(30)).await;
    pipeline::process_pin_data(&state, "default", "01", Some("2026-05-31T05:00:01Z"))
        .await
        .unwrap();
    assert_eq!(
        since().await,
        Some(first),
        "same state must keep its start time"
    );
}

#[tokio::test]
async fn losses_add_up_by_reason_machine_shift_and_day() {
    let (app, state) = setup("linesentry_it_losses").await;
    let store = &state.store;
    let token = admin_token(&app).await;

    let mold = ObjectId::new();
    let operator = ObjectId::new();
    let dept = ObjectId::new();
    let machine = ObjectId::new();
    store
        .machines
        .rows
        .insert(&machine_row(machine, "Press 1", dept, "running"))
        .await
        .unwrap();
    store
        .molds
        .rows
        .insert(&mold_row(mold, "Door liner", 120.0, dept))
        .await
        .unwrap();
    store
        .configs
        .create(&doc! { "shifts": [ { "name": "Morning", "startTime": "06:00", "endTime": "14:00", "isActive": true } ] })
        .await
        .unwrap();

    let hour = |h: f64, units: f64, running: f64, stops: Vec<Stoppage>| HourlyData {
        hour: h,
        units_produced: units,
        defective_units: 0.0,
        status: "running".into(),
        operator_id: Some(Id(operator)),
        mold_id: Some(Id(mold)),
        stoppage_minutes: stops.iter().map(|s| s.duration).sum(),
        stoppages: stops,
        running_minutes: running,
        cycle_buckets: None,
    };
    let stop = |reason: &str, minutes: f64| Stoppage {
        id: Some(Id::new()),
        reason: reason.into(),
        description: None,
        sap_notification_number: None,
        start_time: None,
        end_time: None,
        duration: minutes,
        is_pending: false,
        is_classified: false,
    };
    store
        .records
        .rows
        .insert(&ProductionRecord {
            id: None,
            machine_id: Id(machine),
            operator_id: None,
            mold_id: None,
            units_produced: 150.0,
            defective_units: 0.0,
            start_time: factory_time("2026-06-01T00:00:00Z"),
            end_time: None,
            hourly_data: vec![
                // In the Morning shift: a full hour at the ideal rate.
                hour(8.0, 120.0, 60.0, vec![]),
                // Outside any shift: half an hour lost to a breakdown and a mold change.
                hour(
                    20.0,
                    30.0,
                    30.0,
                    vec![stop("breakdown", 20.0), stop("mold_change", 10.0)],
                ),
            ],
            last_activity_time: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .unwrap();

    let resp = app
        .clone()
        .oneshot(get(
            "/api/analytics/losses?startDate=2026-06-01&endDate=2026-06-01",
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;

    // 90 running + 30 stopped; 150 units against 180 expected at 120/h.
    assert_eq!(v["total"]["units"], 150.0);
    assert_eq!(v["total"]["availability"], 75);
    assert_eq!(v["total"]["performance"], 83);
    assert_eq!(v["total"]["quality"], 100);
    assert_eq!(v["total"]["oee"], 63);
    assert_eq!(v["total"]["breakdowns"], 1);
    assert_eq!(v["total"]["mtbfMinutes"], 90);
    assert_eq!(v["total"]["mttrMinutes"], 20);

    // Longest reason first, with a running share that ends at 100.
    assert_eq!(v["byReason"][0]["reason"], "breakdown");
    assert_eq!(v["byReason"][0]["minutes"], 20.0);
    assert_eq!(v["byReason"][0]["cumulativeShare"], 67.0);
    assert_eq!(v["byReason"][1]["reason"], "mold_change");
    assert_eq!(v["byReason"][1]["cumulativeShare"], 100.0);

    assert_eq!(v["byMachine"][0]["name"], "Press 1");
    assert_eq!(v["byMachine"][0]["stoppedMinutes"], 30.0);
    let shifts: Vec<(&str, f64)> = v["byShift"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["name"].as_str().unwrap(), s["units"].as_f64().unwrap()))
        .collect();
    assert_eq!(shifts, vec![("Morning", 120.0), ("Outside shifts", 30.0)]);
    assert_eq!(v["byMold"][0]["name"], "Door liner");
    assert_eq!(v["byOperator"][0]["name"], "No operator assigned");
    assert_eq!(v["daily"].as_array().unwrap().len(), 1);
    assert_eq!(v["daily"][0]["date"], "2026-06-01");

    // A period with nothing in it is empty, not an error.
    let resp = app
        .clone()
        .oneshot(get(
            "/api/analytics/losses?startDate=2026-07-01&endDate=2026-07-02",
            Some(&token),
        ))
        .await
        .unwrap();
    let v = body_json(resp).await;
    assert_eq!(v["total"]["units"], 0.0);
    assert!(
        v["total"]["oee"].is_null(),
        "no mold hours means no OEE, not 0%"
    );
    assert!(v["byReason"].as_array().unwrap().is_empty());

    let resp = app
        .clone()
        .oneshot(get(
            "/api/analytics/losses?startDate=2026-06-02&endDate=2026-06-01",
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let resp = app
        .oneshot(get("/api/analytics/losses", None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_floor_shows_state_output_and_stoppages_waiting_for_a_reason() {
    let state = setup_state("linesentry_it_floor", 0).await;
    let app = build_router(state.clone());
    let token = admin_token(&app).await;
    seed_plc(&state.store, "default", None).await;
    let machine = seed_machine(&state.store, "inactive", "power", &["default"], "Q0.0").await;

    // Power without a cycle, stamped now: a stoppage with no reason opens.
    pipeline::process_pin_data(&state, "default", "01", None)
        .await
        .unwrap();

    let resp = app
        .clone()
        .oneshot(get("/api/analytics/floor", Some(&token)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    let row = v["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["_id"] == machine.to_hex())
        .expect("the machine is on the floor");
    assert_eq!(row["status"], "stoppage");
    assert!(row["statusSince"].is_string());
    assert_eq!(row["unitsToday"], 0.0);
    assert!(row["waitingForReason"].is_object(), "{row}");

    let resp = app
        .oneshot(get("/api/analytics/floor", None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// ── Pipeline: state in the database ──────────────────────────────────────────

/// A second backend instance on the same database: its own memory, nothing shared.
fn another_instance(state: &AppState) -> AppState {
    AppState {
        login_rl: state.login_rl.clone(),
        general_rl: state.general_rl.clone(),
        ..state_on(Arc::new(state.store.another()), state.config.clone())
    }
}

/// A machine with a power sensor on Q0.0 and a unit-cycle sensor on Q0.1.
async fn seed_two_signal_machine(store: &Store) -> ObjectId {
    let machine = seed_machine(store, "inactive", "power", &["default"], "Q0.0").await;
    wire_sensor(
        store,
        "Cycle",
        machine,
        sensors::UNIT_CYCLE,
        "default",
        "Q0.1",
    )
    .await;
    machine
}

const POWER: &str = "01";
const POWER_AND_CYCLE: &str = "03";

#[tokio::test]
async fn concurrent_units_are_all_counted() {
    let state = setup_state("linesentry_it_concurrent", 0).await;
    state.store.ensure_schema().await.unwrap();
    // (`ensure_indexes` registers the default PLC itself.)
    let machine = seed_two_signal_machine(&state.store).await;

    // Forty payloads at once, each a unit, all in the same hour. The old
    // read-modify-write would lose most of them.
    let posts = (0..40).map(|i| {
        let state = state.clone();
        async move {
            let ts = format!("2026-05-31T10:00:{:02}.{:03}Z", i % 60, i);
            pipeline::process_pin_data(&state, "default", POWER_AND_CYCLE, Some(&ts)).await
        }
    });
    for result in futures::future::join_all(posts).await {
        result.unwrap();
    }

    let records = state
        .store
        .records
        .rows
        .count(records_of(machine))
        .await
        .unwrap();
    assert_eq!(
        records, 1,
        "one record for the day, however many payloads raced to create it"
    );
    let rec = todays_record(&state.store, machine).await;
    assert_eq!(rec.hourly_data.len(), 1, "one bucket for the hour");
    assert_eq!(first_hour(&rec).units_produced, 40.0);
    assert_eq!(rec.units_produced, 40.0);
}

#[tokio::test]
async fn a_retried_payload_counts_once_on_any_instance() {
    let a = setup_state("linesentry_it_retry", 0).await;
    seed_plc(&a.store, "default", None).await;
    let machine = seed_two_signal_machine(&a.store).await;
    let b = another_instance(&a);

    let ts = Some("2026-05-31T10:00:00Z");
    assert_eq!(
        pipeline::process_pin_data(&a, "default", POWER_AND_CYCLE, ts)
            .await
            .unwrap()
            .len(),
        1
    );
    // The daemon did not get the answer and retries; the retry lands elsewhere.
    assert!(
        pipeline::process_pin_data(&b, "default", POWER_AND_CYCLE, ts)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        pipeline::process_pin_data(&a, "default", POWER_AND_CYCLE, ts)
            .await
            .unwrap()
            .is_empty()
    );

    assert_eq!(
        first_hour(&todays_record(&a.store, machine).await).units_produced,
        1.0
    );

    // Readings without a timestamp cannot be told apart, so each one counts.
    pipeline::process_pin_data(&a, "default", POWER_AND_CYCLE, None)
        .await
        .unwrap();
    pipeline::process_pin_data(&a, "default", POWER_AND_CYCLE, None)
        .await
        .unwrap();
    let total: f64 = a
        .store
        .records
        .rows
        .find(records_of(machine))
        .await
        .unwrap()
        .iter()
        .map(|r| r.units_produced)
        .sum();
    assert_eq!(total, 3.0);
}

#[tokio::test]
async fn a_restart_mid_stoppage_loses_nothing() {
    let before = setup_state("linesentry_it_restart", 0).await;
    seed_plc(&before.store, "default", None).await;
    let machine = seed_two_signal_machine(&before.store).await;

    // Running, then power without cycles for longer than the cycle timeout.
    pipeline::process_pin_data(
        &before,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T10:00:00Z"),
    )
    .await
    .unwrap();
    assert_eq!(machine_status(&before.store, machine).await, "running");
    pipeline::process_pin_data(&before, "default", POWER, Some("2026-05-31T10:03:00Z"))
        .await
        .unwrap();
    assert_eq!(machine_status(&before.store, machine).await, "stoppage");
    let open = |rec: &ProductionRecord| first_hour(rec).stoppages.len();
    assert_eq!(open(&todays_record(&before.store, machine).await), 1);

    // The backend restarts: a new process with empty memory.
    before.store.shutdown().await;
    let after = another_instance(&before);
    drop(before);

    // Still stopped: no second stoppage is opened.
    pipeline::process_pin_data(&after, "default", POWER, Some("2026-05-31T10:04:00Z"))
        .await
        .unwrap();
    assert_eq!(machine_status(&after.store, machine).await, "stoppage");
    assert_eq!(open(&todays_record(&after.store, machine).await), 1);

    // Cycles resume: the new process knows there was a stoppage and closes it.
    pipeline::process_pin_data(
        &after,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T10:05:00Z"),
    )
    .await
    .unwrap();
    assert_eq!(machine_status(&after.store, machine).await, "running");
    let rec = todays_record(&after.store, machine).await;
    assert_eq!(
        open(&rec),
        0,
        "a pause inside the hour leaves no stoppage behind"
    );
    assert_eq!(first_hour(&rec).units_produced, 2.0);
    assert_eq!(first_hour(&rec).stoppage_minutes, 0.0);
}

#[tokio::test]
async fn two_instances_sharing_a_plc_agree_on_state_and_minutes() {
    let a = setup_state("linesentry_it_two", 0).await;
    seed_plc(&a.store, "default", None).await;
    let machine = seed_two_signal_machine(&a.store).await;
    let b = another_instance(&a);

    // A load balancer alternates the daemon's payloads between two instances.
    // Six payloads spread over three minutes, all running.
    for (i, second) in [0, 20, 60, 80, 120, 140].into_iter().enumerate() {
        let ts = format!("2026-05-31T10:{:02}:{:02}Z", second / 60, second % 60);
        let instance = if i % 2 == 0 { &a } else { &b };
        pipeline::process_pin_data(instance, "default", POWER_AND_CYCLE, Some(&ts))
            .await
            .unwrap();
    }
    let rec = todays_record(&a.store, machine).await;
    assert_eq!(first_hour(&rec).units_produced, 6.0);
    assert_eq!(
        first_hour(&rec).running_minutes,
        3.0,
        "each minute counted once, not once per instance"
    );

    // Power only, seen by B alone; A never saw a payload since the last cycle.
    pipeline::process_pin_data(&b, "default", POWER, Some("2026-05-31T10:06:00Z"))
        .await
        .unwrap();
    assert_eq!(machine_status(&a.store, machine).await, "stoppage");
    // A takes the next one and must not open a second stoppage.
    pipeline::process_pin_data(&a, "default", POWER, Some("2026-05-31T10:06:30Z"))
        .await
        .unwrap();
    assert_eq!(
        first_hour(&todays_record(&a.store, machine).await)
            .stoppages
            .len(),
        1
    );
}

#[tokio::test]
async fn a_stoppage_from_an_earlier_hour_is_closed_but_kept_for_its_reason() {
    let state = setup_state("linesentry_it_earlier", 0).await;
    seed_plc(&state.store, "default", None).await;
    let machine = seed_two_signal_machine(&state.store).await;

    pipeline::process_pin_data(
        &state,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T10:50:00Z"),
    )
    .await
    .unwrap();
    pipeline::process_pin_data(&state, "default", POWER, Some("2026-05-31T10:55:00Z"))
        .await
        .unwrap();
    pipeline::process_pin_data(&state, "default", POWER, Some("2026-05-31T11:10:00Z"))
        .await
        .unwrap();
    assert_eq!(
        pipeline::tick_ongoing_stoppages(&state, factory_time("2026-05-31T11:10:00Z"))
            .await
            .unwrap(),
        1
    );

    // Cycles resume in the next hour.
    pipeline::process_pin_data(
        &state,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T11:15:00Z"),
    )
    .await
    .unwrap();
    let rec = todays_record(&state.store, machine).await;
    let stoppage = &hour_of(&rec, 10).stoppages[0];
    assert_eq!(
        stoppage.reason, "unclassified",
        "still waiting for a reason"
    );
    assert!(!stoppage.is_pending, "but no longer open");
    assert_eq!(stoppage.duration, 15.0);

    // It is closed, so the tick leaves it alone even if the machine stops again.
    pipeline::process_pin_data(&state, "default", POWER, Some("2026-05-31T11:20:00Z"))
        .await
        .unwrap();
    pipeline::tick_ongoing_stoppages(&state, factory_time("2026-05-31T11:40:00Z"))
        .await
        .unwrap();
    let rec = todays_record(&state.store, machine).await;
    assert_eq!(hour_of(&rec, 10).stoppages[0].duration, 15.0);
}

#[tokio::test]
async fn gaps_between_units_fill_the_cycle_time_histogram() {
    let state = setup_state("linesentry_it_cycles", 0).await;
    seed_plc(&state.store, "default", None).await;
    let machine = seed_two_signal_machine(&state.store).await;

    // Gaps of 4 s, 4 s and 30 s after the first unit.
    for ts in ["10:00:00", "10:00:04", "10:00:08", "10:00:38"] {
        pipeline::process_pin_data(
            &state,
            "default",
            POWER_AND_CYCLE,
            Some(&format!("2026-05-31T{ts}Z")),
        )
        .await
        .unwrap();
    }
    let rec = todays_record(&state.store, machine).await;
    let buckets = first_hour(&rec).cycle_buckets.as_ref().unwrap();
    assert_eq!(buckets.get_i32("b3").unwrap(), 2, "two gaps of up to 5 s");
    assert_eq!(buckets.get_i32("b7").unwrap(), 1, "one gap of up to 34 s");
    assert_eq!(buckets.len(), 2);
}

#[tokio::test]
async fn a_batch_replays_an_outage_in_order_and_can_be_resent() {
    let (app, state) = setup("linesentry_it_batch").await;
    seed_plc(&state.store, "default", None).await;
    let machine = seed_two_signal_machine(&state.store).await;
    let batch = json!({
        "plcId": "default",
        "readings": [
            { "pinData": "03", "timestamp": "2026-05-31T10:00:00Z" },
            { "pinData": "03", "timestamp": "2026-05-31T10:00:05Z" },
            { "pinData": "zz", "timestamp": "2026-05-31T10:00:06Z" },
            { "pinData": "03", "timestamp": "2026-05-31T10:00:10Z" },
        ],
    });
    let send = |body: Value, key: Option<&'static str>| {
        let mut b = Request::builder()
            .method("POST")
            .uri("/api/signals/pin-data/batch")
            .header("content-type", "application/json");
        if let Some(k) = key {
            b = b.header("x-api-key", k);
        }
        b.body(Body::from(body.to_string())).unwrap()
    };

    let resp = app
        .clone()
        .oneshot(send(batch.clone(), Some("test-daemon-key")))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["applied"], 3);
    assert_eq!(v["rejected"], 1);
    assert_eq!(
        first_hour(&todays_record(&state.store, machine).await).units_produced,
        3.0
    );

    // The daemon never got the answer and sends the whole batch again.
    app.clone()
        .oneshot(send(batch, Some("test-daemon-key")))
        .await
        .unwrap();
    assert_eq!(
        first_hour(&todays_record(&state.store, machine).await).units_produced,
        3.0
    );

    let resp = app
        .clone()
        .oneshot(send(
            json!({ "readings": [ { "pinData": "03" } ] }),
            Some("test-daemon-key"),
        ))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "a batch reading needs a timestamp"
    );
    let resp = app
        .oneshot(send(json!({ "readings": [] }), None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn editing_a_machine_keeps_its_live_state() {
    let (app, state) = setup("linesentry_it_edit").await;
    let store = &state.store;
    let token = admin_token(&app).await;
    seed_plc(store, "default", None).await;
    let machine = seed_two_signal_machine(store).await;
    let dept = stored_machine(store, machine).await.department_id;

    // The pipeline runs in another instance than the one serving the edit.
    let ingesting = another_instance(&state);
    pipeline::process_pin_data(&ingesting, "default", POWER_AND_CYCLE, None)
        .await
        .unwrap();
    assert_eq!(machine_status(store, machine).await, "running");

    let resp = app
        .oneshot(send_json(
            "PUT",
            &format!("/api/machines/{}", machine.to_hex()),
            Some(&token),
            json!({ "name": "Renamed", "departmentId": dept.to_hex(), "status": "inactive" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let stored = stored_machine(store, machine).await;
    assert_eq!(stored.name, "Renamed");
    assert_eq!(
        stored.status, "running",
        "a client cannot overwrite the live state"
    );
    // The last-cycle mark is not on the model: read that field alone.
    let live = store
        .machines
        .rows
        .select_one(
            Filter::id(machine),
            &[machines::f::LAST_CYCLE, machines::f::STATUS_SINCE],
        )
        .await
        .unwrap()
        .unwrap();
    assert!(
        live.get_datetime(machines::f::LAST_CYCLE).is_ok(),
        "the pipeline's fields survive an edit"
    );
    assert!(live.get_datetime(machines::f::STATUS_SINCE).is_ok());
}

// ── Alerts ───────────────────────────────────────────────────────────────────

/// A webhook receiver on a free local port. Returns its URL and what it got.
async fn webhook_receiver() -> (String, Arc<std::sync::Mutex<Vec<Value>>>) {
    let received: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let sink = received.clone();
    let app = Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let sink = sink.clone();
            async move {
                sink.lock().unwrap().push(body);
                StatusCode::OK
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, received)
}

#[tokio::test]
async fn a_long_stoppage_raises_each_alert_level_once() {
    let state = setup_state("linesentry_it_alerts", 0).await;
    state.store.ensure_schema().await.unwrap();
    let machine = seed_two_signal_machine(&state.store).await;
    let (hook, received) = webhook_receiver().await;
    let at = |t: &str| factory_time(&format!("2026-05-31T{t}Z"));

    // Running, then power without cycles from 10:03.
    pipeline::process_pin_data(
        &state,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T10:00:00Z"),
    )
    .await
    .unwrap();
    pipeline::process_pin_data(&state, "default", POWER, Some("2026-05-31T10:03:00Z"))
        .await
        .unwrap();

    // No alerts section: off.
    assert_eq!(
        crate::alerts::run(&state, at("10:40:00"))
            .await
            .unwrap()
            .detail,
        "alerts are off"
    );

    state
        .store
        .configs
        .create(&doc! { "alerts": {
            "enabled": true, "stoppageMinutes": 10, "escalateMinutes": 30, "webhookUrl": &hook,
        }})
        .await
        .unwrap();

    assert_eq!(
        crate::alerts::run(&state, at("10:08:00"))
            .await
            .unwrap()
            .detail,
        "nothing has been stopped long enough"
    );
    assert!(received.lock().unwrap().is_empty());

    assert_eq!(
        crate::alerts::run(&state, at("10:14:00"))
            .await
            .unwrap()
            .detail,
        "1 alert(s) raised"
    );
    assert_eq!(
        crate::alerts::run(&state, at("10:20:00"))
            .await
            .unwrap()
            .detail,
        "no new alerts",
        "level 1 is raised once"
    );

    // Past the second threshold, noticed by another instance.
    let other = another_instance(&state);
    assert_eq!(
        crate::alerts::run(&other, at("10:34:00"))
            .await
            .unwrap()
            .detail,
        "1 alert(s) raised"
    );
    assert_eq!(
        crate::alerts::run(&state, at("10:35:00"))
            .await
            .unwrap()
            .detail,
        "no new alerts"
    );

    let got = received.lock().unwrap().clone();
    assert_eq!(got.len(), 2, "one webhook call per level: {got:?}");
    assert_eq!(got[0]["level"], 1);
    assert_eq!(got[0]["stoppedMinutes"], 11);
    assert_eq!(got[0]["machineId"], machine.to_hex());
    assert!(got[0]["text"].as_str().unwrap().contains("has stopped"));
    assert_eq!(got[1]["level"], 2);
    assert!(got[1]["text"].as_str().unwrap().contains("still stopped"));

    // Stored with how delivery went, newest first.
    let app = build_router(state.clone());
    let token = admin_token(&app).await;
    let resp = app
        .clone()
        .oneshot(get("/api/alerts", Some(&token)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let rows = body_json(resp).await;
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert_eq!(rows[0]["level"], 2);
    assert_eq!(rows[0]["deliveries"][0]["channel"], "webhook");
    assert_eq!(rows[0]["deliveries"][0]["ok"], true);
    let resp = app.oneshot(get("/api/alerts", None)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // Cycles resume: a machine that is running raises nothing further.
    pipeline::process_pin_data(
        &state,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T10:50:00Z"),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::alerts::run(&state, at("11:30:00"))
            .await
            .unwrap()
            .detail,
        "no machine is stopped"
    );
}

#[tokio::test]
async fn a_webhook_that_fails_is_recorded_and_does_not_fail_the_round() {
    let state = setup_state("linesentry_it_alerts_down", 0).await;
    state.store.ensure_schema().await.unwrap();
    seed_two_signal_machine(&state.store).await;
    pipeline::process_pin_data(
        &state,
        "default",
        POWER_AND_CYCLE,
        Some("2026-05-31T10:00:00Z"),
    )
    .await
    .unwrap();
    pipeline::process_pin_data(&state, "default", POWER, Some("2026-05-31T10:03:00Z"))
        .await
        .unwrap();
    state
        .store
        .configs
        .create(&doc! { "alerts": {
            // Nothing listens on this port.
            "enabled": true, "stoppageMinutes": 10, "escalateMinutes": 0, "webhookUrl": "http://127.0.0.1:9/hook",
        }})
        .await
        .unwrap();

    let done = crate::alerts::run(&state, factory_time("2026-05-31T10:20:00Z"))
        .await
        .unwrap();
    assert_eq!(done.detail, "1 alert(s) raised, 1 delivery failure(s)");
    let rows = state.store.alerts.recent(None, 10).await.unwrap();
    let delivery = rows[0].get_array("deliveries").unwrap()[0]
        .as_document()
        .unwrap();
    assert!(!delivery.get_bool("ok").unwrap());
    assert!(delivery
        .get_str("error")
        .unwrap()
        .contains("could not reach the webhook"));
}

// ── Configuration ────────────────────────────────────────────────────────────

/// Stoppage reasons a plant might define in place of the defaults.
fn plant_reasons() -> Value {
    json!([
        { "key": "jam", "label": "Jam", "kind": "breakdown" },
        { "key": "lunch", "label": "Lunch", "kind": "planned" },
        { "key": "mold_change", "label": "Mold change", "kind": "unplanned" },
    ])
}

fn morning_shift() -> Value {
    json!([{ "name": "Morning", "startTime": "06:00", "endTime": "14:00" }])
}

#[tokio::test]
async fn stoppage_reasons_are_validated_before_the_configuration_is_saved() {
    let (app, state) = setup("linesentry_it_config").await;
    let token = admin_token(&app).await;
    let put = |body: Value| send_json("PUT", "/api/config", Some(&token), body);

    // The first read creates the default configuration, reasons included.
    let (status, v) = call(&app, get("/api/config", Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["stoppageReasons"].as_array().unwrap().len(), 6, "{v}");
    assert_eq!(v["stoppageReasons"][0]["key"], "breakdown");

    let (status, v) = call(&app, put(json!({ "stoppageReasons": [] }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(v["message"], "stoppageReasons must be a non-empty list");
    let reserved = json!([{ "key": "unclassified", "label": "x", "kind": "planned" }]);
    let (status, v) = call(&app, put(json!({ "stoppageReasons": reserved }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
    assert_eq!(
        state.store.configs.stoppage_reasons().await.unwrap().len(),
        6,
        "a rejected list must not be saved"
    );

    let (status, v) = call(
        &app,
        put(json!({ "stoppageReasons": plant_reasons(), "shifts": morning_shift() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["stoppageReasons"][1]["key"], "lunch");
    assert!(v["plc"].is_object(), "other sections survive: {v}");
    let reasons = state.store.configs.stoppage_reasons().await.unwrap();
    assert_eq!(reasons.len(), 3);
    let (status, v) = call(&app, get("/api/config/shifts", Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v[0]["name"], "Morning");
}

#[tokio::test]
async fn the_reasons_endpoint_gives_the_defaults_until_the_plant_saves_its_own() {
    let (app, _state) = setup("linesentry_it_reasons").await;
    let token = admin_token(&app).await;

    // Nothing saved at all: the defaults.
    let (status, v) = call(&app, get("/api/config/stoppage-reasons", Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        v,
        serde_json::to_value(crate::persist::configs::default_reasons()).unwrap()
    );
    assert_eq!(v.as_array().unwrap().len(), 6);
    assert_eq!(
        v[0],
        json!({ "key": "breakdown", "label": "Breakdown", "kind": "breakdown" })
    );

    let (status, v) = call(
        &app,
        send_json(
            "PUT",
            "/api/config",
            Some(&token),
            json!({ "stoppageReasons": plant_reasons() }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let (status, v) = call(&app, get("/api/config/stoppage-reasons", Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v, plant_reasons());

    let (status, _) = call(&app, get("/api/config/stoppage-reasons", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── Stoppages and assignments reported by people ─────────────────────────────

/// A plant at UTC+5 with one press and its mold, the plant's own stoppage
/// reasons and a morning shift from 06:00 to 14:00.
struct Press {
    app: Router,
    state: AppState,
    token: String,
    machine: ObjectId,
    mold: ObjectId,
}

const PRESS_DAY: &str = "2026-06-01";

/// The start of `hour` on the press's day.
fn press_hour(hour: u32) -> chrono::DateTime<chrono::Utc> {
    factory_time(&format!("{PRESS_DAY}T{hour:02}:00:00Z"))
}

async fn press(db_name: &str) -> Press {
    let state = setup_state(db_name, 300).await;
    state.store.ensure_schema().await.unwrap();
    let app = build_router(state.clone());
    let token = admin_token(&app).await;
    let (machine, mold, dept) = (ObjectId::new(), ObjectId::new(), ObjectId::new());
    state
        .store
        .machines
        .rows
        .insert(&machine_row(machine, "Press 1", dept, "running"))
        .await
        .unwrap();
    state
        .store
        .molds
        .rows
        .insert(&mold_row(mold, "Door liner", 120.0, dept))
        .await
        .unwrap();
    let (status, v) = call(
        &app,
        send_json(
            "PUT",
            "/api/config",
            Some(&token),
            json!({ "stoppageReasons": plant_reasons(), "shifts": morning_shift() }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    Press {
        app,
        state,
        token,
        machine,
        mold,
    }
}

impl Press {
    /// A request body about `hour` of the press's day, plus `extra`.
    fn at(&self, hour: i64, extra: Value) -> Value {
        let mut body =
            json!({ "machineId": self.machine.to_hex(), "hour": hour, "date": PRESS_DAY });
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    }

    async fn stop(&self, body: Value) -> (StatusCode, Value) {
        let request = post_json("/api/analytics/stoppage", Some(&self.token), body);
        call(&self.app, request).await
    }

    async fn assign(&self, body: Value) -> (StatusCode, Value) {
        let uri = "/api/analytics/production-assignment";
        call(&self.app, post_json(uri, Some(&self.token), body)).await
    }

    async fn get(&self, uri: &str) -> (StatusCode, Value) {
        call(&self.app, get(uri, Some(&self.token))).await
    }

    async fn record(&self) -> ProductionRecord {
        todays_record(&self.state.store, self.machine).await
    }

    /// The pipeline notices the press stopped at the start of `hour`.
    async fn stops_at(&self, hour: u32) -> ObjectId {
        let pending = ObjectId::new();
        let opened = self
            .state
            .store
            .records
            .open_stoppage(Id(self.machine), press_hour(hour), pending)
            .await
            .unwrap();
        assert!(opened);
        pending
    }

    /// The pipeline counts `units` in `hour`, whose bucket must exist.
    async fn counts(&self, hour: u32, units: u32) {
        let store = &self.state.store;
        let mut batch = store.batch();
        let at =
            store
                .records
                .queue_units(&mut batch, Id(self.machine), press_hour(hour), units, None);
        assert_eq!(batch.send().await.unwrap()[at].modified, 1);
    }

    /// A morning with a lunch stop and a jam in hour 8, and in hour 10 seven
    /// units counted around a stoppage that was later put down to lunch.
    async fn has_a_morning(&self) {
        let (status, v) = self
            .stop(self.at(8, json!({ "reason": "lunch", "duration": 20 })))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
        let jam = json!({ "reason": "jam", "duration": 50, "sapNotificationNumber": "4711" });
        let (status, v) = self.stop(self.at(8, jam)).await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
        let pending = self.stops_at(10).await;
        self.counts(10, 7).await;
        let lunch = json!({ "reason": "lunch", "pendingStoppageId": pending.to_hex() });
        let (status, v) = self.stop(self.at(10, lunch)).await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
    }
}

#[tokio::test]
async fn a_reported_stoppage_is_checked_and_an_hour_holds_at_most_sixty_minutes() {
    let p = press("linesentry_it_stoppage").await;
    let rejected = |(status, v): (StatusCode, Value)| {
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
        v["message"].as_str().unwrap_or_default().to_string()
    };

    // "breakdown" was a default reason; this plant replaced the defaults.
    let body = p.at(8, json!({ "reason": "breakdown", "duration": 5 }));
    assert_eq!(rejected(p.stop(body).await), "Unknown stoppage reason");
    let body = p.at(8, json!({ "reason": "jam", "duration": 5 }));
    assert_eq!(rejected(p.stop(body).await), "SAP number required");
    let body = p.at(
        8,
        json!({ "reason": "jam", "duration": 5, "sapNotificationNumber": "12a" }),
    );
    assert_eq!(rejected(p.stop(body).await), "Invalid SAP number format");
    rejected(p.stop(p.at(24, json!({ "reason": "lunch" }))).await);
    let nothing = Filter::all();
    assert_eq!(p.state.store.records.rows.count(nothing).await.unwrap(), 0);

    // The first stoppage of the day creates the day's record and the hour.
    let lunch = json!({ "reason": "lunch", "duration": 20, "description": "$notAField" });
    let (status, v) = p.stop(p.at(8, lunch)).await;
    assert_eq!(status, StatusCode::CREATED, "{v}");
    assert_eq!(v["message"], "Stoppage recorded");
    let rec = p.record().await;
    let h8 = hour_of(&rec, 8);
    assert_eq!(h8.stoppage_minutes, 20.0);
    assert_eq!(h8.status, "stoppage");
    let first = &h8.stoppages[0];
    assert_eq!(first.reason, "lunch");
    assert_eq!(first.description.as_deref(), Some("$notAField"));
    assert!(first.sap_notification_number.is_none());
    assert!(!first.is_pending && first.is_classified);
    assert_eq!(
        first.end_time.unwrap() - first.start_time.unwrap(),
        chrono::Duration::minutes(20)
    );

    // Twenty and fifty minutes are both kept, but the hour has only sixty.
    let jam = json!({ "reason": "jam", "duration": 50, "sapNotificationNumber": "4711" });
    let (status, _) = p.stop(p.at(8, jam)).await;
    assert_eq!(status, StatusCode::CREATED);
    let rec = p.record().await;
    let h8 = hour_of(&rec, 8);
    assert_eq!(h8.stoppage_minutes, 60.0, "capped");
    assert_eq!(h8.stoppages.len(), 2);
    assert_eq!(
        h8.stoppages[1].sap_notification_number.as_deref(),
        Some("4711")
    );
}

#[tokio::test]
async fn classifying_a_pending_stoppage_keeps_the_units_counted_meanwhile() {
    let p = press("linesentry_it_classify").await;
    let (status, _) = p
        .stop(p.at(8, json!({ "reason": "lunch", "duration": 20 })))
        .await;
    assert_eq!(status, StatusCode::CREATED);

    // The press stops in hour 10 and units are counted before anyone says why.
    let pending = p.stops_at(10).await;
    p.counts(10, 7).await;
    let jam = json!({
        "reason": "jam", "sapNotificationNumber": "99", "pendingStoppageId": pending.to_hex(),
    });
    let (status, v) = p.stop(p.at(10, jam)).await;
    assert_eq!(status, StatusCode::CREATED, "{v}");
    let rec = p.record().await;
    let h10 = hour_of(&rec, 10);
    assert_eq!(h10.units_produced, 7.0);
    assert_eq!(rec.units_produced, 7.0);
    let classified = h10.stoppages[0].clone();
    assert_eq!(classified.id, Some(Id(pending)));
    assert_eq!(classified.reason, "jam");
    assert_eq!(classified.sap_notification_number.as_deref(), Some("99"));
    assert!(classified.description.is_none(), "{classified:?}");
    assert!(!classified.is_pending && classified.is_classified);
    assert!(classified.end_time.is_some());
    assert_eq!(h10.stoppage_minutes, classified.duration.min(60.0));
    assert_eq!(h10.status, "stoppage");
    assert_eq!(
        hour_of(&rec, 8).stoppages.len(),
        1,
        "another hour is not touched"
    );

    // Giving a closed stoppage another reason keeps its duration and end.
    let lunch = json!({
        "reason": "lunch", "description": "was lunch", "pendingStoppageId": pending.to_hex(),
    });
    let (status, _) = p.stop(p.at(10, lunch)).await;
    assert_eq!(status, StatusCode::CREATED);
    let rec = p.record().await;
    let again = &hour_of(&rec, 10).stoppages[0];
    assert_eq!(again.reason, "lunch");
    assert_eq!(again.description.as_deref(), Some("was lunch"));
    assert!(again.sap_notification_number.is_none());
    assert_eq!(again.duration, classified.duration);
    assert_eq!(again.end_time, classified.end_time);

    // Nothing to classify: not found, and nothing written.
    let no_such = json!({ "reason": "lunch", "pendingStoppageId": ObjectId::new().to_hex() });
    let (status, _) = p.stop(p.at(11, no_such.clone())).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let mut elsewhere = p.at(11, no_such);
    elsewhere["machineId"] = json!(ObjectId::new().to_hex());
    let (status, _) = p.stop(elsewhere).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let records = &p.state.store.records.rows;
    assert_eq!(records.count(Filter::all()).await.unwrap(), 1);
    assert_eq!(p.record().await.hourly_data.len(), 2);
}

#[tokio::test]
async fn an_assignment_covers_the_shift_and_defective_units_add_up() {
    let p = press("linesentry_it_assign").await;
    p.has_a_morning().await;
    let operator = ObjectId::new();

    let (status, v) = p
        .assign(p.at(
            10,
            json!({
                "operatorId": operator.to_hex(), "moldId": p.mold.to_hex(),
                "defectiveUnits": 5, "applyToShift": true,
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["message"], "Production assignment updated successfully");
    let rec = p.record().await;
    assert_eq!(rec.hourly_data.len(), 8, "6..14, with 8 and 10 kept");
    for h in 6..14 {
        let bucket = hour_of(&rec, h);
        assert_eq!(bucket.operator_id, Some(Id(operator)));
        assert_eq!(bucket.mold_id, Some(Id(p.mold)));
        let expected = if h == 8 || h == 10 {
            "stoppage"
        } else {
            "inactive"
        };
        assert_eq!(bucket.status, expected, "hour {h}");
    }
    let h10 = hour_of(&rec, 10);
    assert_eq!(h10.units_produced, 7.0);
    assert_eq!(h10.defective_units, 5.0);
    assert_eq!(h10.stoppages.len(), 1);
    assert_eq!(hour_of(&rec, 8).stoppages.len(), 2);
    assert_eq!(rec.defective_units, 5.0);
    assert_eq!(rec.units_produced, 7.0);

    // One hour only: no operator named removes it, and the day's defective
    // total follows the hours.
    let (status, _) = p
        .assign(p.at(9, json!({ "moldId": p.mold.to_hex(), "defectiveUnits": 2 })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = p
        .assign(p.at(
            10,
            json!({
                "operatorId": operator.to_hex(), "moldId": p.mold.to_hex(), "defectiveUnits": 3,
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let rec = p.record().await;
    assert!(hour_of(&rec, 9).operator_id.is_none());
    assert_eq!(hour_of(&rec, 7).operator_id, Some(Id(operator)));
    assert_eq!(rec.defective_units, 5.0, "2 + 3");
    assert_eq!(rec.units_produced, 7.0);
    assert_eq!(rec.hourly_data.len(), 8);
}

#[tokio::test]
async fn the_statistics_show_what_was_reported_and_what_still_waits_for_a_reason() {
    let p = press("linesentry_it_stats").await;
    p.has_a_morning().await;
    let (status, v) = p
        .assign(p.at(
            10,
            json!({
                "operatorId": ObjectId::new().to_hex(), "moldId": p.mold.to_hex(),
                "defectiveUnits": 5, "applyToShift": true,
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");

    // Every stoppage so far has its reason; then the press stops again.
    let (status, v) = p.get("/api/analytics/factory-stats").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["unclassifiedStoppages"], 0);
    assert_eq!(v["activeMachines"], 1);
    p.stops_at(12).await;
    let (_, v) = p.get("/api/analytics/factory-stats").await;
    assert_eq!(v["unclassifiedStoppages"], 1, "{v}");
    let (status, v) = p.get("/api/signals/unclassified-stoppages-count").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["count"], 1, "{v}");

    let machine = p.machine.to_hex();
    let day = format!("startDate={PRESS_DAY}&endDate={PRESS_DAY}");
    let (status, v) = p
        .get(&format!("/api/analytics/machine-stats/{machine}?{day}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["totalUnitsProduced"], 7.0);
    assert_eq!(v["totalDefectiveUnits"], 5.0);
    assert_eq!(v["breakdownStoppages"], 1, "only the jam in hour 8: {v}");
    assert_eq!(v["currentStatus"], "running");

    let (status, v) = p
        .get(&format!(
            "/api/analytics/production-timeline/{machine}?timeframe=custom&{day}"
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let h10 = &v["timeline"][0]["hours"][10];
    assert_eq!(h10["mold"]["name"], "Door liner");
    assert_eq!(h10["mold"]["productionCapacityPerHour"], 120.0);
    assert_eq!(h10["operator"], Value::Null, "no such user: {h10}");
    assert_eq!(v["timeline"][0]["hours"][6]["status"], "inactive");

    let (status, _) = p.get(&format!("/api/analytics/losses?{day}")).await;
    assert_eq!(status, StatusCode::OK);
    let (status, v) = p.get("/api/analytics/floor").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["machines"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn reports_are_generated_listed_newest_first_and_only_the_latest_are_kept() {
    let p = press("linesentry_it_reports").await;
    let records = &p.state.store.records;
    records
        .ensure_hour(Id(p.machine), press_hour(10))
        .await
        .unwrap();
    p.counts(10, 7).await;

    let generate = json!({
        "type": "daily", "startDate": PRESS_DAY, "endDate": PRESS_DAY,
        "machineId": p.machine.to_hex(),
    });
    let mut last = Value::Null;
    for _ in 0..12 {
        let request = post_json("/api/reports/generate", Some(&p.token), generate.clone());
        let (status, v) = call(&p.app, request).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        last = v;
    }
    assert_eq!(last["metrics"]["totalUnitsProduced"], 7.0);
    assert_eq!(last["machineData"][0]["machineName"], "Press 1");
    assert_eq!(last["shiftData"][0]["shiftName"], "Morning");
    assert_eq!(last["shiftData"][0]["metrics"]["unitsProduced"], 7.0);
    assert!(last["_id"].is_string());
    let stored = &p.state.store.reports.rows;
    assert_eq!(
        stored.count(Filter::all()).await.unwrap(),
        10,
        "twelve were generated, the ten newest are kept"
    );

    let (status, v) = p.get("/api/reports?type=daily").await;
    assert_eq!(status, StatusCode::OK);
    let listed = v.as_array().unwrap();
    assert_eq!(listed.len(), 10);
    assert_eq!(listed[0]["_id"], last["_id"], "newest first and kept");
    assert_eq!(listed[0]["machineId"]["name"], "Press 1");
    assert_eq!(listed[0]["generatedBy"]["username"], "admin");
    assert!(listed[0]["generatedBy"].get("password").is_none());
    let (status, v) = p.get("/api/reports?type=weekly").await;
    assert_eq!((status, v.as_array().unwrap().len()), (StatusCode::OK, 0));

    let id = last["_id"].as_str().unwrap();
    let (status, _) = p.get(&format!("/api/reports/{id}/pdf")).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&p.app, delete(&format!("/api/reports/{id}"), &p.token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored.count(Filter::all()).await.unwrap(), 9);
    let (status, _) = call(&p.app, delete(&format!("/api/reports/{id}"), &p.token)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hours_at_returns_a_bucket_with_an_operator_and_a_timed_stoppage() {
    let state = setup_state("linesentry_it_hours_at", 0).await;
    let store = &state.store;
    let (machine, other) = (Id::new(), Id::new());
    let (operator, mold) = (ObjectId::new(), ObjectId::new());
    let at = factory_time("2026-06-01T08:30:00Z");

    // An hour as it looks once a person has worked on it: ids and dates that
    // are native BSON in the stored bucket.
    let note = records::StoppageNote {
        reason: "mold_change",
        description: Some("swap"),
        sap_number: None,
    };
    store
        .records
        .add_stoppage(machine, press_hour(8), 15.0, &note)
        .await
        .unwrap();
    let mut batch = store.batch();
    let assigned =
        store
            .records
            .queue_assignment(&mut batch, machine, at, Some(operator), Some(mold));
    store.records.queue_units(&mut batch, machine, at, 3, None);
    assert_eq!(batch.send().await.unwrap()[assigned].matched, 1);
    // A machine with a day but no bucket for this hour.
    store
        .records
        .ensure_hour(other, press_hour(9))
        .await
        .unwrap();

    let hours = store.records.hours_at(&[machine, other], at).await.unwrap();
    assert_eq!(hours.len(), 1, "only the machine with a bucket for hour 8");
    let bucket = hours.get(&machine).expect("the bucket must not be dropped");
    assert_eq!(bucket.hour, 8.0);
    assert_eq!(bucket.units_produced, 3.0);
    assert_eq!(bucket.operator_id, Some(Id(operator)));
    assert_eq!(bucket.mold_id, Some(Id(mold)));
    assert_eq!(bucket.stoppage_minutes, 15.0);
    assert_eq!(bucket.stoppages.len(), 1);
    assert_eq!(bucket.stoppages[0].start_time, Some(press_hour(8)));
    assert_eq!(
        bucket.stoppages[0].end_time,
        Some(press_hour(8) + chrono::Duration::minutes(15))
    );
    assert!(bucket.stoppages[0].id.is_some());

    // The same bucket as a whole-row read gives it.
    let rec = todays_record(store, machine.oid()).await;
    assert_eq!(hour_of(&rec, 8).operator_id, bucket.operator_id);
    assert!(store.records.hours_at(&[], at).await.unwrap().is_empty());
}

// ── Lists, users and machines ────────────────────────────────────────────────

#[tokio::test]
async fn lists_clamp_the_page_size_and_ignore_a_sort_that_is_not_a_field_name() {
    let (app, _state) = setup("linesentry_it_lists").await;
    let token = admin_token(&app).await;

    let query = "limit=100000&sortBy=$where";
    let (status, v) = call(
        &app,
        get(&format!("/api/users/admin/all?{query}"), Some(&token)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["pagination"]["limit"], 200);
    assert_eq!(v["filters"]["sortBy"], "");
    let users = v["users"].as_array().unwrap();
    assert!(!users.is_empty(), "the demo accounts are listed");
    assert_eq!(v["pagination"]["totalUsers"], users.len());

    // The other admin lists take the same query.
    for list in ["departments", "molds", "sensors"] {
        let uri = format!("/api/{list}/admin/all?{query}");
        let (status, v) = call(&app, get(&uri, Some(&token))).await;
        assert_eq!(status, StatusCode::OK, "{list}: {v}");
        assert_eq!(v["pagination"]["limit"], 200, "{list}");
    }

    // A page size below one is raised to one.
    let (status, v) = call(&app, get("/api/users/admin/all?limit=0", Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["pagination"]["limit"], 1);
    assert_eq!(v["users"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn renaming_a_user_to_a_taken_username_is_a_conflict() {
    let (app, state) = setup("linesentry_it_user_conflict").await;
    // The unique indexes are what make a username taken.
    state.store.ensure_schema().await.unwrap();
    let token = admin_token(&app).await;
    let create = |name: &str| {
        post_json(
            "/api/users",
            Some(&token),
            json!({
                "username": name, "email": format!("{name}@example.com"),
                "password": "secret-123", "role": "admin",
            }),
        )
    };

    let (status, first) = call(&app, create("first")).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    let (status, second) = call(&app, create("second")).await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    let (status, v) = call(&app, create("first")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{v}");

    let second_id = second["_id"].as_str().unwrap();
    let rename = |body: Value| {
        send_json(
            "PUT",
            &format!("/api/users/{second_id}"),
            Some(&token),
            body,
        )
    };
    let (status, v) = call(&app, rename(json!({ "username": "first" }))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["message"], "Username already exists");
    let (status, v) = call(&app, rename(json!({ "email": "first@example.com" }))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["message"], "Email already exists");

    // The rejected edits changed nothing, and a free name is accepted.
    let users = &state.store.users;
    let stored = users.by_username("second").await.unwrap().unwrap();
    assert_eq!(stored.email, "second@example.com");
    let (status, v) = call(&app, rename(json!({ "username": "third" }))).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["username"], "third");
    assert!(users.by_username("second").await.unwrap().is_none());
}

#[tokio::test]
async fn deleting_a_machine_frees_its_pins() {
    let (app, state) = setup("linesentry_it_machine_delete").await;
    let store = &state.store;
    let token = admin_token(&app).await;
    seed_plc(store, "default", None).await;
    let machine = seed_two_signal_machine(store).await;
    let kept = seed_machine(store, "inactive", "power", &["default"], "Q0.2").await;
    let on = |m: ObjectId| Filter::all().eq(sensors::f::MACHINE, m);
    let wired = store.sensors.rows.ids(on(machine)).await.unwrap();
    assert_eq!(wired.len(), 2);
    assert_eq!(store.pins.of_sensors(&wired).await.unwrap().len(), 2);
    // A reading and a production record, which go with the machine.
    pipeline::process_pin_data(&state, "default", POWER_AND_CYCLE, None)
        .await
        .unwrap();
    store.flush().await;

    let uri = format!("/api/machines/{}", machine.to_hex());
    let (status, v) = call(&app, delete(&uri, &token)).await;
    assert_eq!(status, StatusCode::OK, "{v}");

    assert!(store.pins.of_sensors(&wired).await.unwrap().is_empty());
    for pin in ["Q0.0", "Q0.1"] {
        assert!(!store.pins.is_taken("default", pin).await.unwrap(), "{pin}");
    }
    assert_eq!(store.sensors.rows.count(on(machine)).await.unwrap(), 0);
    assert_eq!(
        store.records.rows.count(records_of(machine)).await.unwrap(),
        0
    );
    assert!(store.signals.latest_on(machine).await.unwrap().is_empty());
    assert!(store.machines.rows.get(machine).await.unwrap().is_none());

    // Another machine's wiring is left alone.
    assert!(store.pins.is_taken("default", "Q0.2").await.unwrap());
    assert_eq!(
        store
            .pins
            .rows
            .count(Filter::all().eq(pins::f::PLC_ID, "default"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(store.sensors.rows.count(on(kept)).await.unwrap(), 1);

    // The freed pin can be wired again at once.
    let uri = format!("/api/machines/{}/signals", kept.to_hex());
    let rewire = json!({ "plcId": "default", "pinId": "Q0.0", "role": "unit-cycle" });
    let (status, v) = call(&app, post_json(&uri, Some(&token), rewire)).await;
    assert_eq!(status, StatusCode::CREATED, "{v}");
}
