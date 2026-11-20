//! Lease rows. See `crate::lease` for what a lease is; this is how it is
//! stored. Expiry is compared against the database clock (`$$NOW`), which
//! needs update pipelines, so these writes are spelled out here rather than
//! built from `Changes`.

use std::time::Duration;

use bson::{doc, oid::ObjectId, Bson, Document};
use futures::TryStreamExt;
use mongodb::options::ReturnDocument;
use mongodb::Database;
use serde::{Deserialize, Serialize};

use super::{is_duplicate_key, DbResult, Entity, Persister};

pub const LEASES: &str = "leases";

#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
pub struct LeaseRow(pub Document);

impl Entity for LeaseRow {
    const COLLECTION: &'static str = LEASES;
}

const HOLDER: &str = "holder";
const TOKEN: &str = "token";
const EXPIRES: &str = "expiresAt";
const CURSOR: &str = "cursor";

/// Inside an update pipeline a string starting with `$` is read as a field
/// path, so stored text goes through `$literal`.
fn literal(value: impl Into<Bson>) -> Document {
    doc! { "$literal": value.into() }
}

fn expiry_in(ttl: Duration) -> Document {
    doc! { "$add": ["$$NOW", ttl.as_millis() as i64] }
}

pub struct Leases {
    rows: Persister<LeaseRow>,
}

impl Leases {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// Take the lease if it has expired. Returns the row as taken.
    pub async fn take(
        &self,
        name: &str,
        holder: &str,
        token: ObjectId,
        ttl: Duration,
    ) -> DbResult<Option<Document>> {
        let attempt = || {
            self.rows
                .raw()
                .find_one_and_update(
                    doc! { "_id": name, "$expr": { "$lte": [format!("${EXPIRES}"), "$$NOW"] } },
                    vec![doc! { "$set": {
                        HOLDER: literal(holder.to_string()),
                        TOKEN: literal(token),
                        "takenAt": "$$NOW",
                        EXPIRES: expiry_in(ttl),
                    }}],
                )
                .return_document(ReturnDocument::After)
        };
        if let Some(row) = attempt().await? {
            return Ok(Some(row));
        }
        if self.create_free(name).await? {
            return attempt().await;
        }
        Ok(None)
    }

    /// Insert the row in the free state if it does not exist yet.
    async fn create_free(&self, name: &str) -> DbResult<bool> {
        let created = self
            .rows
            .raw()
            .update_one(
                doc! { "_id": name },
                doc! { "$setOnInsert": { EXPIRES: bson::DateTime::from_millis(0) } },
            )
            .upsert(true)
            .await;
        match created {
            Ok(r) => Ok(r.upserted_id.is_some()),
            Err(e) if is_duplicate_key(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Push the expiry out. False when the token no longer holds the lease.
    pub async fn renew(&self, name: &str, token: ObjectId, ttl: Duration) -> DbResult<bool> {
        let res = self
            .rows
            .raw()
            .update_one(
                doc! { "_id": name, TOKEN: token },
                vec![doc! { "$set": { EXPIRES: expiry_in(ttl) } }],
            )
            .await?;
        Ok(res.matched_count == 1)
    }

    /// Record a run and free the lease in one write. False when the token no
    /// longer holds it. The cursor never moves backwards.
    pub async fn finish(
        &self,
        name: &str,
        token: ObjectId,
        ok: bool,
        detail: &str,
        cursor: Option<&str>,
    ) -> DbResult<bool> {
        let cursor = cursor
            .map(|c| Bson::Document(literal(c.to_string())))
            .unwrap_or(Bson::Null);
        let res = self
            .rows
            .raw()
            .update_one(
                doc! { "_id": name, TOKEN: token },
                vec![doc! { "$set": {
                    EXPIRES: "$$NOW",
                    "lastRunAt": "$$NOW",
                    "lastStatus": if ok { "ok" } else { "failed" },
                    "lastDetail": literal(detail.to_string()),
                    CURSOR: { "$max": [format!("${CURSOR}"), cursor] },
                }}],
            )
            .await?;
        Ok(res.matched_count == 1)
    }

    pub async fn all(&self) -> DbResult<Vec<Document>> {
        self.rows.raw().find(doc! {}).await?.try_collect().await
    }

    /// One lease row. Tests only; the status view reads them all.
    #[cfg(test)]
    pub async fn get(&self, name: &str) -> DbResult<Option<Document>> {
        self.rows.raw().find_one(doc! { "_id": name }).await
    }

    /// Hand the lease to another holder, as an expiry and retake would. Tests only.
    #[cfg(test)]
    pub async fn steal(&self, name: &str, holder: &str) -> DbResult<()> {
        self.rows
            .raw()
            .update_one(
                doc! { "_id": name },
                doc! { "$set": { TOKEN: ObjectId::new(), HOLDER: holder } },
            )
            .await?;
        Ok(())
    }
}

/// The cursor stored on a lease row.
pub fn cursor_of(row: &Document) -> Option<String> {
    row.get_str(CURSOR).ok().map(str::to_string)
}
