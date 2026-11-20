//! Generated reports.

use bson::{doc, oid::ObjectId, Document};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use mongodb::Database;
use serde::{Deserialize, Serialize};

use super::{Changes, DbResult, Entity, Filter, Persister};
use crate::models::{DEPARTMENTS, MACHINES, REPORTS, USERS};

/// A report is stored as computed: a document of metrics by machine,
/// department and shift.
#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)]
pub struct ReportRow(pub Document);

impl Entity for ReportRow {
    const COLLECTION: &'static str = REPORTS;
}

/// Field names.
pub mod f {
    pub const TYPE: &str = "type";
    pub const DEPARTMENT: &str = "departmentId";
    pub const MACHINE: &str = "machineId";
    pub const AUTHOR: &str = "generatedBy";
    pub const PERIOD_START: &str = "period.start";
    pub const SCHEDULED: &str = "scheduled";
    pub const EMAILED: &str = "emailSent";
    pub const EMAILED_AT: &str = "emailSentAt";
    pub const CREATED: &str = "createdAt";
}

pub struct Reports {
    pub rows: Persister<ReportRow>,
}

impl Reports {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// Store a computed report and return it with its `_id`.
    pub async fn store(&self, report: Document) -> DbResult<Document> {
        let mut row = ReportRow(report);
        let id = self.rows.insert(&row).await?;
        row.0.insert("_id", id);
        Ok(row.0)
    }

    pub async fn get(&self, id: ObjectId) -> DbResult<Option<Document>> {
        Ok(self.rows.get(id).await?.map(|r| r.0))
    }

    /// Reports, newest first, optionally of one type, department or machine.
    /// The author (username only), department and machine are embedded in
    /// place of their ids; one that no longer exists leaves the field out.
    pub async fn listed(
        &self,
        kind: Option<&str>,
        department: Option<ObjectId>,
        machine: Option<ObjectId>,
    ) -> DbResult<Vec<Document>> {
        let mut wanted = Filter::all();
        if let Some(k) = kind {
            wanted = wanted.eq(f::TYPE, k);
        }
        if let Some(d) = department {
            wanted = wanted.eq(f::DEPARTMENT, d);
        }
        if let Some(m) = machine {
            wanted = wanted.eq(f::MACHINE, m);
        }
        let embed = |from: &str, field: &str| {
            doc! { "$lookup": { "from": from, "localField": field, "foreignField": "_id", "as": field } }
        };
        let first = |field: &str| doc! { "$arrayElemAt": [format!("${field}"), 0] };
        self.rows
            .aggregate(vec![
                doc! { "$match": wanted.into_doc() },
                doc! { "$lookup": {
                    "from": USERS, "localField": f::AUTHOR, "foreignField": "_id", "as": f::AUTHOR,
                    "pipeline": [ { "$project": { "username": 1 } } ],
                } },
                embed(DEPARTMENTS, f::DEPARTMENT),
                embed(MACHINES, f::MACHINE),
                doc! { "$addFields": {
                    f::AUTHOR: first(f::AUTHOR),
                    f::DEPARTMENT: first(f::DEPARTMENT),
                    f::MACHINE: first(f::MACHINE),
                } },
                doc! { "$sort": { f::CREATED: -1 } },
            ])
            .await
    }

    /// Returns whether there was such a report.
    pub async fn delete(&self, id: ObjectId) -> DbResult<bool> {
        Ok(self.rows.delete(Filter::id(id)).await? == 1)
    }

    /// The report the daily schedule stored for the day starting at `start`.
    pub async fn scheduled_daily(&self, start: DateTime<Utc>) -> DbResult<Option<Document>> {
        let stored = self
            .rows
            .find_one(
                Filter::all()
                    .eq(f::SCHEDULED, true)
                    .eq(f::TYPE, "daily")
                    .eq(f::PERIOD_START, bson::DateTime::from_chrono(start)),
            )
            .await?;
        Ok(stored.map(|r| r.0))
    }

    pub async fn mark_emailed(&self, id: ObjectId) -> DbResult<()> {
        self.rows
            .update(
                Filter::id(id),
                Changes::new()
                    .set(f::EMAILED, true)
                    .set(f::EMAILED_AT, bson::DateTime::now()),
            )
            .await?;
        Ok(())
    }

    /// Delete all but the `keep` newest reports: one read of the ids to drop,
    /// one delete. Returns how many were dropped.
    pub async fn keep_newest(&self, keep: u64) -> DbResult<u64> {
        let old: Vec<Document> = self
            .rows
            .raw()
            .find(doc! {})
            .sort(doc! { f::CREATED: -1, "_id": -1 })
            .skip(keep)
            .projection(doc! { "_id": 1 })
            .await?
            .try_collect()
            .await?;
        let ids: Vec<ObjectId> = old
            .iter()
            .filter_map(|d| d.get_object_id("_id").ok())
            .collect();
        if ids.is_empty() {
            return Ok(0);
        }
        self.rows.delete_all(Filter::all().any_of("_id", ids)).await
    }
}
