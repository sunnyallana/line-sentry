//! The PLC registry, including when each PLC's daemon last posted.

use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use mongodb::Database;

use super::{Changes, DbResult, Entity, Filter, Persister};
use crate::models::{Plc, PLCS};

impl Entity for Plc {
    const COLLECTION: &'static str = PLCS;
}

pub mod f {
    pub const PLC_ID: &str = "plcId";
    pub const NAME: &str = "name";
    pub const IP: &str = "ip";
    pub const RACK: &str = "rack";
    pub const SLOT: &str = "slot";
    pub const BYTE_COUNT: &str = "byteCount";
    pub const UPDATED: &str = "updatedAt";
    pub const LAST_SEEN: &str = "lastSeenAt";
    pub const ACTIVE: &str = "isActive";
}

pub struct Plcs {
    pub rows: Persister<Plc>,
}

impl Plcs {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// The PLC's daemon just posted.
    pub async fn mark_seen(&self, plc_id: &str) -> DbResult<()> {
        self.rows
            .update(
                Filter::all().eq(f::PLC_ID, plc_id),
                Changes::new().set(f::LAST_SEEN, bson::DateTime::now()),
            )
            .await?;
        Ok(())
    }

    /// A PLC that has never been stamped starts its silence clock at `now`.
    pub async fn stamp_unseen(&self, now: DateTime<Utc>) -> DbResult<()> {
        self.rows
            .update_all(
                Filter::all().exists(f::LAST_SEEN, false),
                Changes::new().set(f::LAST_SEEN, bson::DateTime::from_chrono(now)),
            )
            .await?;
        Ok(())
    }

    /// Ids of the PLCs that have not posted since `cutoff`.
    pub async fn silent_since(&self, cutoff: DateTime<Utc>) -> DbResult<Vec<String>> {
        Ok(self
            .rows
            .select(
                Filter::all().lt(f::LAST_SEEN, bson::DateTime::from_chrono(cutoff)),
                &[f::PLC_ID],
            )
            .await?
            .iter()
            .filter_map(|d| d.get_str(f::PLC_ID).ok().map(str::to_string))
            .collect())
    }

    pub async fn active(&self) -> DbResult<Vec<Plc>> {
        self.rows.find(Filter::all().eq(f::ACTIVE, true)).await
    }

    /// Whether a PLC is registered under this id.
    pub async fn is_registered(&self, plc_id: &str) -> DbResult<bool> {
        self.rows.exists(Filter::all().eq(f::PLC_ID, plc_id)).await
    }

    /// Change what a person may edit. The id the daemons post under and the
    /// last-seen mark are left alone, and so is an address that was not sent.
    pub async fn edit(&self, id: ObjectId, edited: &Plc) -> DbResult<()> {
        let mut changes = Changes::new()
            .set(f::NAME, edited.name.as_str())
            .set(f::RACK, edited.rack)
            .set(f::SLOT, edited.slot)
            .set(f::BYTE_COUNT, edited.byte_count)
            .set(f::ACTIVE, edited.is_active)
            .set(f::UPDATED, bson::DateTime::now());
        if let Some(ip) = &edited.ip {
            changes = changes.set(f::IP, ip.as_str());
        }
        self.rows.update(Filter::id(id), changes).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_db;
    use super::*;

    #[tokio::test]
    async fn edit_keeps_the_slug_the_last_seen_mark_and_an_unsent_address() {
        let db = test_db("linesentry_pt_plcs").await;
        let plcs = Plcs::new(&db);
        let mut plc = Plc {
            id: None,
            plc_id: "line-1".into(),
            name: "Line 1".into(),
            ip: Some("10.0.0.5".into()),
            rack: 0,
            slot: 1,
            byte_count: 1,
            is_active: true,
            last_seen_at: None,
            created_at: Some(Utc::now()),
            updated_at: None,
        };
        let id = plcs.rows.insert(&plc).await.unwrap();
        assert!(plcs.is_registered("line-1").await.unwrap());
        assert!(!plcs.is_registered("line-2").await.unwrap());
        plcs.mark_seen("line-1").await.unwrap();

        plc.plc_id = "renamed".into();
        plc.name = "Line one".into();
        plc.ip = None;
        plc.byte_count = 4;
        plc.is_active = false;
        plcs.edit(id, &plc).await.unwrap();

        let stored = plcs.rows.get(id).await.unwrap().unwrap();
        assert_eq!(stored.plc_id, "line-1");
        assert_eq!((stored.name.as_str(), stored.byte_count), ("Line one", 4));
        assert_eq!(stored.ip.as_deref(), Some("10.0.0.5"));
        assert!(stored.last_seen_at.is_some() && stored.created_at.is_some());
        assert!(plcs.active().await.unwrap().is_empty());
        db.drop().await.unwrap();
    }
}
