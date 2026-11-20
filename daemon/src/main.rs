//! LineSentry edge daemon: reads a PLC's digital bytes (or simulates them) on a
//! fixed beat and delivers every reading to the backend with the `X-API-Key`
//! header.
//!
//! Reading and delivering are separate. A reading goes into an outbox with the
//! time it was taken and leaves only when the backend has accepted it, so an
//! outage delays readings instead of losing them (see `outbox`). Delivery
//! retries with exponential backoff and jitter while the beat keeps reading.

mod config;
mod outbox;
mod source;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::outbox::{Outbox, Reading};
use crate::source::Source;

/// Readings held while the backend is unreachable: an hour at one per second.
const OUTBOX_CAPACITY: usize = 3600;
/// Most readings in one replay request. Matches the backend's limit.
const MAX_BATCH: usize = 600;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config_path = std::env::var("DAEMON_CONFIG").unwrap_or_else(|_| "config.json".into());
    let cfg = Config::load(&config_path);
    if cfg.api_key.is_empty() {
        tracing::warn!("DAEMON_API_KEY is empty — the backend will reject ingestion with 401");
    }
    tracing::info!(
        backend = %cfg.backend_url,
        source = ?cfg.source,
        interval_ms = cfg.interval.as_millis() as u64,
        "LineSentry daemon starting"
    );

    let mut src = Source::from_config(&cfg)?;
    let client = reqwest::Client::builder()
        .timeout(cfg.request_timeout)
        .build()?;
    let base = cfg.backend_url.trim_end_matches('/').to_string();
    let single_url = format!("{base}/api/signals/pin-data");
    let batch_url = format!("{base}/api/signals/pin-data/batch");

    let mut outbox = Outbox::new(OUTBOX_CAPACITY);
    let mut ticker = tokio::time::interval(cfg.interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("shutdown signal received; stopping");
                // One last try, so a clean stop does not leave readings behind.
                if !outbox.is_empty() {
                    deliver(&client, &single_url, &batch_url, &cfg, &mut outbox).await;
                }
                if !outbox.is_empty() {
                    tracing::warn!("{} reading(s) could not be delivered before stopping", outbox.len());
                }
                break;
            }
            _ = ticker.tick() => {
                match src.read(cfg.byte_count) {
                    Ok(bytes) => outbox.push(Reading {
                        pin_data: bytes.iter().map(|b| format!("{b:02x}")).collect(),
                        timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    }),
                    Err(e) => tracing::error!("signal read error: {e:#}"),
                }
                let dropped = outbox.take_dropped();
                if dropped > 0 {
                    tracing::error!("outbox full: dropped the {dropped} oldest reading(s)");
                }
                if outbox.should_attempt(Instant::now()) {
                    deliver(&client, &single_url, &batch_url, &cfg, &mut outbox).await;
                }
            }
        }
    }
    Ok(())
}

/// Send what the outbox holds: one reading on the normal path, a batch when
/// readings have piled up. Keeps sending batches while they succeed, so a
/// backlog clears quickly once the backend is back.
async fn deliver(
    client: &reqwest::Client,
    single_url: &str,
    batch_url: &str,
    cfg: &Config,
    outbox: &mut Outbox,
) {
    while !outbox.is_empty() {
        let readings = outbox.oldest(MAX_BATCH);
        let backlog = readings.len() > 1;
        let (url, payload) = if backlog {
            let items: Vec<Value> = readings
                .iter()
                .map(|r| json!({ "pinData": r.pin_data, "timestamp": r.timestamp }))
                .collect();
            (batch_url, json!({ "plcId": cfg.plc_id, "readings": items }))
        } else {
            let r = &readings[0];
            (
                single_url,
                json!({ "plcId": cfg.plc_id, "pinData": r.pin_data, "timestamp": r.timestamp }),
            )
        };

        match send(client, url, &cfg.api_key, &payload).await {
            Ok(processed) => {
                if outbox.failures() > 0 {
                    tracing::info!(
                        "backend reachable again; replaying {} held reading(s)",
                        outbox.len()
                    );
                }
                outbox.delivered(readings.len());
                if backlog {
                    tracing::info!(
                        "replayed {} reading(s), {} left",
                        readings.len(),
                        outbox.len()
                    );
                } else if processed.is_empty() {
                    tracing::debug!("sent pin data {}", readings[0].pin_data);
                } else {
                    tracing::info!("processed machines: {processed:?}");
                }
            }
            Err(e) => {
                let failures = outbox.failed();
                let delay = if failures >= cfg.retry_attempts {
                    backoff(cfg.retry_delay, failures)
                } else {
                    Duration::ZERO
                };
                outbox.wait(Instant::now(), delay);
                // The first failure and every tenth, so an outage does not flood the log.
                if failures == 1 || failures.is_multiple_of(10) {
                    tracing::error!(
                        "delivery failed ({failures} in a row, {} reading(s) held, next try in {delay:?}): {e}",
                        outbox.len()
                    );
                }
                return;
            }
        }
    }
}

/// POST the payload; returns the machine ids the backend reported processing.
async fn send(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    payload: &Value,
) -> anyhow::Result<Vec<String>> {
    let mut req = client.post(url).json(payload);
    if !api_key.is_empty() {
        req = req.header("X-API-Key", api_key);
    }
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("backend returned {status}");
    }
    let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    Ok(body
        .get("processedMachines")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

/// Exponential backoff with jitter, capped at 60s.
fn backoff(base: Duration, failures: u32) -> Duration {
    let factor = 2u64.saturating_pow(failures.min(6).saturating_sub(1));
    let millis = (base.as_millis() as u64).saturating_mul(factor).min(60_000);
    let jitter = (rand::random::<f64>() * 500.0) as u64;
    Duration::from_millis(millis + jitter)
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,linesentry_daemon=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
