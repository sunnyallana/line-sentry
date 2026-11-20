//! The single configuration document.

use std::collections::{HashMap, HashSet};

use bson::{doc, oid::ObjectId, Bson, Document};
use mongodb::options::ReturnDocument;
use mongodb::Database;
use serde::{Deserialize, Serialize};

use super::{DbResult, Entity, Filter, Persister};
use crate::models::CONFIGS;

/// The configuration is free-form on purpose: sections are added without a
/// migration, and each reader takes only the section it understands.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(transparent)]
pub struct ConfigRow(pub Document);

impl Entity for ConfigRow {
    const COLLECTION: &'static str = CONFIGS;
}

/// A shift as configured: a name and the hours it covers.
#[derive(Clone, Debug)]
pub struct Shift {
    pub name: String,
    pub start_hour: i64,
    pub end_hour: i64,
}

impl Shift {
    pub fn contains(&self, hour: i64) -> bool {
        if self.start_hour <= self.end_hour {
            hour >= self.start_hour && hour < self.end_hour
        } else {
            hour >= self.start_hour || hour < self.end_hour
        }
    }
}

pub struct Configs {
    pub rows: Persister<ConfigRow>,
}

impl Configs {
    pub fn new(db: &Database) -> Self {
        Self {
            rows: Persister::new(db),
        }
    }

    /// The whole document, if one has been saved.
    pub async fn document(&self) -> DbResult<Option<Document>> {
        Ok(self.rows.find_one(Filter::all()).await?.map(|c| c.0))
    }

    /// One top-level section.
    pub async fn section(&self, name: &str) -> DbResult<Option<Document>> {
        Ok(self
            .rows
            .select_one(Filter::all(), &[name])
            .await?
            .and_then(|d| d.get_document(name).ok().cloned()))
    }

    /// Minutes after which a missing power / cycle signal counts as lost.
    pub async fn signal_timeouts(&self) -> DbResult<(f64, f64)> {
        let section = self.section("signalTimeouts").await?;
        let minutes = |key: &str, default: f64| {
            section
                .as_ref()
                .and_then(|s| number(s.get(key)))
                .filter(|m| *m > 0.0)
                .unwrap_or(default)
        };
        Ok((
            minutes("powerSignalTimeout", 5.0),
            minutes("cycleSignalTimeout", 2.0),
        ))
    }

    pub async fn shifts(&self) -> DbResult<Vec<Shift>> {
        let doc = self.rows.select_one(Filter::all(), &["shifts"]).await?;
        let hour_of = |d: &Document, key: &str| {
            d.get_str(key)
                .ok()
                .and_then(|t| t.split(':').next())
                .and_then(|h| h.parse::<i64>().ok())
        };
        Ok(doc
            .and_then(|d| d.get_array("shifts").ok().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(Bson::as_document)
            .filter_map(|d| {
                Some(Shift {
                    name: d.get_str("name").ok()?.to_string(),
                    start_hour: hour_of(d, "startTime")?,
                    end_hour: hour_of(d, "endTime")?,
                })
            })
            .collect())
    }
}

/// A number however the client's JSON happened to store it.
pub fn number(value: Option<&Bson>) -> Option<f64> {
    match value? {
        Bson::Int32(n) => Some(*n as f64),
        Bson::Int64(n) => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    }
}

// ── Stoppage reasons ─────────────────────────────────────────────────────────

/// A stoppage that counts as a failure: it feeds MTBF, MTTR and the failure
/// rate, and needs a SAP notification number.
pub const KIND_BREAKDOWN: &str = "breakdown";
/// Lost time that is not a failure.
pub const KIND_UNPLANNED: &str = "unplanned";
/// Time the machine was never meant to run; it does not lower availability.
pub const KIND_PLANNED: &str = "planned";

const KINDS: [&str; 3] = [KIND_BREAKDOWN, KIND_UNPLANNED, KIND_PLANNED];
const REASONS: &str = "stoppageReasons";

/// A reason a person can give for a stoppage, as the plant defines it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StoppageReason {
    pub key: String,
    pub label: String,
    pub kind: String,
}

impl From<&StoppageReason> for Bson {
    fn from(r: &StoppageReason) -> Self {
        Bson::Document(doc! { "key": &r.key, "label": &r.label, "kind": &r.kind })
    }
}

/// The reasons a plant has until it defines its own. The keys are the ones
/// stored on stoppages recorded before reasons became configurable.
pub fn default_reasons() -> Vec<StoppageReason> {
    [
        ("breakdown", "Breakdown", KIND_BREAKDOWN),
        ("material_shortage", "No material", KIND_UNPLANNED),
        ("mold_change", "Mold change", KIND_UNPLANNED),
        ("maintenance", "Unplanned maintenance", KIND_UNPLANNED),
        ("planned", "Planned stop", KIND_PLANNED),
        ("other", "Other", KIND_UNPLANNED),
    ]
    .into_iter()
    .map(|(key, label, kind)| StoppageReason {
        key: key.to_string(),
        label: label.to_string(),
        kind: kind.to_string(),
    })
    .collect()
}

/// Reason key to kind, so many stoppages can be looked up against one read of
/// the configuration.
pub fn reason_kinds(reasons: &[StoppageReason]) -> HashMap<String, String> {
    reasons
        .iter()
        .map(|r| (r.key.clone(), r.kind.clone()))
        .collect()
}

/// Check a `stoppageReasons` value before it is saved. The error is worded
/// for the person editing the configuration.
pub fn validate_reasons(value: &Bson) -> Result<(), String> {
    let list = match value {
        Bson::Array(list) if !list.is_empty() => list,
        _ => return Err("stoppageReasons must be a non-empty list".to_string()),
    };
    let mut seen = HashSet::new();
    for entry in list {
        let Some(reason) = entry.as_document() else {
            return Err("Each stoppage reason must have a key, a label and a kind".to_string());
        };
        let key = reason.get_str("key").unwrap_or("");
        if key.is_empty() {
            return Err("Each stoppage reason needs a key".to_string());
        }
        if !key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(format!(
                "Stoppage reason key \"{key}\" may only contain lowercase letters, digits and underscores"
            ));
        }
        // A stoppage carries this key until a person gives it a reason.
        if key == super::records::NO_REASON {
            return Err(format!("Stoppage reason key \"{key}\" is reserved"));
        }
        if !seen.insert(key) {
            return Err(format!(
                "Stoppage reason key \"{key}\" is used more than once"
            ));
        }
        if reason.get_str("label").unwrap_or("").trim().is_empty() {
            return Err(format!("Stoppage reason \"{key}\" needs a label"));
        }
        if !KINDS.contains(&reason.get_str("kind").unwrap_or("")) {
            return Err(format!(
                "Stoppage reason \"{key}\" must be of kind breakdown, unplanned or planned"
            ));
        }
    }
    Ok(())
}

impl Configs {
    /// The plant's stoppage reasons, or the defaults while it has none.
    pub async fn stoppage_reasons(&self) -> DbResult<Vec<StoppageReason>> {
        let doc = self.rows.select_one(Filter::all(), &[REASONS]).await?;
        let reasons: Vec<StoppageReason> = doc
            .and_then(|d| d.get_array(REASONS).ok().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(Bson::as_document)
            .filter_map(|d| {
                Some(StoppageReason {
                    key: d.get_str("key").ok()?.to_string(),
                    label: d.get_str("label").ok()?.to_string(),
                    kind: d.get_str("kind").ok()?.to_string(),
                })
            })
            .collect();
        Ok(if reasons.is_empty() {
            default_reasons()
        } else {
            reasons
        })
    }

    /// The shifts exactly as saved. `None` when the document has no list.
    pub async fn shift_documents(&self) -> DbResult<Option<Vec<Bson>>> {
        let doc = self.rows.select_one(Filter::all(), &["shifts"]).await?;
        Ok(doc.and_then(|d| d.get_array("shifts").ok().cloned()))
    }

    /// Store the first configuration document.
    pub async fn create(&self, config: &Document) -> DbResult<ObjectId> {
        self.rows.insert(&ConfigRow(config.clone())).await
    }

    /// Set the given top-level sections, creating the document if there is
    /// none, and return it as it is afterwards.
    pub async fn save(&self, mut sections: Document) -> DbResult<Option<Document>> {
        sections.remove("_id");
        sections.insert("updatedAt", bson::DateTime::now());
        self.rows
            .raw()
            .find_one_and_update(doc! {}, doc! { "$set": sections })
            .upsert(true)
            .return_document(ReturnDocument::After)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reasons(entries: &[(&str, &str, &str)]) -> Bson {
        Bson::Array(
            entries
                .iter()
                .map(|(key, label, kind)| {
                    Bson::Document(doc! { "key": *key, "label": *label, "kind": *kind })
                })
                .collect(),
        )
    }

    #[test]
    fn the_default_reasons_are_valid() {
        let defaults: Vec<Bson> = default_reasons().iter().map(Bson::from).collect();
        assert_eq!(defaults.len(), 6);
        assert_eq!(validate_reasons(&Bson::Array(defaults)), Ok(()));
        let kinds = reason_kinds(&default_reasons());
        assert_eq!(kinds["breakdown"], KIND_BREAKDOWN);
        assert_eq!(kinds["planned"], KIND_PLANNED);
        assert_eq!(kinds["mold_change"], KIND_UNPLANNED);
    }

    #[test]
    fn reasons_that_cannot_be_used_are_rejected() {
        let rejected = [
            Bson::Null,
            Bson::Array(vec![]),
            Bson::Array(vec![Bson::String("breakdown".into())]),
            reasons(&[("", "Breakdown", "breakdown")]),
            reasons(&[("Tool Wear", "Tool wear", "unplanned")]),
            reasons(&[("unclassified", "Unknown", "unplanned")]),
            reasons(&[("jam", "Jam", "unplanned"), ("jam", "Jammed", "breakdown")]),
            reasons(&[("jam", "  ", "unplanned")]),
            reasons(&[("jam", "Jam", "sometimes")]),
        ];
        for value in rejected {
            assert!(validate_reasons(&value).is_err(), "{value:?}");
        }
        assert_eq!(
            validate_reasons(&reasons(&[("tool_wear_2", "Tool wear", "breakdown")])),
            Ok(())
        );
    }
}
