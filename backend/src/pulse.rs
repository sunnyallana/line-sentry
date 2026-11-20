//! Pulse: the backend's periodic background work.
//!
//! Every job runs on its own timer in its own task, so a slow or failing job
//! never delays the others. Timers are jittered so that instances started
//! together do not all hit the database in the same instant.
//!
//! A job that changes shared data names a lease (see [`crate::lease`]). The
//! pulse takes the lease before the run, keeps it alive during the run and
//! records the result on it afterwards. With several backend instances behind
//! a load balancer, exactly one of them does the work each round. A job that
//! only touches this instance's memory runs without a lease.
//!
//! `PULSE_ENABLED=false` switches all of it off.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::AdminUser;
use crate::error::AppResult;
use crate::lease::{Lease, RunRecord};
use crate::routes::common::docs_to_json;
use crate::state::AppState;
use crate::{pipeline, routes};

/// Longest wait before a job's first run after boot.
const START_SPREAD: Duration = Duration::from_secs(30);
/// A job that keeps failing logs its first failure and then every Nth.
const REPEAT_FAILURE_LOG_EVERY: u32 = 10;

/// What a finished run reports back.
pub struct Done {
    pub detail: String,
    /// Stored on the lease row when the job is leased; only moves forward.
    pub cursor: Option<String>,
}

impl Done {
    pub fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            cursor: None,
        }
    }

    pub fn with_cursor(mut self, cursor: impl Into<String>) -> Self {
        self.cursor = Some(cursor.into());
        self
    }
}

pub type JobFuture = BoxFuture<'static, anyhow::Result<Done>>;

#[derive(Clone, Copy)]
pub struct Job {
    pub name: &'static str,
    pub every: Duration,
    /// Lease length. `None` runs the job on every instance without a lease.
    pub lease: Option<Duration>,
    /// Gets the cursor stored by the last successful leased run.
    pub run: fn(AppState, Option<String>) -> JobFuture,
}

pub enum Outcome {
    Ran(Done),
    Failed(String),
    /// Another instance holds the lease. Normal on all but one instance.
    HeldElsewhere,
    /// The lease expired mid-run and the work was stopped or not recorded.
    LeaseLost,
}

/// The jobs this backend runs.
pub fn jobs() -> Vec<Job> {
    vec![
        Job {
            name: "stoppage-tick",
            every: Duration::from_secs(60),
            lease: Some(Duration::from_secs(120)),
            run: |state, _| {
                Box::pin(async move {
                    let now = state.config.factory_now();
                    let ticked = pipeline::tick_ongoing_stoppages(&state, now).await?;
                    Ok(Done::new(format!("{ticked} ongoing stoppage(s) updated")))
                })
            },
        },
        Job {
            name: "silent-plc-sweep",
            every: Duration::from_secs(30),
            lease: Some(Duration::from_secs(120)),
            run: |state, _| {
                Box::pin(async move {
                    let idled = pipeline::sweep_silent_plcs(&state, Utc::now()).await?;
                    Ok(Done::new(format!("{idled} machine(s) set inactive")))
                })
            },
        },
        Job {
            name: "stoppage-alerts",
            every: Duration::from_secs(60),
            lease: Some(Duration::from_secs(120)),
            run: |state, _| {
                Box::pin(async move {
                    let now = state.config.factory_now();
                    Ok(crate::alerts::run(&state, now).await?)
                })
            },
        },
        Job {
            name: "daily-report",
            every: Duration::from_secs(300),
            lease: Some(Duration::from_secs(300)),
            run: |state, sent_through| {
                Box::pin(async move {
                    let now = state.config.factory_now();
                    Ok(routes::reports::run_daily_schedule(&state, sent_through, now).await?)
                })
            },
        },
    ]
}

/// Start one task per job. Does nothing when the pulse is switched off.
pub fn spawn(state: &AppState, jobs: Vec<Job>) {
    if !state.config.pulse_enabled {
        tracing::warn!("pulse is off (PULSE_ENABLED=false): no background jobs will run");
        return;
    }
    for job in jobs {
        tokio::spawn(run_forever(state.clone(), job));
    }
}

async fn run_forever(state: AppState, job: Job) {
    tokio::time::sleep(jitter_up_to(job.every.min(START_SPREAD))).await;
    loop {
        let run_state = state.clone();
        let outcome = tokio::spawn(async move { run_once(&run_state, &job).await })
            .await
            .unwrap_or_else(|e| Outcome::Failed(format!("job stopped unexpectedly: {e}")));
        state.pulse.record(&job, &outcome);
        tokio::time::sleep(jitter_around(job.every)).await;
    }
}

/// One round of a job, lease handling included.
pub async fn run_once(state: &AppState, job: &Job) -> Outcome {
    let Some(ttl) = job.lease else {
        return match (job.run)(state.clone(), None).await {
            Ok(done) => Outcome::Ran(done),
            Err(e) => Outcome::Failed(format!("{e:#}")),
        };
    };

    let lease = match Lease::try_take(&state.store, job.name, &state.pulse.instance, ttl).await {
        Ok(Some(lease)) => lease,
        Ok(None) => return Outcome::HeldElsewhere,
        Err(e) => return Outcome::Failed(format!("taking the lease: {e}")),
    };

    let result = {
        let work = (job.run)(state.clone(), lease.cursor.clone());
        tokio::select! {
            r = work => Some(r),
            _ = until_lost(&lease) => None,
        }
    };
    let Some(result) = result else {
        return Outcome::LeaseLost;
    };

    let (ok, detail, cursor) = match &result {
        Ok(done) => (true, done.detail.clone(), done.cursor.clone()),
        Err(e) => (false, format!("{e:#}"), None),
    };
    let recorded = lease
        .finish(RunRecord {
            ok,
            detail: &detail,
            cursor: cursor.as_deref(),
        })
        .await;
    let outcome = match result {
        Ok(done) => Outcome::Ran(done),
        Err(_) => Outcome::Failed(detail),
    };

    match recorded {
        Ok(true) => outcome,
        Ok(false) => Outcome::LeaseLost,
        Err(e) => {
            tracing::warn!(job = job.name, "could not record the run on the lease: {e}");
            outcome
        }
    }
}

/// Renews the lease at a quarter of its length and returns once it is lost.
/// A failed renew call is retried until a full lease length has passed without
/// a success, after which the lease has to be treated as gone.
async fn until_lost(lease: &Lease<'_>) {
    let step = lease.ttl() / 4;
    let mut last_renewed = Instant::now();
    loop {
        tokio::time::sleep(step).await;
        let asked_at = Instant::now();
        match lease.renew().await {
            Ok(true) => last_renewed = asked_at,
            Ok(false) => return,
            Err(e) => {
                if last_renewed.elapsed() >= lease.ttl() {
                    return;
                }
                tracing::warn!("lease renew failed, will retry: {e}");
            }
        }
    }
}

fn random_unit() -> f64 {
    RandomState::new().build_hasher().finish() as f64 / u64::MAX as f64
}

fn jitter_up_to(max: Duration) -> Duration {
    max.mul_f64(random_unit())
}

/// `every`, give or take 10%.
fn jitter_around(every: Duration) -> Duration {
    every.mul_f64(0.9 + 0.2 * random_unit())
}

// ── Status ───────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobStatus {
    every_seconds: u64,
    leased: bool,
    last_outcome: &'static str,
    last_detail: String,
    last_at: DateTime<Utc>,
    consecutive_failures: u32,
}

/// What this instance's jobs last did. Lease rows hold the cross-instance view.
pub struct Pulse {
    /// Names this process as a lease holder; new on every start.
    pub instance: String,
    jobs: DashMap<&'static str, JobStatus>,
}

impl Pulse {
    pub fn new() -> Self {
        Self {
            instance: bson::oid::ObjectId::new().to_hex(),
            jobs: DashMap::new(),
        }
    }

    fn record(&self, job: &Job, outcome: &Outcome) {
        let failures_before = self
            .jobs
            .get(job.name)
            .map(|s| s.consecutive_failures)
            .unwrap_or(0);

        let (label, detail, failures) = match outcome {
            Outcome::Ran(done) => ("ok", done.detail.clone(), 0),
            Outcome::HeldElsewhere => ("held-elsewhere", String::new(), 0),
            Outcome::LeaseLost => ("lease-lost", String::new(), failures_before + 1),
            Outcome::Failed(e) => ("failed", e.clone(), failures_before + 1),
        };

        match outcome {
            Outcome::Ran(_) if failures_before > 0 => tracing::info!(
                job = job.name,
                "recovered after {failures_before} failed run(s): {detail}"
            ),
            Outcome::Ran(_) => tracing::debug!(job = job.name, "{detail}"),
            Outcome::HeldElsewhere => {
                tracing::trace!(job = job.name, "lease held by another instance")
            }
            Outcome::LeaseLost => {
                tracing::warn!(job = job.name, "lease lost during the run; work stopped")
            }
            Outcome::Failed(_)
                if failures == 1 || failures.is_multiple_of(REPEAT_FAILURE_LOG_EVERY) =>
            {
                tracing::warn!(job = job.name, failures, "run failed: {detail}")
            }
            Outcome::Failed(_) => {}
        }

        self.jobs.insert(
            job.name,
            JobStatus {
                every_seconds: job.every.as_secs(),
                leased: job.lease.is_some(),
                last_outcome: label,
                last_detail: detail,
                last_at: Utc::now(),
                consecutive_failures: failures,
            },
        );
    }
}

impl Default for Pulse {
    fn default() -> Self {
        Self::new()
    }
}

/// `GET /api/pulse` (admin): this instance's jobs plus every lease row.
pub async fn status(_admin: AdminUser, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let jobs: serde_json::Map<String, Value> = state
        .pulse
        .jobs
        .iter()
        .map(|e| (e.key().to_string(), json!(e.value())))
        .collect();
    let leases = state.store.leases.all().await?;
    Ok(Json(json!({
        "enabled": state.config.pulse_enabled,
        "instance": state.pulse.instance,
        "jobs": jobs,
        "leases": docs_to_json(leases),
    })))
}
