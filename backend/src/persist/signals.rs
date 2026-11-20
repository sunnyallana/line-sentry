//! The latest value of each sensor.

use bson::{doc, oid::ObjectId, Bson, Document};
use chrono::{DateTime, Utc};
use mongodb::Database;

use super::records::{self, Records};
use super::{Batch, Changes, DbResult, Entity, Filter, Persister};
use crate::models::{Id, SignalData, SENSORS, SIGNAL_DATA};

impl Entity for SignalData {
    const COLLECTION: &'static str = SIGNAL_DATA;
}

pub mod f {
    pub const SENSOR: &str = "sensorId";
    pub const MACHINE: &str = "machineId";
    pub const VALUE: &str = "value";
    pub const AT: &str = "timestamp";
}

pub struct Signals {
    pub rows: Persister<SignalData>,
}

impl Signals {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// Record a sensor's current value, creating its row the first time.
    pub fn queue_latest(
        &self,
        batch: &mut Batch,
        sensor: Id,
        machine: Id,
        value: u8,
        at: DateTime<Utc>,
    ) -> usize {
        batch.upsert(
            &self.rows,
            Filter::all().eq(f::SENSOR, sensor.oid()),
            Changes::new()
                .set(f::MACHINE, machine.oid())
                .set(f::VALUE, value as f64)
                .set(f::AT, bson::DateTime::from_chrono(at)),
        )
    }

    /// Record a value a person or another system reported for a sensor,
    /// creating the sensor's row the first time.
    pub async fn set_latest(
        &self,
        sensor: ObjectId,
        machine: ObjectId,
        value: Bson,
        at: DateTime<Utc>,
    ) -> DbResult<()> {
        self.rows
            .upsert(
                Filter::all().eq(f::SENSOR, sensor),
                Changes::new()
                    .set(f::MACHINE, machine)
                    .set(f::VALUE, value)
                    .set(f::AT, bson::DateTime::from_chrono(at)),
            )
            .await?;
        Ok(())
    }

    /// The current value of each of a machine's sensors, with the sensor in
    /// place of its id. A value whose sensor is gone is left out. Readings
    /// are buffered: flush the store first when the freshest are needed.
    pub async fn latest_on(&self, machine: ObjectId) -> DbResult<Vec<Document>> {
        let stages = vec![
            doc! { "$match": Filter::all().eq(f::MACHINE, machine).into_doc() },
            doc! { "$lookup": {
                "from": SENSORS, "localField": f::SENSOR, "foreignField": "_id", "as": f::SENSOR,
            }},
            doc! { "$unwind": format!("${}", f::SENSOR) },
        ];
        self.rows.aggregate(stages).await
    }

    /// Remove every value stored for a machine.
    pub async fn delete_on(&self, machine: ObjectId) -> DbResult<u64> {
        self.rows
            .delete_all(Filter::all().eq(f::MACHINE, machine))
            .await
    }
}

/// How many stoppages, over all production records, still have no reason.
pub async fn unclassified_stoppages(records: &Records) -> DbResult<i64> {
    use records::f as r;
    let reason = format!("{}.{}.{}", r::HOURS, r::HOUR_STOPPAGES, r::STOP_REASON);
    let stages = vec![
        doc! { "$match": Filter::all().eq(&reason, records::NO_REASON).into_doc() },
        doc! { "$project": { "unclassifiedCount": { "$size": { "$filter": {
            "input": { "$reduce": {
                "input": format!("${}", r::HOURS),
                "initialValue": [],
                "in": { "$concatArrays": ["$$value", format!("$$this.{}", r::HOUR_STOPPAGES)] },
            }},
            "cond": { "$eq": [format!("$$this.{}", r::STOP_REASON), records::NO_REASON] },
        }}}}},
        doc! { "$group": { "_id": Bson::Null, "total": { "$sum": "$unclassifiedCount" } } },
    ];
    let total = records.rows.aggregate(stages).await?.into_iter().next();
    // No record with such a stoppage means no group, hence zero.
    Ok(match total.as_ref().and_then(|d| d.get("total")) {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        Some(Bson::Double(n)) => *n as i64,
        _ => 0,
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_db;
    use super::*;

    #[tokio::test]
    async fn latest_values_come_with_their_sensor() {
        let db = test_db("linesentry_pt_signals").await;
        let signals = Signals::new(&db);
        let (machine, sensor) = (ObjectId::new(), ObjectId::new());
        db.collection::<Document>(SENSORS)
            .insert_one(doc! { "_id": sensor, "name": "Power signal" })
            .await
            .unwrap();
        let now = Utc::now();
        for value in [0.0, 1.0] {
            signals
                .set_latest(sensor, machine, Bson::Double(value), now)
                .await
                .unwrap();
        }
        // A value whose sensor does not exist, and one of another machine.
        signals
            .set_latest(ObjectId::new(), machine, Bson::Double(1.0), now)
            .await
            .unwrap();
        signals
            .set_latest(ObjectId::new(), ObjectId::new(), Bson::Double(1.0), now)
            .await
            .unwrap();

        let latest = signals.latest_on(machine).await.unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].get_f64(f::VALUE), Ok(1.0));
        assert_eq!(
            latest[0]
                .get_document(f::SENSOR)
                .and_then(|s| s.get_str("name")),
            Ok("Power signal")
        );

        assert_eq!(signals.delete_on(machine).await.unwrap(), 2);
        assert_eq!(signals.rows.count(Filter::all()).await.unwrap(), 1);
        db.drop().await.unwrap();
    }

    #[tokio::test]
    async fn unclassified_stoppages_are_counted_over_every_record() {
        let db = test_db("linesentry_pt_unclassified").await;
        let records = Records::new(&db);
        assert_eq!(unclassified_stoppages(&records).await.unwrap(), 0);

        let stoppage = |reason: &str| doc! { "_id": ObjectId::new(), "reason": reason };
        db.collection::<Document>(crate::models::PRODUCTION_RECORDS)
            .insert_many([
                doc! { "hourlyData": [
                    { "hour": 8, "stoppages": [stoppage(records::NO_REASON), stoppage("breakdown")] },
                    { "hour": 9, "stoppages": [stoppage(records::NO_REASON)] },
                ]},
                doc! { "hourlyData": [{ "hour": 8, "stoppages": [stoppage(records::NO_REASON)] }] },
                doc! { "hourlyData": [{ "hour": 8, "stoppages": [stoppage("breakdown")] }] },
                doc! { "hourlyData": [] },
            ])
            .await
            .unwrap();
        assert_eq!(unclassified_stoppages(&records).await.unwrap(), 3);
        db.drop().await.unwrap();
    }
}
