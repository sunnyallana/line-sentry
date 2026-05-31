//! MongoDB connection and index management.

use std::time::Duration;

use anyhow::Context;
use bson::doc;
use mongodb::options::ClientOptions;
use mongodb::{Client, Database};

use crate::config::Config;

/// Connect to MongoDB with a pooled client and verify connectivity with a ping.
pub async fn connect(config: &Config) -> anyhow::Result<Database> {
    let mut opts = ClientOptions::parse(&config.mongodb_uri)
        .await
        .context("parsing MONGODB_URI")?;
    opts.max_pool_size = Some(20);
    opts.min_pool_size = Some(2);
    opts.server_selection_timeout = Some(Duration::from_secs(5));
    opts.app_name = Some("linesentry-backend".to_string());

    let client = Client::with_options(opts).context("building MongoDB client")?;
    let db = client.database(&config.db_name);

    db.run_command(doc! { "ping": 1 })
        .await
        .context("pinging MongoDB")?;

    Ok(db)
}

/// Quick connectivity probe used by the health/readiness endpoints.
pub async fn ping(db: &Database) -> bool {
    db.run_command(doc! { "ping": 1 }).await.is_ok()
}
