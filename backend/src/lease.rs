//! Database leases: at most one backend instance does a given piece of
//! background work at a time.
//!
//! A lease is one row, keyed by the job name. An instance takes it only when
//! the previous holder's time has run out, renews it while it works, and frees
//! it when it is done. If the holder dies, the lease simply expires and another
//! instance takes over.
//!
//! All expiry maths uses the database clock, so instances whose own clocks
//! disagree cannot both believe they hold the lease. Each take writes a fresh
//! token and every later write is conditional on that token, so a holder that
//! lost the lease can no longer change the row.
//!
//! The row also keeps the last run's result and a `cursor` that only moves
//! forward, which is how a scheduled job remembers what it has already done.
//! How the row is stored is in [`crate::persist::leases`].

use std::time::Duration;

use bson::oid::ObjectId;

use crate::persist::leases::cursor_of;
use crate::persist::{DbResult, Store};

/// How a leased run ended. Stored on the lease row for the status endpoint.
pub struct RunRecord<'a> {
    pub ok: bool,
    pub detail: &'a str,
    /// New cursor value. The stored cursor never moves backwards.
    pub cursor: Option<&'a str>,
}

pub struct Lease<'a> {
    store: &'a Store,
    name: String,
    token: ObjectId,
    ttl: Duration,
    /// Cursor stored by the last successful run, read when the lease was taken.
    pub cursor: Option<String>,
}

impl<'a> Lease<'a> {
    /// Take the lease if nobody holds it. `Ok(None)` means another instance
    /// holds it, which is the normal, quiet outcome on all but one instance.
    pub async fn try_take(
        store: &'a Store,
        name: &str,
        holder: &str,
        ttl: Duration,
    ) -> DbResult<Option<Lease<'a>>> {
        let token = ObjectId::new();
        let row = store.leases.take(name, holder, token, ttl).await?;
        Ok(row.map(|r| Lease {
            cursor: cursor_of(&r),
            store,
            name: name.to_string(),
            token,
            ttl,
        }))
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    /// Push the expiry out by one more `ttl`. `Ok(false)` means the lease was
    /// lost (it expired and another instance took it); the caller must stop.
    pub async fn renew(&self) -> DbResult<bool> {
        self.store
            .leases
            .renew(&self.name, self.token, self.ttl)
            .await
    }

    /// Record the run and free the lease in one write. `Ok(false)` means the
    /// lease was no longer ours, so nothing was recorded.
    pub async fn finish(self, run: RunRecord<'_>) -> DbResult<bool> {
        self.store
            .leases
            .finish(&self.name, self.token, run.ok, run.detail, run.cursor)
            .await
    }
}
