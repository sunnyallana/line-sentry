//! LineSentry edge daemon: reads a PLC digital byte (or simulates one) and posts
//! it to the backend's `/api/signals/pin-data` endpoint with the `X-API-Key`
//! header. Reliable 24/7 operation: retry with exponential backoff + jitter and
//! graceful shutdown.

mod config;
mod source;

use std::time::Duration;

use serde_json::{json, Value};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::source::Source;

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
    let client = reqwest::Client::builder().timeout(cfg.request_timeout).build()?;
    let url = format!("{}/api/signals/pin-data", cfg.backend_url.trim_end_matches('/'));

    let mut failures: u32 = 0;
    let mut ticker = tokio::time::interval(cfg.interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("shutdown signal received; stopping");
                break;
            }
            _ = ticker.tick() => {
                let byte = match src.read_byte() {
                    Ok(b) => b,
                    Err(e) => { tracing::error!("signal read error: {e:#}"); continue; }
                };
                let payload = json!({
                    "pinData": format!("{byte:02x}"),
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                });
                match send(&client, &url, &cfg.api_key, &payload).await {
                    Ok(processed) => {
                        failures = 0;
                        if processed.is_empty() {
                            tracing::debug!("sent pin data {byte:08b}");
                        } else {
                            tracing::info!("processed machines: {processed:?}");
                        }
                    }
                    Err(e) => {
                        failures += 1;
                        tracing::error!("post failed: {e}");
                        if failures >= cfg.retry_attempts {
                            let delay = backoff(cfg.retry_delay, failures);
                            tracing::warn!("{failures} consecutive failures; backing off {delay:?}");
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
            }
        }
    }
    Ok(())
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
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
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
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
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
