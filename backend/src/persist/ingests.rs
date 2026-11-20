//! Receipts for applied payloads. A row lives for a few minutes (TTL index),
//! long enough for a daemon's retry to be recognised on any instance.

use mongodb::Database;
use serde::{Deserialize, Serialize};

use super::{is_duplicate_key, DbResult, Entity, Persister};

pub const INGESTS: &str = "ingests";

#[derive(Serialize, Deserialize)]
pub struct Receipt {
    #[serde(rename = "_id")]
    pub key: String,
    pub at: bson::DateTime,
}

impl Entity for Receipt {
    const COLLECTION: &'static str = INGESTS;
}

pub struct Ingests {
    rows: Persister<Receipt>,
}

impl Ingests {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// True when no instance has applied this payload before. The unique `_id`
    /// makes the answer the same for everyone who asks.
    pub async fn claim(&self, key: &str) -> DbResult<bool> {
        let receipt = Receipt {
            key: key.to_string(),
            at: bson::DateTime::now(),
        };
        match self
            .rows
            .raw()
            .insert_one(bson::to_document(&receipt)?)
            .await
        {
            Ok(_) => Ok(true),
            Err(e) if is_duplicate_key(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }
}
