//! Indexes and one-off data migrations. Run at start; every step is safe to
//! repeat.

use mongodb::options::IndexOptions;
use mongodb::{Database, IndexModel};

use crate::models::*;

pub async fn ensure_indexes(db: &Database) -> anyhow::Result<()> {
    use bson::doc;

    let unique = IndexOptions::builder().unique(true).build();

    // Users: unique username & email.
    db.collection::<User>(USERS)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "username": 1 })
                .options(unique.clone())
                .build(),
        )
        .await?;
    db.collection::<User>(USERS)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "email": 1 })
                .options(unique.clone())
                .build(),
        )
        .await?;

    // SensorPinMapping: unique pinId.
    // ── Multi-PLC migration (idempotent) ──────────────────────────────────────
    {
        use futures::TryStreamExt;
        let pins = db.collection::<bson::Document>(SENSOR_PIN_MAPPINGS);
        // Scope legacy mappings to the default PLC.
        pins.update_many(
            doc! { "plcId": { "$exists": false } },
            doc! { "$set": { "plcId": DEFAULT_PLC } },
        )
        .await
        .ok();
        // Rename legacy linear pins "DQ.N" → Siemens byte.bit "Q0.N".
        if let Ok(mut cur) = pins.find(doc! { "pinId": { "$regex": "^DQ\\." } }).await {
            while let Ok(Some(d)) = cur.try_next().await {
                if let (Ok(id), Ok(pin)) = (d.get_object_id("_id"), d.get_str("pinId")) {
                    if let Some(bit) = pin.strip_prefix("DQ.") {
                        let new_pin = format!("Q0.{bit}");
                        pins.update_one(doc! { "_id": id }, doc! { "$set": { "pinId": new_pin } })
                            .await
                            .ok();
                    }
                }
            }
        }
        // Drop the old global-unique pinId index (replaced by a per-PLC one).
        pins.drop_index("pinId_1").await.ok();
        // Seed a default PLC if the registry is empty.
        let plcs = db.collection::<bson::Document>(PLCS);
        if plcs.count_documents(doc! {}).await.unwrap_or(0) == 0 {
            plcs.insert_one(doc! {
                "plcId": DEFAULT_PLC, "name": "Default PLC",
                "rack": 0, "slot": 1, "byteCount": 2, "isActive": true,
            })
            .await
            .ok();
        }
    }

    // SensorPinMapping: a pin is unique within its PLC.
    db.collection::<SensorPinMapping>(SENSOR_PIN_MAPPINGS)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "plcId": 1, "pinId": 1 })
                .options(unique.clone())
                .build(),
        )
        .await?;
    // PLC registry: unique plcId.
    db.collection::<Plc>(PLCS)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "plcId": 1 })
                .options(unique.clone())
                .build(),
        )
        .await?;

    // Time-series & lookup indexes (several were missing in the Node app).
    let plain = |keys| IndexModel::builder().keys(keys).build();
    db.collection::<SignalData>(SIGNAL_DATA)
        .create_index(plain(doc! { "sensorId": 1, "timestamp": -1 }))
        .await?;
    db.collection::<SignalData>(SIGNAL_DATA)
        .create_index(plain(doc! { "machineId": 1, "timestamp": -1 }))
        .await?;
    db.collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .create_index(plain(doc! { "machineId": 1, "startTime": -1 }))
        .await?;
    db.collection::<Machine>(MACHINES)
        .create_index(plain(doc! { "departmentId": 1 }))
        .await?;
    db.collection::<Sensor>(SENSORS)
        .create_index(plain(doc! { "machineId": 1 }))
        .await?;

    // One record per machine per day, so two payloads creating the day's record
    // at the same instant cannot both succeed.
    db.collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "machineId": 1, "startTime": 1 })
                .options(unique.clone())
                .build(),
        )
        .await?;
    // Payload receipts only matter while a daemon might still retry.
    db.collection::<bson::Document>(super::ingests::INGESTS)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "at": 1 })
                .options(
                    IndexOptions::builder()
                        .expire_after(std::time::Duration::from_secs(300))
                        .build(),
                )
                .build(),
        )
        .await?;

    tracing::info!("MongoDB indexes ensured");
    Ok(())
}
