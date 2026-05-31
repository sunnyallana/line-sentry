//! Daemon configuration: read `config.json` (compatible with the Python daemon),
//! then let environment variables override secrets/endpoints.

use std::time::Duration;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Simulator,
    Plc,
}

#[derive(Debug, Clone)]
pub struct PlcConfig {
    pub ip: String,
    pub rack: i32,
    pub slot: i32,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub backend_url: String,
    pub api_key: String,
    pub interval: Duration,
    pub retry_attempts: u32,
    pub retry_delay: Duration,
    pub request_timeout: Duration,
    pub source: SourceKind,
    pub plc: PlcConfig,
}

// ── Raw file shape (mirrors python-daemon/config.json) ───────────────────────
#[derive(Deserialize, Default)]
struct FileConfig {
    #[serde(default)]
    backend: BackendFile,
    #[serde(default)]
    daemon: DaemonFile,
    #[serde(default)]
    plc: Option<PlcFile>,
}

#[derive(Deserialize)]
struct BackendFile {
    url: String,
}
impl Default for BackendFile {
    fn default() -> Self {
        Self { url: "http://localhost:3001".into() }
    }
}

#[derive(Deserialize, Default)]
struct DaemonFile {
    interval_seconds: Option<f64>,
    retry_attempts: Option<u32>,
    retry_delay: Option<u64>,
    request_timeout: Option<u64>,
    api_key: Option<String>,
    source: Option<String>,
}

#[derive(Deserialize)]
struct PlcFile {
    ip: String,
    rack: i32,
    slot: i32,
}

impl Config {
    pub fn load(path: &str) -> Self {
        let file: FileConfig = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());

        let backend_url = env("BACKEND_URL").unwrap_or(file.backend.url);
        let api_key = env("DAEMON_API_KEY").or(file.daemon.api_key).unwrap_or_default();

        let interval_secs = env("INTERVAL_SECONDS")
            .and_then(|v| v.parse().ok())
            .or(file.daemon.interval_seconds)
            .unwrap_or(1.0)
            .max(0.05);

        let source = match env("SOURCE")
            .or(file.daemon.source)
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("plc") => SourceKind::Plc,
            _ => SourceKind::Simulator,
        };

        let plc = PlcConfig {
            ip: env("PLC_IP").or_else(|| file.plc.as_ref().map(|p| p.ip.clone())).unwrap_or_else(|| "192.168.0.1".into()),
            rack: env("PLC_RACK").and_then(|v| v.parse().ok()).or_else(|| file.plc.as_ref().map(|p| p.rack)).unwrap_or(0),
            slot: env("PLC_SLOT").and_then(|v| v.parse().ok()).or_else(|| file.plc.as_ref().map(|p| p.slot)).unwrap_or(1),
        };

        Config {
            backend_url,
            api_key,
            interval: Duration::from_secs_f64(interval_secs),
            retry_attempts: file.daemon.retry_attempts.unwrap_or(3),
            retry_delay: Duration::from_secs(file.daemon.retry_delay.unwrap_or(5)),
            request_timeout: Duration::from_secs(file.daemon.request_timeout.unwrap_or(10)),
            source,
            plc,
        }
    }
}
