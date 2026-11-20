//! Persisters: the only place the backend talks to MongoDB.
//!
//! Feature code (routes, the pipeline, background jobs) and tests never build a
//! query by hand. They ask an entity's persister for what they need in domain
//! terms (`machines.claim_running_minute(..)`), and conditions that vary are
//! expressed with the typed [`Filter`] and [`Changes`] builders. Everything
//! that knows field names, operators or index shapes is under this module, so
//! a schema change is made in one file and a slow query has one owner.
//!
//! Layout:
//!   * `filter`: [`Filter`], [`Changes`]; the query vocabulary.
//!   * this file: [`Persister<T>`], the generic operations every entity gets,
//!     [`Batch`], which sends many writes in one round trip, and [`Store`],
//!     which hands out the entity persisters.
//!   * `paging`: the page-plus-total read the joined admin lists share.
//!   * one file per entity with its field names and named operations.

pub mod alerts;
pub mod bulk_writer;
pub mod configs;
pub mod departments;
pub mod filter;
pub mod ingests;
pub mod leases;
pub mod machines;
pub mod molds;
pub mod paging;
pub mod pins;
pub mod plcs;
pub mod records;
pub mod reports;
pub mod schema;
pub mod sensors;
pub mod signals;
pub mod users;

use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bson::{doc, oid::ObjectId, Bson, Document};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use mongodb::options::{ReturnDocument, UpdateOneModel, WriteModel};
use mongodb::{Client, Collection, Database, Namespace};
use serde::de::DeserializeOwned;
use serde::Serialize;

pub use bulk_writer::BulkEntityWriter;
pub use filter::{Changes, Filter};

use crate::models::Id;

pub type DbResult<T> = Result<T, mongodb::error::Error>;

/// A stored type and the collection it lives in.
pub trait Entity: Serialize + DeserializeOwned + Unpin + Send + Sync {
    const COLLECTION: &'static str;
}

/// True for a unique-index violation: "someone else got there first".
pub fn is_duplicate_key(e: &mongodb::error::Error) -> bool {
    use mongodb::error::{ErrorKind, WriteFailure};
    match e.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(w)) => w.code == 11000,
        ErrorKind::Command(c) => c.code == 11000,
        ErrorKind::BulkWrite(b) => b.write_errors.values().any(|w| w.code == 11000),
        _ => false,
    }
}

/// How rows come back from a read.
#[derive(Default, Clone)]
pub struct Page {
    sort: Option<Document>,
    skip: Option<u64>,
    limit: Option<i64>,
}

impl Page {
    pub fn all() -> Self {
        Self::default()
    }
    pub fn ascending(mut self, field: &str) -> Self {
        self.sort.get_or_insert_with(Document::new).insert(field, 1);
        self
    }
    pub fn descending(mut self, field: &str) -> Self {
        self.sort
            .get_or_insert_with(Document::new)
            .insert(field, -1);
        self
    }
    pub fn skip(mut self, n: u64) -> Self {
        self.skip = Some(n);
        self
    }
    pub fn limit(mut self, n: i64) -> Self {
        self.limit = Some(n);
        self
    }

    /// The page as aggregation stages, in the order a find applies its parts.
    pub(in crate::persist) fn into_stages(self) -> Vec<Document> {
        let mut stages = Vec::new();
        if let Some(sort) = self.sort {
            stages.push(doc! { "$sort": sort });
        }
        if let Some(n) = self.skip {
            stages.push(doc! { "$skip": n as i64 });
        }
        if let Some(n) = self.limit {
            stages.push(doc! { "$limit": n });
        }
        stages
    }
}

/// A projection of the named fields. With none named it is the `_id` alone;
/// an empty projection would mean "every field" to the server.
fn only(fields: &[&str]) -> Document {
    if fields.is_empty() {
        return doc! { "_id": 1 };
    }
    fields
        .iter()
        .map(|f| (f.to_string(), Bson::Int32(1)))
        .collect()
}

/// What one write did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Written {
    pub matched: u64,
    pub modified: u64,
    pub inserted: Option<ObjectId>,
}

impl Written {
    fn from_update(r: &mongodb::results::UpdateResult) -> Self {
        Written {
            matched: r.matched_count,
            modified: r.modified_count,
            inserted: r.upserted_id.as_ref().and_then(Bson::as_object_id),
        }
    }
}

/// Generic operations over one collection. Entity persisters wrap this and add
/// their named operations; feature code rarely needs it directly.
pub struct Persister<T: Entity> {
    typed: Collection<T>,
    raw: Collection<Document>,
    _t: PhantomData<T>,
}

impl<T: Entity> Clone for Persister<T> {
    fn clone(&self) -> Self {
        Self {
            typed: self.typed.clone(),
            raw: self.raw.clone(),
            _t: PhantomData,
        }
    }
}

impl<T: Entity> Persister<T> {
    pub fn new(db: &Database) -> Self {
        Self {
            typed: db.collection::<T>(T::COLLECTION),
            raw: db.collection::<Document>(T::COLLECTION),
            _t: PhantomData,
        }
    }

    pub(crate) fn namespace(&self) -> Namespace {
        self.raw.namespace()
    }

    /// Escape hatch for the entity persisters in this module only.
    pub(in crate::persist) fn raw(&self) -> &Collection<Document> {
        &self.raw
    }

    /// Run an aggregation. Only entity persisters write pipelines.
    pub(in crate::persist) async fn aggregate(
        &self,
        stages: Vec<Document>,
    ) -> DbResult<Vec<Document>> {
        self.raw.aggregate(stages).await?.try_collect().await
    }

    pub async fn get(&self, id: ObjectId) -> DbResult<Option<T>> {
        self.typed.find_one(doc! { "_id": id }).await
    }

    pub async fn find_one(&self, filter: Filter) -> DbResult<Option<T>> {
        self.typed.find_one(filter.into_doc()).await
    }

    pub async fn find(&self, filter: Filter) -> DbResult<Vec<T>> {
        self.find_page(filter, Page::all()).await
    }

    pub async fn find_page(&self, filter: Filter, page: Page) -> DbResult<Vec<T>> {
        let mut q = self.typed.find(filter.into_doc());
        if let Some(s) = page.sort {
            q = q.sort(s);
        }
        if let Some(n) = page.skip {
            q = q.skip(n);
        }
        if let Some(n) = page.limit {
            q = q.limit(n);
        }
        q.await?.try_collect().await
    }

    /// Only the named fields (plus `_id`) of the matching rows. For hot paths
    /// and wide documents where loading the whole row would be waste.
    pub async fn select(&self, filter: Filter, fields: &[&str]) -> DbResult<Vec<Document>> {
        let projection = only(fields);
        self.raw
            .find(filter.into_doc())
            .projection(projection)
            .await?
            .try_collect()
            .await
    }

    pub async fn select_one(&self, filter: Filter, fields: &[&str]) -> DbResult<Option<Document>> {
        let projection = only(fields);
        self.raw
            .find_one(filter.into_doc())
            .projection(projection)
            .await
    }

    /// The `_id` of every matching row.
    pub async fn ids(&self, filter: Filter) -> DbResult<Vec<ObjectId>> {
        Ok(self
            .select(filter, &[])
            .await?
            .iter()
            .filter_map(|d| d.get_object_id("_id").ok())
            .collect())
    }

    pub async fn count(&self, filter: Filter) -> DbResult<u64> {
        self.raw.count_documents(filter.into_doc()).await
    }

    pub async fn exists(&self, filter: Filter) -> DbResult<bool> {
        Ok(self.select_one(filter, &[]).await?.is_some())
    }

    pub async fn insert(&self, row: &T) -> DbResult<ObjectId> {
        let res = self.typed.insert_one(row).await?;
        Ok(res.inserted_id.as_object_id().unwrap_or_default())
    }

    /// One round trip for any number of rows. Only tests seed in bulk so far.
    #[cfg(test)]
    pub async fn insert_many(&self, rows: &[T]) -> DbResult<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        Ok(self.typed.insert_many(rows).await?.inserted_ids.len())
    }

    /// Change the first matching row.
    pub async fn update(&self, filter: Filter, changes: Changes) -> DbResult<Written> {
        let (update, array_filters) = changes.into_parts();
        let mut op = self.raw.update_one(filter.into_doc(), update);
        if !array_filters.is_empty() {
            op = op.array_filters(array_filters);
        }
        Ok(Written::from_update(&op.await?))
    }

    /// Change every matching row in one statement.
    pub async fn update_all(&self, filter: Filter, changes: Changes) -> DbResult<Written> {
        let (update, array_filters) = changes.into_parts();
        let mut op = self.raw.update_many(filter.into_doc(), update);
        if !array_filters.is_empty() {
            op = op.array_filters(array_filters);
        }
        Ok(Written::from_update(&op.await?))
    }

    /// Change the matching row, or create it from the filter's equalities plus
    /// the changes.
    pub async fn upsert(&self, filter: Filter, changes: Changes) -> DbResult<Written> {
        let (update, _) = changes.into_parts();
        let res = self
            .raw
            .update_one(filter.into_doc(), update)
            .upsert(true)
            .await?;
        Ok(Written::from_update(&res))
    }

    /// Change the first matching row and return it as it is afterwards.
    pub async fn update_returning(&self, filter: Filter, changes: Changes) -> DbResult<Option<T>> {
        let (update, array_filters) = changes.into_parts();
        let mut op = self
            .typed
            .find_one_and_update(filter.into_doc(), update)
            .return_document(ReturnDocument::After);
        if !array_filters.is_empty() {
            op = op.array_filters(array_filters);
        }
        op.await
    }

    pub async fn delete(&self, filter: Filter) -> DbResult<u64> {
        Ok(self.raw.delete_one(filter.into_doc()).await?.deleted_count)
    }

    pub async fn delete_all(&self, filter: Filter) -> DbResult<u64> {
        Ok(self.raw.delete_many(filter.into_doc()).await?.deleted_count)
    }
}

// ── Batch ────────────────────────────────────────────────────────────────────

struct Op {
    namespace: Namespace,
    filter: Document,
    update: Document,
    array_filters: Vec<Document>,
    upsert: bool,
}

/// The connection and what the server supports, shared by everything that
/// writes.
pub(in crate::persist) struct Core {
    db: Database,
    client: Client,
    /// Whether the server takes the cross-collection `bulkWrite` command
    /// (MongoDB 8.0 and later). Found out once, in the background, at start.
    bulk_write: AtomicBool,
}

/// Several single-row writes, possibly to different collections, sent
/// together. On MongoDB 8+ that is one `bulkWrite` command; on older servers
/// the writes go out concurrently on the connection pool, so the wall-clock
/// cost is still about one round trip. Either way the writes are independent:
/// one failing does not undo the others, and their order is not guaranteed.
pub struct Batch {
    core: Arc<Core>,
    ops: Vec<Op>,
}

impl Batch {
    /// Queue an update of one row. Returns its position in the results.
    pub fn update<T: Entity>(
        &mut self,
        on: &Persister<T>,
        filter: Filter,
        changes: Changes,
    ) -> usize {
        self.push(on, filter, changes, false)
    }

    /// Queue an update-or-create of one row.
    pub fn upsert<T: Entity>(
        &mut self,
        on: &Persister<T>,
        filter: Filter,
        changes: Changes,
    ) -> usize {
        self.push(on, filter, changes, true)
    }

    fn push<T: Entity>(
        &mut self,
        on: &Persister<T>,
        filter: Filter,
        changes: Changes,
        upsert: bool,
    ) -> usize {
        let (update, array_filters) = changes.into_parts();
        self.ops.push(Op {
            namespace: on.namespace(),
            filter: filter.into_doc(),
            update,
            array_filters,
            upsert,
        });
        self.ops.len() - 1
    }

    /// Send everything queued. Results are in queue order.
    pub async fn send(self) -> DbResult<Vec<Written>> {
        match self.ops.len() {
            0 => Ok(Vec::new()),
            1 => self.send_concurrently().await,
            _ if self.core.bulk_write.load(Ordering::Relaxed) => self.send_bulk().await,
            _ => self.send_concurrently().await,
        }
    }

    async fn send_bulk(self) -> DbResult<Vec<Written>> {
        let n = self.ops.len();
        let models: Vec<WriteModel> = self
            .ops
            .into_iter()
            .map(|op| {
                WriteModel::UpdateOne(
                    UpdateOneModel::builder()
                        .namespace(op.namespace)
                        .filter(op.filter)
                        .update(op.update)
                        .array_filters(if op.array_filters.is_empty() {
                            None
                        } else {
                            Some(
                                op.array_filters
                                    .into_iter()
                                    .map(Bson::Document)
                                    .collect::<Vec<Bson>>(),
                            )
                        })
                        .upsert(op.upsert)
                        .build(),
                )
            })
            .collect();
        let res = self
            .core
            .client
            .bulk_write(models)
            .ordered(false)
            .verbose_results()
            .await?;
        Ok((0..n)
            .map(|i| {
                res.update_results
                    .get(&i)
                    .map(Written::from_update)
                    .unwrap_or_default()
            })
            .collect())
    }

    async fn send_concurrently(self) -> DbResult<Vec<Written>> {
        let db = &self.core.db;
        let writes = self.ops.into_iter().map(|op| async move {
            let coll = db.collection::<Document>(&op.namespace.coll);
            let mut write = coll.update_one(op.filter, op.update).upsert(op.upsert);
            if !op.array_filters.is_empty() {
                write = write.array_filters(op.array_filters);
            }
            let res = write.await?;
            Ok::<_, mongodb::error::Error>(Written::from_update(&res))
        });
        futures::future::try_join_all(writes).await
    }
}

// ── Store ────────────────────────────────────────────────────────────────────

/// A sensor's reading waiting to be stored.
#[derive(Clone)]
pub struct Reading {
    pub machine: Id,
    pub value: u8,
    pub at: DateTime<Utc>,
}

/// Hands out the persisters. One per application, shared by every request.
pub struct Store {
    core: Arc<Core>,
    pub machines: machines::Machines,
    pub records: records::Records,
    pub signals: signals::Signals,
    pub plcs: plcs::Plcs,
    pub pins: pins::Pins,
    pub sensors: sensors::Sensors,
    pub ingests: ingests::Ingests,
    pub configs: configs::Configs,
    pub leases: leases::Leases,
    pub users: users::Users,
    pub departments: departments::Departments,
    pub molds: molds::Molds,
    pub reports: reports::Reports,
    pub alerts: alerts::Alerts,
    /// Each sensor's latest reading, stored in bulk off the request path.
    pub latest_signals: BulkEntityWriter<Id, Reading>,
    /// Each machine's last-power mark, stored in bulk off the request path.
    pub power_marks: BulkEntityWriter<Id, DateTime<Utc>>,
}

/// How long a buffered reading or power mark may wait. Machine state is
/// decided by timeouts of minutes, so a second is invisible.
const BUFFERED_WRITE_EVERY: Duration = Duration::from_secs(1);

impl Store {
    /// Must be called inside the async runtime: it starts the bulk writers.
    pub fn new(db: Database) -> Self {
        let core = Arc::new(Core {
            client: db.client().clone(),
            bulk_write: AtomicBool::new(false),
            db: db.clone(),
        });

        let latest_signals = {
            let (core, signals) = (core.clone(), signals::Signals::new(&db));
            BulkEntityWriter::start(
                bulk_writer::Settings {
                    name: "latest-signals",
                    every: BUFFERED_WRITE_EVERY,
                    max_batch: 512,
                    capacity: 8192,
                },
                Box::new(move |rows: Vec<(Id, Reading)>| {
                    let mut batch = Batch {
                        core: core.clone(),
                        ops: Vec::new(),
                    };
                    for (sensor, r) in rows {
                        signals.queue_latest(&mut batch, sensor, r.machine, r.value, r.at);
                    }
                    Box::pin(async move { batch.send().await.map(|_| ()) })
                }),
            )
        };
        let power_marks = {
            let (core, machines) = (core.clone(), machines::Machines::new(&db));
            BulkEntityWriter::start(
                bulk_writer::Settings {
                    name: "power-marks",
                    every: BUFFERED_WRITE_EVERY,
                    max_batch: 512,
                    capacity: 8192,
                },
                Box::new(move |rows: Vec<(Id, DateTime<Utc>)>| {
                    let mut batch = Batch {
                        core: core.clone(),
                        ops: Vec::new(),
                    };
                    for (machine, at) in rows {
                        machines.queue_power(&mut batch, machine, at);
                    }
                    Box::pin(async move { batch.send().await.map(|_| ()) })
                }),
            )
        };

        Self {
            machines: machines::Machines::new(&db),
            records: records::Records::new(&db),
            signals: signals::Signals::new(&db),
            plcs: plcs::Plcs::new(&db),
            pins: pins::Pins::new(&db),
            sensors: sensors::Sensors::new(&db),
            ingests: ingests::Ingests::new(&db),
            configs: configs::Configs::new(&db),
            leases: leases::Leases::new(&db),
            users: users::Users::new(&db),
            departments: departments::Departments::new(&db),
            molds: molds::Molds::new(&db),
            reports: reports::Reports::new(&db),
            alerts: alerts::Alerts::new(&db),
            latest_signals,
            power_marks,
            core,
        }
    }

    pub fn batch(&self) -> Batch {
        Batch {
            core: self.core.clone(),
            ops: Vec::new(),
        }
    }

    /// Store everything the bulk writers are holding. Call before a read that
    /// must see the latest readings or power marks.
    pub async fn flush(&self) {
        futures::future::join(self.latest_signals.flush(), self.power_marks.flush()).await;
    }

    /// Flush and stop the bulk writers. For a clean shutdown.
    pub async fn shutdown(&self) {
        futures::future::join(self.latest_signals.shutdown(), self.power_marks.shutdown()).await;
    }

    /// True when the database answers.
    pub async fn ping(&self) -> bool {
        self.core.db.run_command(doc! { "ping": 1 }).await.is_ok()
    }

    /// Ask the server what it supports. Safe to call again; a failure leaves
    /// the conservative setting in place.
    pub async fn detect_capabilities(&self) -> DbResult<()> {
        let info = self.core.db.run_command(doc! { "buildInfo": 1 }).await?;
        let major = info
            .get_array("versionArray")
            .ok()
            .and_then(|v| v.first())
            .and_then(|b| b.as_i32().map(i64::from).or(b.as_i64()))
            .unwrap_or(0);
        self.core.bulk_write.store(major >= 8, Ordering::Relaxed);
        tracing::info!(
            "MongoDB {}: batched writes use {}",
            info.get_str("version").unwrap_or("?"),
            if major >= 8 {
                "bulkWrite"
            } else {
                "concurrent single writes"
            }
        );
        Ok(())
    }

    /// A second store on the same database with the same batch strategy and
    /// its own bulk writers, as another backend instance would have. Tests
    /// only.
    #[cfg(test)]
    pub fn another(&self) -> Self {
        let other = Self::new(self.core.db.clone());
        other.core.bulk_write.store(
            self.core.bulk_write.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        other
    }

    /// Create every index the persisters rely on, and run the one-off data
    /// migrations. Idempotent.
    pub async fn ensure_schema(&self) -> anyhow::Result<()> {
        schema::ensure_indexes(&self.core.db).await?;
        self.alerts.ensure_indexes().await?;
        Ok(())
    }

    /// Remove every row. Tests only.
    #[cfg(test)]
    pub async fn drop_everything(&self) -> DbResult<()> {
        self.core.db.drop().await
    }
}

/// An empty throwaway database on the test server, for the persister tests.
#[cfg(test)]
pub(in crate::persist) async fn test_db(name: &str) -> Database {
    let uri =
        std::env::var("MONGODB_TEST_URI").unwrap_or_else(|_| "mongodb://localhost:27017".into());
    let db = Client::with_uri_str(&uri)
        .await
        .expect("connect to MongoDB")
        .database(name);
    db.drop().await.expect("start clean");
    db
}
