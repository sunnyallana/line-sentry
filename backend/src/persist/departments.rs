//! Departments, and the machines and molds that belong to each.

use bson::{doc, oid::ObjectId, Document};
use chrono::{DateTime, Utc};
use mongodb::Database;

use super::{machines, Changes, DbResult, Entity, Filter, Page, Persister};
use crate::models::{Department, Machine, Mold, DEPARTMENTS, MACHINES};

impl Entity for Department {
    const COLLECTION: &'static str = DEPARTMENTS;
}

/// Field names. `MACHINES` and `MACHINE_COUNT` are not stored: the reads that
/// join a department's machines add them.
pub mod f {
    pub const NAME: &str = "name";
    pub const DESCRIPTION: &str = "description";
    pub const LAYOUT: &str = "layout";
    pub const ACTIVE: &str = "isActive";
    pub const CREATED: &str = "createdAt";
    pub const UPDATED: &str = "updatedAt";
    pub const MACHINES: &str = "machines";
    pub const MACHINE_COUNT: &str = "machineCount";
}

/// The department a mold belongs to.
const MOLD_DEPARTMENT: &str = "departmentId";

/// Which departments an admin list shows. Unset parts do not narrow it.
#[derive(Default)]
pub struct Search {
    /// Already-escaped pattern looked for in the name and the description.
    pub text: Option<String>,
    pub active: Option<bool>,
}

impl Search {
    fn into_filter(self) -> Filter {
        let mut filter = Filter::all();
        if let Some(pattern) = &self.text {
            filter = filter.either([
                Filter::all().matches(f::NAME, pattern),
                Filter::all().matches(f::DESCRIPTION, pattern),
            ]);
        }
        if let Some(active) = self.active {
            filter = filter.eq(f::ACTIVE, active);
        }
        filter
    }
}

/// Stage that joins each department's active machines as `machines`, keeping
/// only `fields` of each machine, or all of them when `fields` is empty.
fn active_machines(fields: &[&str]) -> Document {
    let mut of_machine = vec![doc! { "$match": { machines::f::ACTIVE: true } }];
    if !fields.is_empty() {
        let kept: Document = fields.iter().map(|f| (f.to_string(), 1.into())).collect();
        of_machine.push(doc! { "$project": kept });
    }
    doc! { "$lookup": {
        "from": MACHINES,
        "localField": "_id",
        "foreignField": machines::f::DEPARTMENT,
        "as": f::MACHINES,
        "pipeline": of_machine,
    }}
}

fn machine_count() -> Document {
    doc! { "$addFields": { f::MACHINE_COUNT: { "$size": format!("${}", f::MACHINES) } } }
}

pub struct Departments {
    pub rows: Persister<Department>,
    machines: Persister<Machine>,
    molds: Persister<Mold>,
}

impl Departments {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
            machines: Persister::new(db),
            molds: Persister::new(db),
        }
    }

    pub async fn by_id(&self, id: ObjectId) -> DbResult<Option<Department>> {
        self.rows.get(id).await
    }

    /// Active departments, or just `only`, each with its active machines
    /// (what a floor plan needs of them) and their count.
    pub async fn active_with_machines(
        &self,
        only: Option<ObjectId>,
        limit: Option<i64>,
    ) -> DbResult<Vec<Document>> {
        let mut filter = Filter::all().eq(f::ACTIVE, true);
        if let Some(id) = only {
            filter = filter.eq("_id", id);
        }
        let mut stages = vec![doc! { "$match": filter.into_doc() }];
        // The join adds no rows, so cutting first only saves joining the rest.
        if let Some(n) = limit {
            stages.push(doc! { "$limit": n });
        }
        stages.push(active_machines(&[
            "_id",
            machines::f::NAME,
            machines::f::STATUS,
            "position",
            "dimensions",
        ]));
        stages.push(machine_count());
        self.rows.aggregate(stages).await
    }

    /// One page of the departments matching `search`, each with its active
    /// machines and their count, and how many match in all. The page is cut
    /// after the join so that it can be sorted by the machine count too.
    pub async fn search(&self, search: Search, page: Page) -> DbResult<(Vec<Document>, u64)> {
        let filter = search.into_filter();
        let mut stages = vec![
            doc! { "$match": filter.clone().into_doc() },
            active_machines(&["_id", machines::f::NAME, machines::f::STATUS]),
            machine_count(),
        ];
        stages.extend(page.into_stages());
        futures::future::try_join(self.rows.aggregate(stages), self.rows.count(filter)).await
    }

    /// The department as stored, plus its active machines in full.
    pub async fn with_machines(&self, id: ObjectId) -> DbResult<Option<Document>> {
        let stages = vec![
            doc! { "$match": Filter::id(id).into_doc() },
            active_machines(&[]),
        ];
        Ok(self.rows.aggregate(stages).await?.pop())
    }

    pub async fn create(&self, department: &Department) -> DbResult<ObjectId> {
        self.rows.insert(department).await
    }

    /// Store what a person may edit and return the department as it is
    /// afterwards, or `None` if there is no such department. An edit without
    /// a description removes the stored one.
    pub async fn edit(
        &self,
        id: ObjectId,
        edited: &Department,
        at: DateTime<Utc>,
    ) -> DbResult<Option<Department>> {
        let changes = Changes::new()
            .set(f::NAME, edited.name.as_str())
            .set(f::LAYOUT, edited.layout.clone())
            .set(f::ACTIVE, edited.is_active)
            .set(f::UPDATED, bson::DateTime::from_chrono(at));
        let changes = match &edited.description {
            Some(description) => changes.set(f::DESCRIPTION, description.as_str()),
            None => changes.clear(f::DESCRIPTION),
        };
        self.rows.update_returning(Filter::id(id), changes).await
    }

    /// Create the department called `name`, or make the one already called
    /// that active with this description. Returns its id, or `None` if it
    /// was deleted in between.
    pub async fn ensure(&self, name: &str, description: &str) -> DbResult<Option<ObjectId>> {
        let named = Filter::all().eq(f::NAME, name);
        let written = self
            .rows
            .upsert(
                named.clone(),
                Changes::new()
                    .set(f::DESCRIPTION, description)
                    .set(f::ACTIVE, true),
            )
            .await?;
        if written.inserted.is_some() {
            return Ok(written.inserted);
        }
        Ok(self
            .rows
            .find_one(named)
            .await?
            .and_then(|d| d.id)
            .map(|id| id.oid()))
    }

    /// Delete the department with its machines and molds. Returns whether
    /// there was such a department. The department goes last, so a failure
    /// part-way leaves it in place to be deleted again.
    pub async fn remove_with_contents(&self, id: ObjectId) -> DbResult<bool> {
        if !self.rows.exists(Filter::id(id)).await? {
            return Ok(false);
        }
        futures::future::try_join(
            self.machines
                .delete_all(Filter::all().eq(machines::f::DEPARTMENT, id)),
            self.molds.delete_all(Filter::all().eq(MOLD_DEPARTMENT, id)),
        )
        .await?;
        self.rows.delete(Filter::id(id)).await?;
        Ok(true)
    }
}
