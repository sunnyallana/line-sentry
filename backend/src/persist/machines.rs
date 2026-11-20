//! Machines, including the live state the pipeline keeps on each one.

use std::collections::{HashMap, HashSet};

use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use mongodb::Database;

use super::{Batch, Changes, DbResult, Entity, Filter, Persister};
use crate::models::{Id, Machine, MACHINES};

impl Entity for Machine {
    const COLLECTION: &'static str = MACHINES;
}

/// Field names.
pub mod f {
    pub const NAME: &str = "name";
    pub const DEPARTMENT: &str = "departmentId";
    pub const ACTIVE: &str = "isActive";
    pub const STATUS: &str = "status";
    pub const STATUS_SINCE: &str = "statusSince";
    pub const LAST_POWER: &str = "lastPowerAt";
    pub const LAST_CYCLE: &str = "lastCycleAt";
    pub const LAST_RUNNING_MINUTE: &str = "lastRunningMinute";
    pub const POSITION: &str = "position";
    pub const DIMENSIONS: &str = "dimensions";
    pub const UPDATED: &str = "updatedAt";
}

pub const RUNNING: &str = "running";
pub const STOPPED: &str = "stoppage";
pub const PRODUCING_UNPOWERED: &str = "stopped_yet_producing";
pub const IDLE: &str = "inactive";

/// What the database holds about a machine's signals.
pub struct LiveState {
    pub status: String,
    pub last_power: Option<DateTime<Utc>>,
    pub last_cycle: Option<DateTime<Utc>>,
    pub last_running_minute: i64,
}

pub struct Machines {
    pub rows: Persister<Machine>,
}

impl Machines {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// Live state of several machines in one read.
    pub async fn live_states(&self, ids: &HashSet<Id>) -> DbResult<HashMap<Id, LiveState>> {
        let rows = self
            .rows
            .select(
                Filter::all().any_of("_id", ids.iter().map(|i| i.oid())),
                &[
                    f::STATUS,
                    f::LAST_POWER,
                    f::LAST_CYCLE,
                    f::LAST_RUNNING_MINUTE,
                ],
            )
            .await?;
        let date = |d: &bson::Document, key: &str| d.get_datetime(key).ok().map(|t| t.to_chrono());
        Ok(rows
            .iter()
            .filter_map(|d| {
                Some((
                    Id(d.get_object_id("_id").ok()?),
                    LiveState {
                        status: d.get_str(f::STATUS).unwrap_or(IDLE).to_string(),
                        last_power: date(d, f::LAST_POWER),
                        last_cycle: date(d, f::LAST_CYCLE),
                        last_running_minute: d.get_i64(f::LAST_RUNNING_MINUTE).unwrap_or(0),
                    },
                ))
            })
            .collect())
    }

    /// The machine had power at `at`. Never moves the mark backwards.
    pub fn queue_power(&self, batch: &mut Batch, id: Id, at: DateTime<Utc>) -> usize {
        batch.update(
            &self.rows,
            Filter::id(id.oid()),
            Changes::new().at_least(f::LAST_POWER, bson::DateTime::from_chrono(at)),
        )
    }

    /// The machine made a unit at `at`. Never moves the mark backwards.
    pub fn queue_cycle(&self, batch: &mut Batch, id: Id, at: DateTime<Utc>) -> usize {
        batch.update(
            &self.rows,
            Filter::id(id.oid()),
            Changes::new().at_least(f::LAST_CYCLE, bson::DateTime::from_chrono(at)),
        )
    }

    /// Try to be the payload that counts running minute `minute`. The write
    /// reports `modified == 1` for exactly one caller per minute.
    pub fn queue_running_minute_claim(&self, batch: &mut Batch, id: Id, minute: i64) -> usize {
        batch.update(
            &self.rows,
            Filter::id(id.oid()).either([
                Filter::all().lt(f::LAST_RUNNING_MINUTE, minute),
                Filter::all().exists(f::LAST_RUNNING_MINUTE, false),
            ]),
            Changes::new().set(f::LAST_RUNNING_MINUTE, minute),
        )
    }

    /// Move to `status` unless already there. Only a real change is written,
    /// so `statusSince` marks when the machine entered its current state.
    pub fn queue_status(&self, batch: &mut Batch, id: Id, status: &str) -> usize {
        batch.update(
            &self.rows,
            Filter::id(id.oid()).ne(f::STATUS, status),
            Changes::new()
                .set(f::STATUS, status)
                .set(f::STATUS_SINCE, bson::DateTime::now()),
        )
    }

    /// Of `ids`, those currently in `status`.
    pub async fn with_status(&self, ids: &[ObjectId], status: &str) -> DbResult<HashSet<ObjectId>> {
        Ok(self
            .rows
            .ids(
                Filter::all()
                    .any_of("_id", ids.iter().copied())
                    .eq(f::STATUS, status),
            )
            .await?
            .into_iter()
            .collect())
    }

    /// Set every machine in `ids` that is not idle to idle, in one statement.
    /// Returns the ones that changed.
    pub async fn idle_all(&self, ids: &[ObjectId], at: DateTime<Utc>) -> DbResult<Vec<ObjectId>> {
        let not_idle = Filter::all()
            .any_of("_id", ids.iter().copied())
            .ne(f::STATUS, IDLE);
        let changing = self.rows.ids(not_idle.clone()).await?;
        if changing.is_empty() {
            return Ok(changing);
        }
        self.rows
            .update_all(
                Filter::all()
                    .any_of("_id", changing.iter().copied())
                    .ne(f::STATUS, IDLE),
                Changes::new()
                    .set(f::STATUS, IDLE)
                    .set(f::STATUS_SINCE, bson::DateTime::from_chrono(at)),
            )
            .await?;
        Ok(changing)
    }

    /// Active machines, optionally narrowed to a department or one machine.
    pub async fn active(
        &self,
        department: Option<ObjectId>,
        machine: Option<ObjectId>,
    ) -> DbResult<Vec<Machine>> {
        let mut filter = Filter::all().eq(f::ACTIVE, true);
        if let Some(d) = department {
            filter = filter.eq(f::DEPARTMENT, d);
        }
        if let Some(m) = machine {
            filter = filter.eq("_id", m);
        }
        self.rows.find(filter).await
    }

    /// Change what a person may edit; the live-state fields are left alone.
    pub async fn edit(&self, id: ObjectId, edited: &Machine) -> DbResult<()> {
        let mut changes = Changes::new()
            .set(f::NAME, edited.name.as_str())
            .set(f::DEPARTMENT, edited.department_id.oid())
            .set(f::ACTIVE, edited.is_active)
            .set("updatedAt", bson::DateTime::now());
        if let Some(description) = &edited.description {
            changes = changes.set("description", description.as_str());
        }
        if let Some(p) = &edited.position {
            changes = changes.set("position", bson::doc! { "x": p.x, "y": p.y });
        }
        if let Some(d) = &edited.dimensions {
            changes = changes.set(
                "dimensions",
                bson::doc! { "width": d.width, "height": d.height },
            );
        }
        self.rows.update(Filter::id(id), changes).await?;
        Ok(())
    }

    /// The matching machines, each with its department in place of the
    /// department's id.
    async fn with_department(&self, filter: Filter) -> DbResult<Vec<bson::Document>> {
        let stages = vec![
            bson::doc! { "$match": filter.into_doc() },
            bson::doc! { "$lookup": {
                "from": crate::models::DEPARTMENTS, "localField": f::DEPARTMENT,
                "foreignField": "_id", "as": f::DEPARTMENT,
            }},
            bson::doc! { "$unwind": {
                "path": format!("${}", f::DEPARTMENT), "preserveNullAndEmptyArrays": true,
            }},
        ];
        self.rows.aggregate(stages).await
    }

    /// Active machines, of one department or of all, with their department.
    pub async fn active_with_department(
        &self,
        department: Option<ObjectId>,
    ) -> DbResult<Vec<bson::Document>> {
        let mut filter = Filter::all();
        if let Some(d) = department {
            filter = filter.eq(f::DEPARTMENT, d);
        }
        self.with_department(filter.eq(f::ACTIVE, true)).await
    }

    /// One machine with its department.
    pub async fn one_with_department(&self, id: ObjectId) -> DbResult<Option<bson::Document>> {
        Ok(self
            .with_department(Filter::id(id))
            .await?
            .into_iter()
            .next())
    }

    /// Move and resize the machine on the floor plan. Returns the whole row as
    /// it is afterwards, or `None` when there is no such machine.
    pub async fn place(
        &self,
        id: ObjectId,
        (x, y): (f64, f64),
        (width, height): (f64, f64),
    ) -> DbResult<Option<bson::Document>> {
        let (update, _) = Changes::new()
            .set(f::POSITION, bson::doc! { "x": x, "y": y })
            .set(
                f::DIMENSIONS,
                bson::doc! { "width": width, "height": height },
            )
            .set(f::UPDATED, bson::DateTime::now())
            .into_parts();
        self.rows
            .raw()
            .find_one_and_update(Filter::id(id).into_doc(), update)
            .return_document(mongodb::options::ReturnDocument::After)
            .await
    }
}

/// The name of every active department, by id. This is the departments
/// persister's to answer; it is here until that one does.
pub async fn active_department_names(
    departments: &Persister<crate::models::Department>,
) -> DbResult<HashMap<ObjectId, String>> {
    Ok(departments
        .select(Filter::all().eq("isActive", true), &["name"])
        .await?
        .iter()
        .filter_map(|d| {
            Some((
                d.get_object_id("_id").ok()?,
                d.get_str("name").ok()?.to_string(),
            ))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use bson::{doc, Document};

    use super::super::test_db;
    use super::*;
    use crate::models::{Department, DEPARTMENTS};

    #[tokio::test]
    async fn department_reads_and_placing() {
        let db = test_db("linesentry_pt_machines").await;
        let machines = Machines::new(&db);
        let (molding, closed) = (ObjectId::new(), ObjectId::new());
        db.collection::<Document>(DEPARTMENTS)
            .insert_many([
                doc! { "_id": molding, "name": "Molding", "isActive": true },
                doc! { "_id": closed, "name": "Closed", "isActive": false },
            ])
            .await
            .unwrap();
        let (press, idle, lost) = (ObjectId::new(), ObjectId::new(), ObjectId::new());
        let seen = bson::DateTime::now();
        machines
            .rows
            .raw()
            .insert_many([
                doc! { "_id": press, "name": "Press", "departmentId": molding, "isActive": true, "lastPowerAt": seen },
                doc! { "_id": idle, "name": "Idle", "departmentId": molding, "isActive": false },
                doc! { "_id": lost, "name": "Lost", "departmentId": ObjectId::new(), "isActive": true },
            ])
            .await
            .unwrap();

        // A machine whose department is gone is still listed, without one.
        assert_eq!(
            machines.active_with_department(None).await.unwrap().len(),
            2
        );
        let in_molding = machines
            .active_with_department(Some(molding))
            .await
            .unwrap();
        assert_eq!(in_molding.len(), 1);
        assert_eq!(
            in_molding[0]
                .get_document(f::DEPARTMENT)
                .and_then(|d| d.get_str("name")),
            Ok("Molding")
        );
        let one = machines.one_with_department(lost).await.unwrap().unwrap();
        assert!(!one.contains_key(f::DEPARTMENT));
        assert!(machines
            .one_with_department(ObjectId::new())
            .await
            .unwrap()
            .is_none());

        let placed = machines
            .place(press, (10.0, 20.0), (300.0, 150.0))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            placed.get_document(f::POSITION),
            Ok(&doc! { "x": 10.0, "y": 20.0 })
        );
        assert_eq!(
            placed.get_document(f::DIMENSIONS),
            Ok(&doc! { "width": 300.0, "height": 150.0 })
        );
        assert_eq!(placed.get_datetime(f::LAST_POWER), Ok(&seen));
        assert!(machines
            .place(ObjectId::new(), (0.0, 0.0), (1.0, 1.0))
            .await
            .unwrap()
            .is_none());

        let names = active_department_names(&Persister::<Department>::new(&db))
            .await
            .unwrap();
        assert_eq!(names, HashMap::from([(molding, "Molding".to_string())]));
        db.drop().await.unwrap();
    }
}
