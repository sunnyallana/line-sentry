//! Report routes (mirrors server/routes/reports.js).
//!
//! Data endpoints (generate/list/delete) are ported here. PDF download + email
//! are added on top via `printpdf`/`lettre` (see `reports_pdf`/`reports_email`).
//! Metrics reuse the same OEE/MTTR/MTBF formulas as the analytics engine.

use std::collections::{HashMap, HashSet};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::Response;
use axum::Json;
use bson::{doc, oid::ObjectId, Bson, Document};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use printpdf::{BuiltinFont, Mm, PdfDocument};
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::routes::common::{doc_to_json, docs_to_json};
use crate::state::AppState;

// ── Metric folding ───────────────────────────────────────────────────────────
#[derive(Default, Clone)]
struct Totals {
    units: f64,
    defective: f64,
    running: f64,
    stoppage: f64,
    expected: f64,
    stoppages: i64,
    breakdowns: i64,
    breakdown_min: f64,
}

fn fold(records: &[&ProductionRecord], cap: &HashMap<ObjectId, f64>) -> Totals {
    let mut t = Totals::default();
    for r in records {
        t.units += r.units_produced;
        t.defective += r.defective_units;
        for h in &r.hourly_data {
            t.running += h.running_minutes;
            t.stoppage += h.stoppage_minutes;
            t.stoppages += h.stoppages.len() as i64;
            if let Some(mid) = h.mold_id {
                if let Some(c) = cap.get(&mid.oid()) {
                    if *c > 0.0 {
                        t.expected += (c / 60.0) * h.running_minutes;
                    }
                }
            }
            for s in &h.stoppages {
                if s.reason == "breakdown" {
                    t.breakdowns += 1;
                    t.breakdown_min += s.duration;
                }
            }
        }
    }
    t
}

/// Per-record-set metrics (matches Node `calculateMetricsForRecords`).
fn metrics_doc(t: &Totals, oee_override: Option<i64>) -> Document {
    let total_min = t.running + t.stoppage;
    let availability = if total_min > 0.0 {
        t.running / total_min
    } else {
        0.0
    };
    let quality = if t.units > 0.0 {
        (t.units - t.defective) / t.units
    } else {
        0.0
    };
    let performance = if t.expected > 0.0 {
        t.units / t.expected
    } else {
        0.0
    };
    let oee = oee_override
        .unwrap_or_else(|| ((availability * quality * performance) * 100.0).round() as i64);
    let mtbf = if t.breakdowns > 0 {
        (t.running / t.breakdowns as f64).round() as i64
    } else {
        0
    };
    let mttr = if t.breakdowns > 0 {
        (t.breakdown_min / t.breakdowns as f64).round() as i64
    } else {
        0
    };
    doc! {
        "oee": oee,
        "mtbf": mtbf,
        "mttr": mttr,
        "availability": (availability * 100.0).round() as i64,
        "quality": (quality * 100.0).round() as i64,
        "performance": (performance * 100.0).round() as i64,
        "totalUnitsProduced": t.units,
        "totalDefectiveUnits": t.defective,
        "totalRunningMinutes": t.running,
        "totalStoppageMinutes": t.stoppage,
        "totalStoppages": t.stoppages,
    }
}

fn shift_contains(hour: i64, start: &str, end: &str) -> bool {
    let sh = start
        .split(':')
        .next()
        .and_then(|h| h.parse::<i64>().ok())
        .unwrap_or(0);
    let eh = end
        .split(':')
        .next()
        .and_then(|h| h.parse::<i64>().ok())
        .unwrap_or(0);
    if sh <= eh {
        hour >= sh && hour < eh
    } else {
        hour >= sh || hour < eh
    }
}

// ── Generate ─────────────────────────────────────────────────────────────────
#[derive(serde::Deserialize)]
pub struct GenerateReq {
    #[serde(rename = "type")]
    report_type: String,
    #[serde(rename = "startDate")]
    start_date: String,
    #[serde(rename = "endDate")]
    end_date: String,
    #[serde(rename = "departmentId")]
    department_id: Option<String>,
    #[serde(rename = "machineId")]
    machine_id: Option<String>,
}

pub async fn generate(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(b): Json<GenerateReq>,
) -> AppResult<Json<Value>> {
    let start = DateTime::parse_from_rfc3339(&b.start_date)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| AppError::bad_request("invalid startDate"))?;
    let end = DateTime::parse_from_rfc3339(&b.end_date)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| AppError::bad_request("invalid endDate"))?;
    let dept_oid = b
        .department_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| ObjectId::parse_str(s))
        .transpose()
        .map_err(|_| AppError::bad_request("Invalid department ID"))?;
    let machine_oid = b
        .machine_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| ObjectId::parse_str(s))
        .transpose()
        .map_err(|_| AppError::bad_request("Invalid machine ID"))?;

    // Load production records in range (optionally filtered by machine).
    let mut q = doc! { "startTime": { "$gte": bson::DateTime::from_chrono(start), "$lte": bson::DateTime::from_chrono(end) } };
    if let Some(m) = machine_oid {
        q.insert("machineId", m);
    }
    let mut records: Vec<ProductionRecord> = state
        .db
        .collection::<ProductionRecord>(PRODUCTION_RECORDS)
        .find(q)
        .await?
        .try_collect()
        .await?;

    // Machine → (name, departmentId) for naming + grouping.
    let machine_ids: Vec<ObjectId> = records
        .iter()
        .map(|r| r.machine_id.oid())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let machines: Vec<Machine> = if machine_ids.is_empty() {
        vec![]
    } else {
        state
            .db
            .collection::<Machine>(MACHINES)
            .find(doc! { "_id": { "$in": &machine_ids } })
            .await?
            .try_collect()
            .await?
    };
    let machine_info: HashMap<ObjectId, (String, ObjectId)> = machines
        .iter()
        .filter_map(|m| {
            m.id.map(|id| (id.oid(), (m.name.clone(), m.department_id.oid())))
        })
        .collect();

    // Department filter (keep only records whose machine is in the department).
    if let Some(d) = dept_oid {
        records.retain(|r| {
            machine_info
                .get(&r.machine_id.oid())
                .map(|(_, dep)| *dep == d)
                .unwrap_or(false)
        });
    }

    // Mold capacities.
    let mold_ids: Vec<ObjectId> = records
        .iter()
        .flat_map(|r| {
            r.hourly_data
                .iter()
                .filter_map(|h| h.mold_id.map(|m| m.oid()))
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut cap: HashMap<ObjectId, f64> = HashMap::new();
    if !mold_ids.is_empty() {
        let molds: Vec<Mold> = state
            .db
            .collection::<Mold>(MOLDS)
            .find(doc! { "_id": { "$in": mold_ids } })
            .await?
            .try_collect()
            .await?;
        for m in molds {
            if let Some(id) = m.id {
                cap.insert(id.oid(), m.production_capacity_per_hour);
            }
        }
    }

    // Per-machine metrics.
    let mut by_machine: HashMap<ObjectId, Vec<&ProductionRecord>> = HashMap::new();
    for r in &records {
        by_machine.entry(r.machine_id.oid()).or_default().push(r);
    }
    let mut machine_data = Vec::new();
    let mut machine_oees = Vec::new();
    for (mid, recs) in &by_machine {
        let m = metrics_doc(&fold(recs, &cap), None);
        if let Ok(o) = m.get_i64("oee") {
            machine_oees.push(o);
        }
        machine_data.push(doc! {
            "machineId": mid,
            "machineName": machine_info.get(mid).map(|(n, _)| n.clone()).unwrap_or_default(),
            "metrics": m,
        });
    }
    let avg_oee = if machine_oees.is_empty() {
        0
    } else {
        (machine_oees.iter().sum::<i64>() as f64 / machine_oees.len() as f64).round() as i64
    };

    // Overall metrics (oee = avg of machine oees, per Node).
    let all: Vec<&ProductionRecord> = records.iter().collect();
    let overall = metrics_doc(&fold(&all, &cap), Some(avg_oee));

    // Shift metrics.
    let cfg = state
        .db
        .collection::<Document>(CONFIGS)
        .find_one(doc! {})
        .await?;
    let shifts = cfg
        .and_then(|c| c.get_array("shifts").ok().cloned())
        .unwrap_or_default();
    let mut shift_data = Vec::new();
    for s in &shifts {
        if let Bson::Document(sd) = s {
            let name = sd.get_str("name").unwrap_or("").to_string();
            let start_t = sd.get_str("startTime").unwrap_or("").to_string();
            let end_t = sd.get_str("endTime").unwrap_or("").to_string();
            let (mut units, mut defective, mut running, mut stoppage) = (0.0, 0.0, 0.0, 0.0);
            for r in &records {
                for h in &r.hourly_data {
                    if shift_contains(h.hour as i64, &start_t, &end_t) {
                        units += h.units_produced;
                        defective += h.defective_units;
                        running += h.running_minutes;
                        stoppage += h.stoppage_minutes;
                    }
                }
            }
            shift_data.push(doc! {
                "shiftName": name, "startTime": start_t, "endTime": end_t,
                "metrics": { "oee": avg_oee, "unitsProduced": units, "defectiveUnits": defective, "runningMinutes": running, "stoppageMinutes": stoppage },
            });
        }
    }

    // Department metrics.
    let mut by_dept: HashMap<ObjectId, Vec<&ProductionRecord>> = HashMap::new();
    for r in &records {
        if let Some((_, dep)) = machine_info.get(&r.machine_id.oid()) {
            by_dept.entry(*dep).or_default().push(r);
        }
    }
    let dept_ids: Vec<ObjectId> = by_dept.keys().copied().collect();
    let dept_names: HashMap<ObjectId, String> = if dept_ids.is_empty() {
        HashMap::new()
    } else {
        state
            .db
            .collection::<Department>(DEPARTMENTS)
            .find(doc! { "_id": { "$in": dept_ids } })
            .await?
            .try_collect::<Vec<Department>>()
            .await?
            .into_iter()
            .filter_map(|d| d.id.map(|id| (id.oid(), d.name)))
            .collect()
    };
    let mut department_data = Vec::new();
    for (dep, recs) in &by_dept {
        department_data.push(doc! {
            "departmentId": dep,
            "departmentName": dept_names.get(dep).cloned().unwrap_or_else(|| "Unknown".into()),
            "metrics": metrics_doc(&fold(recs, &cap), None),
        });
    }

    // Build + insert the report.
    let now = bson::DateTime::now();
    let mut report = doc! {
        "type": &b.report_type,
        "period": { "start": bson::DateTime::from_chrono(start), "end": bson::DateTime::from_chrono(end) },
        "metrics": overall,
        "shiftData": shift_data,
        "machineData": machine_data,
        "departmentData": department_data,
        "generatedBy": user.id.map(|i| i.oid()).map(Bson::ObjectId).unwrap_or(Bson::Null),
        "emailSent": false,
        "createdAt": now,
        "updatedAt": now,
    };
    if let Some(d) = dept_oid {
        report.insert("departmentId", d);
    }
    if let Some(m) = machine_oid {
        report.insert("machineId", m);
    }

    let coll = state.db.collection::<Document>(REPORTS);
    let res = coll.insert_one(&report).await?;
    if let Some(id) = res.inserted_id.as_object_id() {
        report.insert("_id", id);
    }
    cleanup_old_reports(&state).await;

    Ok(Json(doc_to_json(report)))
}

async fn cleanup_old_reports(state: &AppState) {
    let coll = state.db.collection::<Document>(REPORTS);
    if let Ok(count) = coll.count_documents(doc! {}).await {
        if count > 10 {
            if let Ok(olds) = coll
                .find(doc! {})
                .sort(doc! { "createdAt": 1 })
                .limit((count - 10) as i64)
                .projection(doc! { "_id": 1 })
                .await
            {
                if let Ok(docs) = olds.try_collect::<Vec<Document>>().await {
                    let ids: Vec<ObjectId> = docs
                        .iter()
                        .filter_map(|d| d.get_object_id("_id").ok())
                        .collect();
                    let _ = coll.delete_many(doc! { "_id": { "$in": ids } }).await;
                }
            }
        }
    }
}

// ── List / delete ────────────────────────────────────────────────────────────
pub async fn list(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let mut m = Document::new();
    if let Some(t) = q.get("type").filter(|s| !s.is_empty()) {
        m.insert("type", t);
    }
    if let Some(d) = q.get("departmentId").filter(|s| !s.is_empty()) {
        if let Ok(oid) = ObjectId::parse_str(d) {
            m.insert("departmentId", oid);
        }
    }
    if let Some(mid) = q.get("machineId").filter(|s| !s.is_empty()) {
        if let Ok(oid) = ObjectId::parse_str(mid) {
            m.insert("machineId", oid);
        }
    }
    let stages = vec![
        doc! { "$match": m },
        doc! { "$lookup": { "from": USERS, "localField": "generatedBy", "foreignField": "_id", "as": "generatedBy", "pipeline": [ { "$project": { "username": 1 } } ] } },
        doc! { "$lookup": { "from": DEPARTMENTS, "localField": "departmentId", "foreignField": "_id", "as": "departmentId" } },
        doc! { "$lookup": { "from": MACHINES, "localField": "machineId", "foreignField": "_id", "as": "machineId" } },
        doc! { "$addFields": {
            "generatedBy": { "$arrayElemAt": ["$generatedBy", 0] },
            "departmentId": { "$arrayElemAt": ["$departmentId", 0] },
            "machineId": { "$arrayElemAt": ["$machineId", 0] },
        }},
        doc! { "$sort": { "createdAt": -1 } },
    ];
    let docs: Vec<Document> = state
        .db
        .collection::<Document>(REPORTS)
        .aggregate(stages)
        .await?
        .try_collect()
        .await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = ObjectId::parse_str(&id).map_err(|_| AppError::bad_request("invalid id"))?;
    let res = state
        .db
        .collection::<Document>(REPORTS)
        .delete_one(doc! { "_id": oid })
        .await?;
    if res.deleted_count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "message": "Report deleted successfully" })))
}

// ── PDF + email ──────────────────────────────────────────────────────────────
fn pdf_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Internal(anyhow::anyhow!("pdf: {e}"))
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn fmt_period(report: &Document, key: &str) -> String {
    report
        .get_document("period")
        .ok()
        .and_then(|p| p.get_datetime(key).ok())
        .map(|d| d.to_chrono().format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn metric_i64(m: Option<&Document>, k: &str) -> i64 {
    m.and_then(|x| {
        x.get_i64(k)
            .ok()
            .or_else(|| x.get_f64(k).ok().map(|f| f as i64))
    })
    .unwrap_or(0)
}

/// Render a clean A4 report PDF (functional equivalent of the pdfkit layout).
fn render_pdf(report: &Document, generated_by: &str) -> AppResult<Vec<u8>> {
    let (doc, page, layer) = PdfDocument::new("LineSentry Report", Mm(210.0), Mm(297.0), "Layer 1");
    let regular = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(pdf_err)?;
    let bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(pdf_err)?;
    let l = doc.get_page(page).get_layer(layer);

    let rtype = report.get_str("type").unwrap_or("report").to_uppercase();
    let metrics = report.get_document("metrics").ok();

    let mut y = 280.0f32;
    l.use_text(
        format!("{rtype} PRODUCTION REPORT"),
        18.0,
        Mm(20.0),
        Mm(y),
        &bold,
    );
    y -= 9.0;
    l.use_text(
        format!(
            "Period: {} to {}",
            fmt_period(report, "start"),
            fmt_period(report, "end")
        ),
        10.0,
        Mm(20.0),
        Mm(y),
        &regular,
    );
    y -= 6.0;
    l.use_text(
        format!("Generated by: {generated_by}"),
        10.0,
        Mm(20.0),
        Mm(y),
        &regular,
    );
    y -= 11.0;

    l.use_text("Key Metrics", 13.0, Mm(20.0), Mm(y), &bold);
    y -= 7.0;
    for (label, val, unit) in [
        ("OEE", metric_i64(metrics, "oee"), "%"),
        ("Availability", metric_i64(metrics, "availability"), "%"),
        ("Quality", metric_i64(metrics, "quality"), "%"),
        ("Performance", metric_i64(metrics, "performance"), "%"),
        ("MTBF", metric_i64(metrics, "mtbf"), " min"),
        ("MTTR", metric_i64(metrics, "mttr"), " min"),
        (
            "Total Units Produced",
            metric_i64(metrics, "totalUnitsProduced"),
            "",
        ),
        (
            "Defective Units",
            metric_i64(metrics, "totalDefectiveUnits"),
            "",
        ),
    ] {
        l.use_text(
            format!("{label}: {val}{unit}"),
            10.0,
            Mm(25.0),
            Mm(y),
            &regular,
        );
        y -= 5.5;
    }
    y -= 4.0;

    if let Ok(machines) = report.get_array("machineData") {
        if !machines.is_empty() {
            l.use_text("Machine Performance", 13.0, Mm(20.0), Mm(y), &bold);
            y -= 7.0;
            l.use_text(
                "Machine            OEE   Avail  Qual  Perf  Units  Defects",
                9.0,
                Mm(20.0),
                Mm(y),
                &bold,
            );
            y -= 5.0;
            for mv in machines.iter().take(30) {
                if let Bson::Document(md) = mv {
                    let name = truncate(md.get_str("machineName").unwrap_or("Unknown"), 17);
                    let mm = md.get_document("metrics").ok();
                    let row = format!(
                        "{:<18} {:<5} {:<6} {:<5} {:<5} {:<6} {}",
                        name,
                        metric_i64(mm, "oee"),
                        metric_i64(mm, "availability"),
                        metric_i64(mm, "quality"),
                        metric_i64(mm, "performance"),
                        metric_i64(mm, "totalUnitsProduced"),
                        metric_i64(mm, "totalDefectiveUnits"),
                    );
                    l.use_text(row, 9.0, Mm(20.0), Mm(y), &regular);
                    y -= 5.0;
                    if y < 20.0 {
                        break;
                    }
                }
            }
        }
    }

    doc.save_to_bytes().map_err(pdf_err)
}

fn email_html(report: &Document, generated_by: &str) -> String {
    let rtype = report.get_str("type").unwrap_or("report").to_uppercase();
    let m = report.get_document("metrics").ok();
    let mut rows = String::new();
    if let Ok(machines) = report.get_array("machineData") {
        for mv in machines {
            if let Bson::Document(md) = mv {
                let mm = md.get_document("metrics").ok();
                rows.push_str(&format!(
                    "<tr><td>{}</td><td>{}%</td><td>{}%</td><td>{}%</td><td>{}%</td><td>{}</td><td>{}</td></tr>",
                    md.get_str("machineName").unwrap_or("Unknown"),
                    metric_i64(mm, "oee"), metric_i64(mm, "availability"), metric_i64(mm, "quality"),
                    metric_i64(mm, "performance"), metric_i64(mm, "totalUnitsProduced"), metric_i64(mm, "totalDefectiveUnits"),
                ));
            }
        }
    }
    format!(
        "<h2>{rtype} Production Report</h2><p><strong>Generated by:</strong> {generated_by}</p>\
         <h3>Key Metrics</h3><ul><li>OEE: {}%</li><li>MTBF: {} min</li><li>MTTR: {} min</li>\
         <li>Total Units: {}</li><li>Defective Units: {}</li></ul>\
         <h3>Machine Performance</h3>\
         <table border=\"1\" cellpadding=\"5\" style=\"border-collapse:collapse\">\
         <tr><th>Machine</th><th>OEE</th><th>Avail</th><th>Qual</th><th>Perf</th><th>Units</th><th>Defects</th></tr>{rows}</table>\
         <p>Please find the detailed PDF report attached.</p>",
        metric_i64(m, "oee"), metric_i64(m, "mtbf"), metric_i64(m, "mttr"),
        metric_i64(m, "totalUnitsProduced"), metric_i64(m, "totalDefectiveUnits"),
    )
}

async fn load_report(state: &AppState, id: &str) -> AppResult<(Document, String)> {
    let oid = ObjectId::parse_str(id).map_err(|_| AppError::bad_request("invalid id"))?;
    let report = state
        .db
        .collection::<Document>(REPORTS)
        .find_one(doc! { "_id": oid })
        .await?
        .ok_or(AppError::NotFound)?;
    let username = match report.get_object_id("generatedBy").ok() {
        Some(uid) => state
            .db
            .collection::<Document>(USERS)
            .find_one(doc! { "_id": uid })
            .await?
            .and_then(|u| u.get_str("username").ok().map(|s| s.to_string()))
            .unwrap_or_default(),
        None => String::new(),
    };
    Ok((report, username))
}

/// Stream the report as a PDF download.
pub async fn reports_pdf(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let (report, username) = load_report(&state, &id).await?;
    let bytes = render_pdf(&report, &username)?;
    let filename = format!(
        "{}-report-{}.pdf",
        report.get_str("type").unwrap_or("report"),
        fmt_period(&report, "start")
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from(bytes))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("response: {e}")))
}

/// Email the report (PDF attachment) to the configured recipients.
pub async fn reports_email(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let (report, username) = load_report(&state, &id).await?;
    let cfg = state
        .db
        .collection::<Document>(CONFIGS)
        .find_one(doc! {})
        .await?;
    let email_cfg = cfg.as_ref().and_then(|c| c.get_document("email").ok());
    let sender = email_cfg
        .and_then(|e| e.get_str("senderEmail").ok())
        .unwrap_or("")
        .to_string();
    let password = email_cfg
        .and_then(|e| e.get_str("senderPassword").ok())
        .unwrap_or("")
        .to_string();
    let recipients: Vec<String> = email_cfg
        .and_then(|e| e.get_array("recipients").ok())
        .map(|a| {
            a.iter()
                .filter_map(|b| b.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if recipients.is_empty() || sender.is_empty() {
        return Err(AppError::bad_request("Email configuration not found"));
    }

    let bytes = render_pdf(&report, &username)?;
    let filename = format!(
        "{}-report-{}.pdf",
        report.get_str("type").unwrap_or("report"),
        fmt_period(&report, "start")
    );
    let subject = format!(
        "{} Production Report - {}",
        report.get_str("type").unwrap_or("report").to_uppercase(),
        fmt_period(&report, "start")
    );

    let attachment = Attachment::new(filename).body(
        bytes,
        ContentType::parse("application/pdf")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("content-type: {e}")))?,
    );
    let mut builder = Message::builder()
        .from(
            sender
                .parse()
                .map_err(|e| AppError::bad_request(format!("invalid sender email: {e}")))?,
        )
        .subject(subject);
    for r in &recipients {
        builder = builder.to(r
            .parse()
            .map_err(|e| AppError::bad_request(format!("invalid recipient: {e}")))?);
    }
    let message = builder
        .multipart(
            MultiPart::mixed()
                .singlepart(SinglePart::html(email_html(&report, &username)))
                .singlepart(attachment),
        )
        .map_err(|e| AppError::Internal(anyhow::anyhow!("email build: {e}")))?;

    let creds = Credentials::new(sender.clone(), password);
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay("smtp.gmail.com")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("smtp: {e}")))?
        .credentials(creds)
        .build();
    mailer
        .send(message)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("send failed: {e}")))?;

    if let Ok(oid) = report.get_object_id("_id") {
        let _ = state
            .db
            .collection::<Document>(REPORTS)
            .update_one(
                doc! { "_id": oid },
                doc! { "$set": { "emailSent": true, "emailSentAt": bson::DateTime::now() } },
            )
            .await;
    }
    Ok(Json(json!({ "message": "Report emailed successfully" })))
}
