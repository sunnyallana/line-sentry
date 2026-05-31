//! Data models mirroring the legacy Mongoose schemas (`server/models/*.js`).
//!
//! Two cross-cutting conventions make these structs serve both MongoDB (BSON)
//! and the JSON API from a single definition:
//!   * [`Id`] serializes as a native ObjectId for BSON but a hex string for
//!     JSON — so the frontend keeps receiving plain `_id` strings.
//!   * `chrono::DateTime<Utc>` maps to a BSON date and to an ISO-8601 string in
//!     JSON. Numeric fields use `f64` because Mongoose persists `Number` as BSON
//!     Double; reading those into `i32` would fail on existing documents.

use bson::oid::ObjectId;
use chrono::{DateTime, Utc};
use mongodb::options::IndexOptions;
use mongodb::{Database, IndexModel};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

// ── Collection names (must match Mongoose's pluralisation of existing data) ──
pub const USERS: &str = "users";
pub const DEPARTMENTS: &str = "departments";
pub const MACHINES: &str = "machines";
pub const MOLDS: &str = "molds";
pub const SENSORS: &str = "sensors";
pub const SENSOR_PIN_MAPPINGS: &str = "sensorpinmappings";
pub const SIGNAL_DATA: &str = "signaldatas";
pub const PRODUCTION_RECORDS: &str = "productionrecords";
pub const REPORTS: &str = "reports";
pub const CONFIGS: &str = "configs";
pub const PLCS: &str = "plcs";

/// Sentinel PLC id used when a mapping/payload doesn't name a PLC (single-PLC
/// installs and legacy data).
pub const DEFAULT_PLC: &str = "default";

fn default_true() -> bool {
    true
}

// ── Date (de)serialization ───────────────────────────────────────────────────
// chrono's own serde always emits an RFC3339 *string*, which MongoDB would store
// as a BSON String (breaking date-range queries). These `#[serde(with = ...)]`
// helpers store a native BSON Date for the driver (non-human-readable) while
// still emitting an ISO-8601 string for the JSON API (human-readable).
pub mod bson_dt {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(dt: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        } else {
            bson::DateTime::from_chrono(*dt).serialize(s)
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        if d.is_human_readable() {
            let s = String::deserialize(d)?;
            DateTime::parse_from_rfc3339(&s)
                .map(|x| x.with_timezone(&Utc))
                .map_err(serde::de::Error::custom)
        } else {
            bson::DateTime::deserialize(d).map(|b| b.to_chrono())
        }
    }
}

pub mod bson_dt_opt {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(dt) => super::bson_dt::serialize(dt, s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        if d.is_human_readable() {
            Ok(Option::<String>::deserialize(d)?
                .map(|s| DateTime::parse_from_rfc3339(&s).map(|x| x.with_timezone(&Utc)))
                .transpose()
                .map_err(serde::de::Error::custom)?)
        } else {
            Ok(Option::<bson::DateTime>::deserialize(d)?.map(|b| b.to_chrono()))
        }
    }
}

// ── Id: ObjectId in BSON, hex string in JSON ─────────────────────────────────
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Id(pub ObjectId);

impl Id {
    pub fn new() -> Self {
        Id(ObjectId::new())
    }
    pub fn to_hex(&self) -> String {
        self.0.to_hex()
    }
    pub fn oid(&self) -> ObjectId {
        self.0
    }
}

impl Default for Id {
    fn default() -> Self {
        Id::new()
    }
}

impl From<ObjectId> for Id {
    fn from(o: ObjectId) -> Self {
        Id(o)
    }
}

impl std::fmt::Display for Id {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.to_hex())
    }
}

impl std::str::FromStr for Id {
    type Err = bson::oid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        ObjectId::parse_str(s).map(Id)
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&self.0.to_hex())
        } else {
            self.0.serialize(s)
        }
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if d.is_human_readable() {
            let s = String::deserialize(d)?;
            s.parse().map_err(serde::de::Error::custom)
        } else {
            ObjectId::deserialize(d).map(Id)
        }
    }
}

// ── User ─────────────────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub username: String,
    pub email: String,
    /// bcrypt hash. Never expose via the public DTO — use [`UserPublic`].
    pub password: String,
    pub role: String, // "admin" | "operator"
    #[serde(rename = "departmentId", skip_serializing_if = "Option::is_none")]
    pub department_id: Option<Id>,
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

/// User shape safe to return over the API (no password hash).
#[derive(Clone, Debug, Serialize)]
pub struct UserPublic {
    #[serde(rename = "_id")]
    pub id: Id,
    pub username: String,
    pub email: String,
    pub role: String,
    #[serde(rename = "departmentId", skip_serializing_if = "Option::is_none")]
    pub department_id: Option<Id>,
    #[serde(rename = "isActive")]
    pub is_active: bool,
}

impl User {
    /// Project to the password-free public shape. Returns `None` if the document
    /// somehow lacks an `_id` (only possible before insertion).
    pub fn into_public(self) -> Option<UserPublic> {
        Some(UserPublic {
            id: self.id?,
            username: self.username,
            email: self.email,
            role: self.role,
            department_id: self.department_id,
            is_active: self.is_active,
        })
    }
}

// ── Department ───────────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Department {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub layout: bson::Bson,
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Machine ──────────────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Position {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dimensions {
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Machine {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "departmentId")]
    pub department_id: Id,
    #[serde(default)]
    pub position: Option<Position>,
    #[serde(default)]
    pub dimensions: Option<Dimensions>,
    #[serde(default = "default_inactive")]
    pub status: String, // running | stoppage | stopped_yet_producing | inactive
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

fn default_inactive() -> String {
    "inactive".to_string()
}

// ── Mold ─────────────────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mold {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "productionCapacityPerHour")]
    pub production_capacity_per_hour: f64,
    #[serde(rename = "departmentId")]
    pub department_id: Id,
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Sensor ───────────────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sensor {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "machineId")]
    pub machine_id: Id,
    #[serde(rename = "sensorType")]
    pub sensor_type: String, // "power" | "unit-cycle"
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

// ── SensorPinMapping ─────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SensorPinMapping {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    #[serde(rename = "sensorId")]
    pub sensor_id: Id,
    /// Which PLC this pin belongs to (the registry's `plcId`). Defaults to
    /// `"default"` for single-PLC installs and pre-multi-PLC data.
    #[serde(rename = "plcId", default = "default_plc_id")]
    pub plc_id: String,
    /// Pin address in Siemens byte.bit form, e.g. `"Q0.0"`, `"Q2.5"`.
    #[serde(rename = "pinId")]
    pub pin_id: String,
}

fn default_plc_id() -> String {
    DEFAULT_PLC.to_string()
}

/// A PLC the daemon(s) read from. Each exposes `8 * byte_count` output pins
/// (Q0.0 … Q{byte_count-1}.7); mappings are scoped to its `plc_id`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plc {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    /// Stable slug the daemon posts under (e.g. "default", "line-1").
    #[serde(rename = "plcId")]
    pub plc_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(default)]
    pub rack: i32,
    #[serde(default = "default_slot")]
    pub slot: i32,
    /// Number of output bytes the daemon reads → `8 * byte_count` pins.
    #[serde(rename = "byteCount", default = "default_byte_count")]
    pub byte_count: i32,
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

fn default_slot() -> i32 {
    1
}
fn default_byte_count() -> i32 {
    1
}

// ── SignalData ───────────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignalData {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    #[serde(rename = "sensorId")]
    pub sensor_id: Id,
    #[serde(rename = "machineId")]
    pub machine_id: Id,
    pub value: f64,
    #[serde(with = "bson_dt")]
    pub timestamp: DateTime<Utc>,
}

// ── ProductionRecord (+ nested) ──────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stoppage {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(
        rename = "sapNotificationNumber",
        skip_serializing_if = "Option::is_none"
    )]
    pub sap_notification_number: Option<String>,
    #[serde(
        rename = "startTime",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub start_time: Option<DateTime<Utc>>,
    #[serde(
        rename = "endTime",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub end_time: Option<DateTime<Utc>>,
    #[serde(default)]
    pub duration: f64,
    #[serde(rename = "isPending", default)]
    pub is_pending: bool,
    #[serde(rename = "isClassified", default)]
    pub is_classified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HourlyData {
    pub hour: f64,
    #[serde(rename = "unitsProduced", default)]
    pub units_produced: f64,
    #[serde(rename = "defectiveUnits", default)]
    pub defective_units: f64,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "operatorId", skip_serializing_if = "Option::is_none")]
    pub operator_id: Option<Id>,
    #[serde(rename = "moldId", skip_serializing_if = "Option::is_none")]
    pub mold_id: Option<Id>,
    #[serde(default)]
    pub stoppages: Vec<Stoppage>,
    #[serde(rename = "runningMinutes", default)]
    pub running_minutes: f64,
    #[serde(rename = "stoppageMinutes", default)]
    pub stoppage_minutes: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProductionRecord {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    #[serde(rename = "machineId")]
    pub machine_id: Id,
    #[serde(rename = "operatorId", skip_serializing_if = "Option::is_none")]
    pub operator_id: Option<Id>,
    #[serde(rename = "moldId", skip_serializing_if = "Option::is_none")]
    pub mold_id: Option<Id>,
    #[serde(rename = "unitsProduced", default)]
    pub units_produced: f64,
    #[serde(rename = "defectiveUnits", default)]
    pub defective_units: f64,
    #[serde(rename = "startTime", with = "bson_dt")]
    pub start_time: DateTime<Utc>,
    #[serde(
        rename = "endTime",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub end_time: Option<DateTime<Utc>>,
    #[serde(rename = "hourlyData", default)]
    pub hourly_data: Vec<HourlyData>,
    #[serde(
        rename = "lastActivityTime",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_activity_time: Option<DateTime<Utc>>,
    #[serde(
        rename = "createdAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        rename = "updatedAt",
        with = "bson_dt_opt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Config (+ nested) ────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SignalTimeouts {
    #[serde(rename = "powerSignalTimeout", default)]
    pub power_signal_timeout: Option<f64>,
    #[serde(rename = "cycleSignalTimeout", default)]
    pub cycle_signal_timeout: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    #[serde(rename = "signalTimeouts", default)]
    pub signal_timeouts: Option<SignalTimeouts>,
    // Remaining config sections (plc, shifts, email, thresholds) are handled in
    // Phase 3 where the /config route is ported; the pipeline only needs timeouts.
}

// ── Index creation (run once at startup) ─────────────────────────────────────
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

    tracing::info!("MongoDB indexes ensured");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Wrap {
        id: Id,
    }

    #[test]
    fn id_serializes_as_hex_in_json_and_objectid_on_the_wire() {
        let id = Id(ObjectId::parse_str("65a1f2c3d4e5f60718293a4b").unwrap());

        // JSON (human-readable) → plain hex string, and round-trips.
        let json = serde_json::to_value(id).unwrap();
        assert_eq!(json, serde_json::json!("65a1f2c3d4e5f60718293a4b"));
        let from_json: Id = serde_json::from_value(json).unwrap();
        assert_eq!(from_json, id);

        // The MongoDB driver serializes documents via the raw (non-human-readable)
        // BSON serializer — exactly what `to_vec` uses. Confirm the field lands as
        // a native ObjectId on the wire, and round-trips back.
        let bytes = bson::to_vec(&Wrap { id }).unwrap();
        let doc = bson::Document::from_reader(&mut std::io::Cursor::new(bytes.clone())).unwrap();
        assert_eq!(
            doc.get("id").unwrap().element_type(),
            bson::spec::ElementType::ObjectId,
            "Id must serialize as a native BSON ObjectId for the driver"
        );
        let back: Wrap = bson::from_slice(&bytes).unwrap();
        assert_eq!(back.id, id);
    }

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct DateWrap {
        #[serde(with = "bson_dt")]
        t: chrono::DateTime<Utc>,
    }

    #[test]
    fn date_serializes_as_iso_in_json_and_bson_date_on_the_wire() {
        let t = chrono::DateTime::parse_from_rfc3339("2026-05-31T12:34:56.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let w = DateWrap { t };

        // JSON → ISO-8601 string, round-trips.
        let json = serde_json::to_value(&w).unwrap();
        assert_eq!(json["t"], serde_json::json!("2026-05-31T12:34:56.000Z"));
        let from_json: DateWrap = serde_json::from_value(json).unwrap();
        assert_eq!(from_json, w);

        // Driver wire → native BSON Date (NOT a string), round-trips. This guards
        // the bug where chrono's default serde stored dates as strings, breaking
        // date-range queries.
        let bytes = bson::to_vec(&w).unwrap();
        let doc = bson::Document::from_reader(&mut std::io::Cursor::new(bytes.clone())).unwrap();
        assert_eq!(
            doc.get("t").unwrap().element_type(),
            bson::spec::ElementType::DateTime,
            "date must serialize as a native BSON Date for the driver"
        );
        let back: DateWrap = bson::from_slice(&bytes).unwrap();
        assert_eq!(back, w);
    }
}
