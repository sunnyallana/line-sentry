//! Molds.

use std::collections::HashSet;

use bson::{doc, oid::ObjectId, Document};
use mongodb::Database;

use super::paging::{page_with_total, Slice};
use super::{Changes, DbResult, Entity, Filter, Persister};
use crate::models::{Mold, DEPARTMENTS, MOLDS};

impl Entity for Mold {
    const COLLECTION: &'static str = MOLDS;
}

pub mod f {
    pub const NAME: &str = "name";
    pub const DESCRIPTION: &str = "description";
    pub const CAPACITY: &str = "productionCapacityPerHour";
    pub const DEPARTMENT: &str = "departmentId";
    pub const ACTIVE: &str = "isActive";
    pub const UPDATED: &str = "updatedAt";
}

/// What the admin list is narrowed to.
pub struct Listing<'a> {
    /// An already-escaped pattern looked for in the name and description.
    pub search: Option<&'a str>,
    pub department: Option<ObjectId>,
    pub active: Option<bool>,
    pub slice: Slice<'a>,
}

fn department_lookup() -> Document {
    doc! { "$lookup": {
        "from": DEPARTMENTS, "localField": f::DEPARTMENT, "foreignField": "_id", "as": f::DEPARTMENT,
    }}
}

pub struct Molds {
    pub rows: Persister<Mold>,
}

impl Molds {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// Active molds, of one department or of all, each with its department in
    /// place of the department's id.
    pub async fn active_with_department(
        &self,
        department: Option<ObjectId>,
    ) -> DbResult<Vec<Document>> {
        let mut filter = Filter::all().eq(f::ACTIVE, true);
        if let Some(d) = department {
            filter = filter.eq(f::DEPARTMENT, d);
        }
        let stages = vec![
            doc! { "$match": filter.into_doc() },
            department_lookup(),
            doc! { "$unwind": { "path": format!("${}", f::DEPARTMENT), "preserveNullAndEmptyArrays": true } },
        ];
        self.rows.aggregate(stages).await
    }

    /// One page of the admin list and the number of molds that match, each
    /// with its department. A mold whose department is gone is left out.
    pub async fn admin_page(&self, listing: &Listing<'_>) -> DbResult<(Vec<Document>, i64)> {
        let mut filter = Filter::all();
        if let Some(pattern) = listing.search {
            filter = filter.either(
                [f::NAME, f::DESCRIPTION].map(|field| Filter::all().matches(field, pattern)),
            );
        }
        if let Some(department) = listing.department {
            filter = filter.eq(f::DEPARTMENT, department);
        }
        if let Some(active) = listing.active {
            filter = filter.eq(f::ACTIVE, active);
        }
        let stages = vec![
            doc! { "$match": filter.into_doc() },
            department_lookup(),
            doc! { "$unwind": format!("${}", f::DEPARTMENT) },
        ];
        page_with_total(&self.rows, stages, &listing.slice).await
    }

    /// The departments that have at least one active mold.
    pub async fn departments_with_active(&self) -> DbResult<HashSet<ObjectId>> {
        Ok(self
            .rows
            .select(Filter::all().eq(f::ACTIVE, true), &[f::DEPARTMENT])
            .await?
            .iter()
            .filter_map(|d| d.get_object_id(f::DEPARTMENT).ok())
            .collect())
    }

    /// Change what a person may edit. A description that was not sent is left
    /// as it is.
    pub async fn edit(&self, id: ObjectId, edited: &Mold) -> DbResult<()> {
        let mut changes = Changes::new()
            .set(f::NAME, edited.name.as_str())
            .set(f::CAPACITY, edited.production_capacity_per_hour)
            .set(f::DEPARTMENT, edited.department_id.oid())
            .set(f::ACTIVE, edited.is_active)
            .set(f::UPDATED, bson::DateTime::now());
        if let Some(description) = &edited.description {
            changes = changes.set(f::DESCRIPTION, description.as_str());
        }
        self.rows.update(Filter::id(id), changes).await?;
        Ok(())
    }

    /// Activate or deactivate a mold.
    pub async fn set_active(&self, id: ObjectId, active: bool) -> DbResult<()> {
        self.rows
            .update(
                Filter::id(id),
                Changes::new()
                    .set(f::ACTIVE, active)
                    .set(f::UPDATED, bson::DateTime::now()),
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};

    use super::super::test_db;
    use super::*;
    use crate::models::Id;

    #[tokio::test]
    async fn lists_edit_and_activation() {
        let db = test_db("linesentry_pt_molds").await;
        let molds = Molds::new(&db);
        let (molding, gone) = (ObjectId::new(), ObjectId::new());
        db.collection::<Document>(DEPARTMENTS)
            .insert_one(doc! { "_id": molding, "name": "Molding" })
            .await
            .unwrap();
        let start = Utc::now();
        let mold = |n: i64, name: &str, about: Option<&str>, department, active| Mold {
            id: None,
            name: name.into(),
            description: about.map(Into::into),
            production_capacity_per_hour: 100.0,
            department_id: Id(department),
            is_active: active,
            created_at: Some(start + Duration::seconds(n)),
            updated_at: None,
        };
        molds
            .rows
            .insert_many(&[
                mold(1, "Cap", Some("20 mm"), molding, true),
                mold(2, "Bottle", None, molding, false),
                mold(3, "Lid", Some("for the cap"), molding, true),
                mold(4, "Lost", None, gone, true),
            ])
            .await
            .unwrap();
        let listing = |search, active, skip| Listing {
            search,
            department: Some(molding),
            active,
            slice: Slice {
                sort_by: f::NAME,
                ascending: false,
                skip,
                limit: 2,
            },
        };
        let names = |rows: &[Document]| -> Vec<String> {
            rows.iter()
                .filter_map(|d| d.get_str(f::NAME).ok().map(str::to_string))
                .collect()
        };

        let (rows, total) = molds.admin_page(&listing(None, None, 0)).await.unwrap();
        assert_eq!((names(&rows), total), (vec!["Lid".into(), "Cap".into()], 3));
        assert_eq!(
            rows[0]
                .get_document(f::DEPARTMENT)
                .and_then(|d| d.get_str("name")),
            Ok("Molding")
        );
        let (rows, total) = molds.admin_page(&listing(None, None, 2)).await.unwrap();
        assert_eq!((names(&rows), total), (vec!["Bottle".into()], 3));
        let (rows, total) = molds
            .admin_page(&listing(Some("cap"), Some(true), 0))
            .await
            .unwrap();
        assert_eq!((names(&rows), total), (vec!["Lid".into(), "Cap".into()], 2));
        // A mold whose department is gone is not in the admin list.
        let everywhere = Listing {
            department: None,
            ..listing(None, None, 0)
        };
        assert_eq!(molds.admin_page(&everywhere).await.unwrap().1, 3);

        // It is in the plain list, which also leaves out the inactive one.
        assert_eq!(molds.active_with_department(None).await.unwrap().len(), 3);
        assert_eq!(
            molds
                .active_with_department(Some(molding))
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            molds.departments_with_active().await.unwrap(),
            HashSet::from([molding, gone])
        );

        let cap = molds
            .rows
            .find_one(Filter::all().eq(f::NAME, "Cap"))
            .await
            .unwrap()
            .unwrap();
        let id = cap.id.unwrap().oid();
        let edited = Mold {
            name: "Cap 20".into(),
            description: None,
            created_at: None,
            ..cap
        };
        molds.edit(id, &edited).await.unwrap();
        molds.set_active(id, false).await.unwrap();
        let stored = molds.rows.get(id).await.unwrap().unwrap();
        assert_eq!(stored.name, "Cap 20");
        assert_eq!(stored.description.as_deref(), Some("20 mm"));
        assert!(!stored.is_active && stored.created_at.is_some());
        db.drop().await.unwrap();
    }
}
