//! Alerts that were raised. Each has a unique `key` naming the thing and the
//! level, so an alert is raised, and sent, exactly once however many instances
//! or rounds notice the same condition.

use bson::{doc, oid::ObjectId, Bson, Document};
use futures::TryStreamExt;
use mongodb::options::IndexOptions;
use mongodb::{Database, IndexModel};
use serde::{Deserialize, Serialize};

use super::{is_duplicate_key, Changes, DbResult, Entity, Filter, Persister};

pub const ALERTS: &str = "alerts";

#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
pub struct AlertRow(pub Document);

impl Entity for AlertRow {
    const COLLECTION: &'static str = ALERTS;
}

pub mod f {
    pub const KEY: &str = "key";
    pub const AT: &str = "at";
    pub const DEPARTMENT: &str = "departmentId";
    pub const DELIVERIES: &str = "deliveries";
}

/// How one channel fared for one alert.
pub struct Delivery {
    pub channel: &'static str,
    pub error: Option<String>,
}

pub struct Alerts {
    pub rows: Persister<AlertRow>,
}

impl Alerts {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    pub async fn ensure_indexes(&self) -> DbResult<()> {
        self.rows
            .raw()
            .create_index(
                IndexModel::builder()
                    .keys(doc! { f::KEY: 1 })
                    .options(IndexOptions::builder().unique(true).build())
                    .build(),
            )
            .await?;
        self.rows
            .raw()
            .create_index(IndexModel::builder().keys(doc! { f::AT: -1 }).build())
            .await?;
        Ok(())
    }

    /// Record the alert unless one with the same key exists. `Some(id)` means
    /// this caller raised it and must deliver it.
    pub async fn claim(&self, alert: Document) -> DbResult<Option<ObjectId>> {
        match self.rows.raw().insert_one(alert).await {
            Ok(res) => Ok(res.inserted_id.as_object_id()),
            Err(e) if is_duplicate_key(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn record_deliveries(&self, id: ObjectId, deliveries: &[Delivery]) -> DbResult<()> {
        let rows: Vec<Bson> = deliveries
            .iter()
            .map(|d| {
                Bson::Document(doc! {
                    "channel": d.channel,
                    "ok": d.error.is_none(),
                    "error": d.error.clone().map(Bson::String).unwrap_or(Bson::Null),
                })
            })
            .collect();
        self.rows
            .update(Filter::id(id), Changes::new().set(f::DELIVERIES, rows))
            .await?;
        Ok(())
    }

    /// The newest alerts, optionally for one department only.
    pub async fn recent(
        &self,
        department: Option<ObjectId>,
        limit: i64,
    ) -> DbResult<Vec<Document>> {
        let mut filter = Filter::all();
        if let Some(d) = department {
            filter = filter.eq(f::DEPARTMENT, d);
        }
        self.rows
            .raw()
            .find(filter.into_doc())
            .sort(doc! { f::AT: -1 })
            .limit(limit)
            .await?
            .try_collect()
            .await
    }
}
