//! Sensors: a machine's power and unit-cycle signals.

use bson::{doc, oid::ObjectId, Document};
use mongodb::Database;

use super::paging::page_with_total;
pub use super::paging::Slice;
use super::{Changes, DbResult, Entity, Filter, Persister};
use crate::models::{Sensor, DEPARTMENTS, MACHINES, SENSORS};

impl Entity for Sensor {
    const COLLECTION: &'static str = SENSORS;
}

pub mod f {
    pub const NAME: &str = "name";
    pub const DESCRIPTION: &str = "description";
    pub const MACHINE: &str = "machineId";
    pub const KIND: &str = "sensorType";
    pub const ACTIVE: &str = "isActive";
    pub const UPDATED: &str = "updatedAt";
}

pub const POWER: &str = "power";
pub const UNIT_CYCLE: &str = "unit-cycle";

/// What the admin list is narrowed to.
pub struct Listing<'a> {
    /// An already-escaped pattern looked for in the name, description and kind.
    pub search: Option<&'a str>,
    pub active: Option<bool>,
    pub kind: Option<&'a str>,
    /// Only sensors on machines of this department.
    pub department: Option<ObjectId>,
    pub slice: Slice<'a>,
}

pub struct Sensors {
    pub rows: Persister<Sensor>,
}

impl Sensors {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    pub async fn all(&self) -> DbResult<Vec<Sensor>> {
        self.rows.find(Filter::all()).await
    }

    pub async fn active(&self) -> DbResult<Vec<Sensor>> {
        self.rows.find(Filter::all().eq(f::ACTIVE, true)).await
    }

    /// The active sensors of one machine.
    pub async fn active_on(&self, machine: ObjectId) -> DbResult<Vec<Sensor>> {
        self.rows
            .find(Filter::all().eq(f::MACHINE, machine).eq(f::ACTIVE, true))
            .await
    }

    /// Active sensors, of one machine or of all, each with its machine in
    /// place of the machine's id.
    pub async fn active_with_machine(&self, machine: Option<ObjectId>) -> DbResult<Vec<Document>> {
        let mut filter = Filter::all();
        if let Some(m) = machine {
            filter = filter.eq(f::MACHINE, m);
        }
        let stages = vec![
            doc! { "$match": filter.eq(f::ACTIVE, true).into_doc() },
            doc! { "$lookup": {
                "from": MACHINES, "localField": f::MACHINE, "foreignField": "_id", "as": f::MACHINE,
            }},
            doc! { "$unwind": { "path": format!("${}", f::MACHINE), "preserveNullAndEmptyArrays": true } },
        ];
        self.rows.aggregate(stages).await
    }

    /// One page of the admin list and the number of sensors that match. Each
    /// sensor carries its machine, and the machine its department; a sensor
    /// whose machine or department is gone is left out.
    pub async fn admin_page(&self, listing: &Listing<'_>) -> DbResult<(Vec<Document>, i64)> {
        let mut filter = Filter::all();
        if let Some(pattern) = listing.search {
            filter = filter.either(
                [f::NAME, f::DESCRIPTION, f::KIND]
                    .map(|field| Filter::all().matches(field, pattern)),
            );
        }
        if let Some(active) = listing.active {
            filter = filter.eq(f::ACTIVE, active);
        }
        if let Some(kind) = listing.kind {
            filter = filter.eq(f::KIND, kind);
        }
        let mut stages = vec![
            doc! { "$match": filter.into_doc() },
            doc! { "$lookup": {
                "from": MACHINES, "localField": f::MACHINE, "foreignField": "_id", "as": f::MACHINE,
                "pipeline": [
                    { "$lookup": {
                        "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id",
                        "as": "departmentId",
                    }},
                    { "$unwind": "$departmentId" },
                ],
            }},
            doc! { "$unwind": format!("${}", f::MACHINE) },
        ];
        if let Some(department) = listing.department {
            let path = format!("{}.departmentId._id", f::MACHINE);
            stages.push(doc! { "$match": { path: department } });
        }
        page_with_total(&self.rows, stages, &listing.slice).await
    }

    /// Change what a person may edit. A description that was not sent is left
    /// as it is.
    pub async fn edit(&self, id: ObjectId, edited: &Sensor) -> DbResult<()> {
        let mut changes = Changes::new()
            .set(f::NAME, edited.name.as_str())
            .set(f::MACHINE, edited.machine_id.oid())
            .set(f::KIND, edited.sensor_type.as_str())
            .set(f::ACTIVE, edited.is_active)
            .set(f::UPDATED, bson::DateTime::now());
        if let Some(description) = &edited.description {
            changes = changes.set(f::DESCRIPTION, description.as_str());
        }
        self.rows.update(Filter::id(id), changes).await?;
        Ok(())
    }

    /// Remove every sensor of a machine.
    pub async fn delete_on(&self, machine: ObjectId) -> DbResult<u64> {
        self.rows
            .delete_all(Filter::all().eq(f::MACHINE, machine))
            .await
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};

    use super::super::test_db;
    use super::*;
    use crate::models::Id;

    fn listing<'a>(sort_by: &'a str, skip: i64, limit: i64) -> Listing<'a> {
        Listing {
            search: None,
            active: None,
            kind: None,
            department: None,
            slice: Slice {
                sort_by,
                ascending: true,
                skip,
                limit,
            },
        }
    }

    fn names(rows: &[Document]) -> Vec<&str> {
        rows.iter()
            .filter_map(|d| d.get_str(f::NAME).ok())
            .collect()
    }

    #[tokio::test]
    async fn admin_page_filters_pages_and_counts_in_one_read() {
        let db = test_db("linesentry_pt_sensors").await;
        let sensors = Sensors::new(&db);
        let (molding, assembly) = (ObjectId::new(), ObjectId::new());
        db.collection::<Document>(DEPARTMENTS)
            .insert_many([
                doc! { "_id": molding, "name": "Molding" },
                doc! { "_id": assembly, "name": "Assembly" },
            ])
            .await
            .unwrap();
        let (press, robot, orphan) = (ObjectId::new(), ObjectId::new(), ObjectId::new());
        db.collection::<Document>(MACHINES)
            .insert_many([
                doc! { "_id": press, "name": "Press", "departmentId": molding },
                doc! { "_id": robot, "name": "Robot", "departmentId": assembly },
                doc! { "_id": orphan, "name": "Orphan", "departmentId": ObjectId::new() },
            ])
            .await
            .unwrap();
        let start = Utc::now();
        let sensor =
            |n: i64, name: &str, about: Option<&str>, machine, kind: &str, active| Sensor {
                id: None,
                name: name.into(),
                description: about.map(Into::into),
                machine_id: Id(machine),
                sensor_type: kind.into(),
                is_active: active,
                created_at: Some(start + Duration::seconds(n)),
                updated_at: None,
            };
        sensors
            .rows
            .insert_many(&[
                sensor(1, "Alpha", None, press, POWER, true),
                sensor(2, "Beta", None, press, UNIT_CYCLE, false),
                sensor(3, "Gamma", Some("alpha backup"), robot, POWER, true),
                sensor(4, "No department", None, orphan, POWER, true),
                sensor(5, "No machine", None, ObjectId::new(), POWER, true),
            ])
            .await
            .unwrap();

        let (rows, total) = sensors.admin_page(&listing(f::NAME, 0, 2)).await.unwrap();
        assert_eq!((names(&rows), total), (vec!["Alpha", "Beta"], 3));
        let department = rows[0]
            .get_document(f::MACHINE)
            .and_then(|m| m.get_document("departmentId"))
            .and_then(|d| d.get_str("name"));
        assert_eq!(department, Ok("Molding"));

        let (rows, total) = sensors.admin_page(&listing(f::NAME, 2, 2)).await.unwrap();
        assert_eq!((names(&rows), total), (vec!["Gamma"], 3));

        // No sort field means by creation time.
        let newest_first = Listing {
            slice: Slice {
                sort_by: "",
                ascending: false,
                skip: 0,
                limit: 10,
            },
            ..listing("", 0, 10)
        };
        let (rows, _) = sensors.admin_page(&newest_first).await.unwrap();
        assert_eq!(names(&rows), ["Gamma", "Beta", "Alpha"]);

        let search = Listing {
            search: Some("ALPHA"),
            ..listing(f::NAME, 0, 10)
        };
        let (rows, total) = sensors.admin_page(&search).await.unwrap();
        assert_eq!((names(&rows), total), (vec!["Alpha", "Gamma"], 2));

        let narrowed = Listing {
            active: Some(true),
            kind: Some(POWER),
            department: Some(assembly),
            ..listing(f::NAME, 0, 10)
        };
        let (rows, total) = sensors.admin_page(&narrowed).await.unwrap();
        assert_eq!((names(&rows), total), (vec!["Gamma"], 1));

        let nothing = Listing {
            search: Some("zzz"),
            ..listing(f::NAME, 0, 10)
        };
        let (rows, total) = sensors.admin_page(&nothing).await.unwrap();
        assert_eq!((rows.len(), total), (0, 0));

        // The plain lists keep a sensor whose machine is gone.
        assert_eq!(sensors.active_with_machine(None).await.unwrap().len(), 4);
        let on_press = sensors.active_with_machine(Some(press)).await.unwrap();
        assert_eq!(names(&on_press), ["Alpha"]);
        assert_eq!(
            on_press[0]
                .get_document(f::MACHINE)
                .and_then(|m| m.get_str("name")),
            Ok("Press")
        );
        db.drop().await.unwrap();
    }

    #[tokio::test]
    async fn edit_leaves_alone_what_was_not_sent() {
        let db = test_db("linesentry_pt_sensor_edit").await;
        let sensors = Sensors::new(&db);
        let mut sensor = Sensor {
            id: None,
            name: "Before".into(),
            description: Some("kept".into()),
            machine_id: Id::new(),
            sensor_type: POWER.into(),
            is_active: true,
            created_at: Some(Utc::now()),
            updated_at: None,
        };
        let id = sensors.rows.insert(&sensor).await.unwrap();

        sensor.name = "After".into();
        sensor.description = None;
        sensor.created_at = None;
        sensors.edit(id, &sensor).await.unwrap();

        let stored = sensors.rows.get(id).await.unwrap().unwrap();
        assert_eq!(stored.name, "After");
        assert_eq!(stored.description.as_deref(), Some("kept"));
        assert!(stored.created_at.is_some() && stored.updated_at.is_some());
        db.drop().await.unwrap();
    }
}
