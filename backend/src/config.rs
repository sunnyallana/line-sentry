//! Application configuration, loaded from the environment.
//!
//! Mirrors the variables used by the legacy Node server (`server/.env.example`)
//! so the two backends are drop-in compatible, plus a few Rust-specific ones
//! (`BIND_ADDR`, `DB_NAME`, `REDIS_URL`, `RUST_LOG`).

use std::env;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    /// Socket address to bind, e.g. `0.0.0.0:3001`.
    pub bind_addr: String,
    pub mongodb_uri: String,
    pub db_name: String,
    pub jwt_secret: String,
    pub jwt_expires_in: Duration,
    /// Shared secret the PLC daemon presents via `X-API-Key`.
    pub daemon_api_key: String,
    /// reCAPTCHA secret; when present, login CAPTCHA is enforced.
    pub recaptcha_secret: Option<String>,
    /// Allowed browser origins for CORS + Socket.IO.
    pub cors_origins: Vec<String>,
    /// When set, Socket.IO uses the Redis adapter (horizontal scaling).
    pub redis_url: Option<String>,
    pub is_production: bool,
    // Rate limiting (fixed window).
    pub rate_limit_window: Duration,
    pub rate_limit_auth_max: u32,
    pub rate_limit_general_max: u32,
}

fn require(key: &str) -> anyhow::Result<String> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => anyhow::bail!("missing required environment variable: {key} (see backend/.env.example)"),
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let is_production = env::var("APP_ENV")
            .ok()
            .or_else(|| env::var("NODE_ENV").ok())
            .map(|v| v.eq_ignore_ascii_case("production"))
            .unwrap_or(false);

        let jwt_secret = require("JWT_SECRET")?;
        let mongodb_uri = require("MONGODB_URI")?;
        let daemon_api_key = require("DAEMON_API_KEY")?;

        let recaptcha_secret =
            env::var("RECAPTCHA_SECRET_KEY").ok().filter(|s| !s.trim().is_empty());
        if is_production && recaptcha_secret.is_none() {
            anyhow::bail!("RECAPTCHA_SECRET_KEY is required when APP_ENV/NODE_ENV=production");
        }

        let cors_origins = env::var("CORS_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:5173".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let db_name = env::var("DB_NAME").unwrap_or_else(|_| "industrial_iot".into());

        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| {
            let port = env::var("PORT").unwrap_or_else(|_| "3001".into());
            format!("0.0.0.0:{port}")
        });

        let redis_url = env::var("REDIS_URL").ok().filter(|s| !s.trim().is_empty());

        let jwt_expires_in = env::var("JWT_EXPIRES_IN")
            .ok()
            .and_then(|s| parse_duration(&s))
            .unwrap_or_else(|| Duration::from_secs(24 * 3600));

        let rate_limit_window = env::var("RATE_LIMIT_WINDOW_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(15 * 60));
        let rate_limit_auth_max = env::var("RATE_LIMIT_AUTH_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5);
        let rate_limit_general_max = env::var("RATE_LIMIT_GENERAL_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);

        Ok(Self {
            bind_addr,
            mongodb_uri,
            db_name,
            jwt_secret,
            jwt_expires_in,
            daemon_api_key,
            recaptcha_secret,
            cors_origins,
            redis_url,
            is_production,
            rate_limit_window,
            rate_limit_auth_max,
            rate_limit_general_max,
        })
    }
}

/// Parse simple duration strings like `24h`, `30m`, `45s`, `7d`, or a bare
/// number of seconds.
fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (num, unit) = s.split_at(s.len() - 1);
    let mult = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        // No recognised unit suffix: treat the whole string as seconds.
        _ => return s.parse::<u64>().ok().map(Duration::from_secs),
    };
    num.parse::<u64>().ok().map(|n| Duration::from_secs(n * mult))
}
