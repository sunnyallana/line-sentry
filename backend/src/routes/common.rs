//! Shared helpers for the CRUD/aggregation routes: query parsing, pagination
//! metadata, safe search regex, and a BSON→clean-JSON converter.

use std::collections::HashMap;

use bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

pub fn q_str(q: &HashMap<String, String>, key: &str) -> String {
    q.get(key).cloned().unwrap_or_default()
}

pub fn q_int(q: &HashMap<String, String>, key: &str, default: i64) -> i64 {
    q.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn parse_oid(s: &str) -> AppResult<ObjectId> {
    ObjectId::parse_str(s).map_err(|_| AppError::bad_request("invalid id"))
}

/// Escape regex metacharacters so user search input is matched literally.
pub fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if r".*+?^${}()|[]\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Build a safe `{ $regex, $options: "i" }` doc, or `None` for empty input.
pub fn search_regex(s: &str) -> Option<Document> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let capped: String = t.chars().take(100).collect();
    Some(doc! { "$regex": escape_regex(&capped), "$options": "i" })
}

/// `{ <sortBy>: 1|-1 }` for an aggregation `$sort` (defaults to createdAt desc).
pub fn sort_doc(sort_by: &str, sort_order: &str) -> Document {
    let order: i32 = if sort_order == "asc" { 1 } else { -1 };
    let key = if sort_by.is_empty() {
        "createdAt"
    } else {
        sort_by
    };
    let mut d = Document::new();
    d.insert(key, order);
    d
}

/// Pagination metadata matching the Node response shape. `total_key` is the
/// domain-specific count field, e.g. "totalUsers".
pub fn pagination(page: i64, limit: i64, total: i64, total_key: &str) -> Value {
    let total_pages = if limit > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        0
    };
    let has_next = page < total_pages;
    let has_prev = page > 1;

    let mut m = Map::new();
    m.insert("currentPage".into(), json!(page));
    m.insert("totalPages".into(), json!(total_pages));
    m.insert(total_key.to_string(), json!(total));
    m.insert("limit".into(), json!(limit));
    m.insert("hasNextPage".into(), json!(has_next));
    m.insert("hasPrevPage".into(), json!(has_prev));
    m.insert(
        "nextPage".into(),
        if has_next {
            json!(page + 1)
        } else {
            Value::Null
        },
    );
    m.insert(
        "prevPage".into(),
        if has_prev {
            json!(page - 1)
        } else {
            Value::Null
        },
    );
    Value::Object(m)
}

/// Convert BSON to frontend-friendly JSON: ObjectId→hex string, DateTime→ISO
/// string (with `Z`), numbers→JSON numbers. Avoids MongoDB extended JSON like
/// `{"$oid": ...}` that the frontend can't consume.
pub fn bson_to_json(b: Bson) -> Value {
    match b {
        Bson::ObjectId(o) => Value::String(o.to_hex()),
        Bson::DateTime(d) => Value::String(
            d.to_chrono()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ),
        Bson::Double(f) => json!(f),
        Bson::Int32(i) => json!(i),
        Bson::Int64(i) => json!(i),
        Bson::Boolean(v) => json!(v),
        Bson::String(s) => Value::String(s),
        Bson::Null => Value::Null,
        Bson::Array(a) => Value::Array(a.into_iter().map(bson_to_json).collect()),
        Bson::Document(d) => doc_to_json(d),
        // Decimal128, Binary, RegEx, etc. — fall back to relaxed extended JSON.
        other => other.into_relaxed_extjson(),
    }
}

pub fn doc_to_json(d: Document) -> Value {
    Value::Object(d.into_iter().map(|(k, v)| (k, bson_to_json(v))).collect())
}

/// Convert a list of aggregation documents to a JSON array.
pub fn docs_to_json(docs: Vec<Document>) -> Value {
    Value::Array(docs.into_iter().map(doc_to_json).collect())
}
