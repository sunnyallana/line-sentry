//! Which PLC pin each sensor is wired to.

use bson::{doc, oid::ObjectId, Document};
use mongodb::Database;

use super::{DbResult, Entity, Filter, Persister};
use crate::models::{Id, SensorPinMapping, MACHINES, SENSORS, SENSOR_PIN_MAPPINGS};

impl Entity for SensorPinMapping {
    const COLLECTION: &'static str = SENSOR_PIN_MAPPINGS;
}

pub mod f {
    pub const SENSOR: &str = "sensorId";
    pub const PLC_ID: &str = "plcId";
    pub const PIN: &str = "pinId";
}

pub struct Pins {
    pub rows: Persister<SensorPinMapping>,
}

impl Pins {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    pub async fn all(&self) -> DbResult<Vec<SensorPinMapping>> {
        self.rows.find(Filter::all()).await
    }

    /// The wiring of several sensors in one read.
    pub async fn of_sensors(&self, sensors: &[ObjectId]) -> DbResult<Vec<SensorPinMapping>> {
        if sensors.is_empty() {
            return Ok(Vec::new());
        }
        self.rows
            .find(Filter::all().any_of(f::SENSOR, sensors.iter().copied()))
            .await
    }

    /// Whether some sensor is already wired to this pin of the PLC.
    pub async fn is_taken(&self, plc_id: &str, pin: &str) -> DbResult<bool> {
        self.rows
            .exists(Filter::all().eq(f::PLC_ID, plc_id).eq(f::PIN, pin))
            .await
    }

    /// Whether the sensor is wired to a pin.
    pub async fn is_wired(&self, sensor: ObjectId) -> DbResult<bool> {
        self.rows.exists(Filter::all().eq(f::SENSOR, sensor)).await
    }

    /// Whether any sensor is wired to the PLC.
    pub async fn any_on_plc(&self, plc_id: &str) -> DbResult<bool> {
        self.rows.exists(Filter::all().eq(f::PLC_ID, plc_id)).await
    }

    /// Wire a sensor to a pin. The caller checks that the pin is free.
    pub async fn wire(&self, sensor: Id, plc_id: &str, pin: &str) -> DbResult<SensorPinMapping> {
        let mut mapping = SensorPinMapping {
            id: None,
            sensor_id: sensor,
            plc_id: plc_id.to_string(),
            pin_id: pin.to_string(),
        };
        mapping.id = Some(Id(self.rows.insert(&mapping).await?));
        Ok(mapping)
    }

    /// Free every pin wired to any of these sensors, in one statement.
    pub async fn of_machine_sensors_delete(&self, sensors: &[ObjectId]) -> DbResult<u64> {
        if sensors.is_empty() {
            return Ok(0);
        }
        self.rows
            .delete_all(Filter::all().any_of(f::SENSOR, sensors.iter().copied()))
            .await
    }

    /// Free whatever pins the sensor is wired to.
    pub async fn unwire(&self, sensor: ObjectId) -> DbResult<u64> {
        self.rows
            .delete_all(Filter::all().eq(f::SENSOR, sensor))
            .await
    }

    /// Every wiring with its sensor in place of the sensor's id, and the
    /// sensor's machine likewise. A wiring whose sensor or machine is gone is
    /// left out.
    pub async fn with_sensor(&self) -> DbResult<Vec<Document>> {
        let stages = vec![
            doc! { "$lookup": {
                "from": SENSORS, "localField": f::SENSOR, "foreignField": "_id", "as": f::SENSOR,
                "pipeline": [
                    { "$lookup": {
                        "from": MACHINES, "localField": "machineId", "foreignField": "_id",
                        "as": "machineId",
                    }},
                    { "$unwind": "$machineId" },
                ],
            }},
            doc! { "$unwind": format!("${}", f::SENSOR) },
        ];
        self.rows.aggregate(stages).await
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_db;
    use super::*;

    #[tokio::test]
    async fn wiring_is_found_by_pin_by_sensor_and_with_its_sensor() {
        let db = test_db("linesentry_pt_pins").await;
        let pins = Pins::new(&db);
        let (machine, wired, loose) = (ObjectId::new(), ObjectId::new(), ObjectId::new());
        db.collection::<Document>(MACHINES)
            .insert_one(doc! { "_id": machine, "name": "Press" })
            .await
            .unwrap();
        db.collection::<Document>(SENSORS)
            .insert_one(doc! { "_id": wired, "name": "Power signal", "machineId": machine })
            .await
            .unwrap();

        let mapping = pins.wire(Id(wired), "line-1", "Q0.0").await.unwrap();
        assert!(mapping.id.is_some());
        // A wiring whose sensor does not exist.
        pins.wire(Id(loose), "line-1", "Q0.1").await.unwrap();

        assert!(pins.is_taken("line-1", "Q0.0").await.unwrap());
        assert!(!pins.is_taken("line-2", "Q0.0").await.unwrap());
        assert!(pins.is_wired(wired).await.unwrap());
        assert!(pins.any_on_plc("line-1").await.unwrap());
        assert!(!pins.any_on_plc("line-2").await.unwrap());
        assert_eq!(pins.of_sensors(&[wired, loose]).await.unwrap().len(), 2);
        assert!(pins.of_sensors(&[]).await.unwrap().is_empty());

        let populated = pins.with_sensor().await.unwrap();
        assert_eq!(populated.len(), 1);
        let machine_name = populated[0]
            .get_document(f::SENSOR)
            .and_then(|s| s.get_document("machineId"))
            .and_then(|m| m.get_str("name"));
        assert_eq!(machine_name, Ok("Press"));

        assert_eq!(pins.unwire(wired).await.unwrap(), 1);
        assert!(!pins.is_taken("line-1", "Q0.0").await.unwrap());
        db.drop().await.unwrap();
    }
}
