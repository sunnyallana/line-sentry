//! Report routes (mirrors server/routes/reports.js).
//!
//! Data endpoints (generate/list/delete) are ported here. PDF download + email
//! are added on top via `printpdf`/`lettre` (see `reports_pdf`/`reports_email`).
//! The figures come from `routes::metrics`, like every other endpoint's.

use std::collections::{HashMap, HashSet};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::Response;
use axum::Json;
use bson::{doc, oid::ObjectId, Bson, Document};
use chrono::{DateTime, Timelike, Utc};
use futures::future::try_join4;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use printpdf::{BuiltinFont, Mm, PdfDocument};
use serde_json::{json, Value};

use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::persist::configs::reason_kinds;
use crate::persist::Filter;
use crate::pulse::Done;
use crate::routes::common::{doc_to_json, docs_to_json, mold_rate, molds_used, names_by_id};
use crate::routes::metrics::{percent, Totals};
use crate::state::AppState;

/// How many reports are kept; older ones are dropped as new ones are stored.
const KEPT_REPORTS: u64 = 10;

// ── Metrics ──────────────────────────────────────────────────────────────────

/// The stored metrics of a set of hours. A report holds 0 where there is no
/// performance or OEE figure. `oee_override` replaces the set's own OEE.
fn metrics_doc(t: &Totals, oee_override: Option<i64>) -> Document {
    doc! {
        "oee": oee_override.unwrap_or_else(|| t.oee().map(percent).unwrap_or(0)),
        "mtbf": t.mtbf_minutes().round() as i64,
        "mttr": t.mttr_minutes().round() as i64,
        "availability": percent(t.availability()),
        "quality": percent(t.quality()),
        "performance": t.performance().map(percent).unwrap_or(0),
        "totalUnitsProduced": t.units,
        "totalDefectiveUnits": t.defective,
        "totalRunningMinutes": t.running_minutes,
        "totalStoppageMinutes": t.stopped_minutes,
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

/// Parse a date that may be RFC3339 or a plain `YYYY-MM-DD`. `end_of_day`
/// pushes a bare date to 23:59:59.999 so a single-day report covers the whole day.
fn parse_report_date(s: &str, end_of_day: bool) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    let d = chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()?;
    let naive = if end_of_day {
        d.and_hms_milli_opt(23, 59, 59, 999)?
    } else {
        d.and_hms_opt(0, 0, 0)?
    };
    Some(naive.and_utc())
}

/// What a report covers.
struct ReportSpec {
    report_type: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    department: Option<ObjectId>,
    machine: Option<ObjectId>,
}

/// Who asked for a report: a signed-in user, or the daily schedule.
enum Requester {
    User(Option<ObjectId>),
    Schedule,
}

pub async fn generate(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(b): Json<GenerateReq>,
) -> AppResult<Json<Value>> {
    let start = parse_report_date(&b.start_date, false)
        .ok_or_else(|| AppError::bad_request("invalid startDate"))?;
    let end = parse_report_date(&b.end_date, true)
        .ok_or_else(|| AppError::bad_request("invalid endDate"))?;
    let department = b
        .department_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(ObjectId::parse_str)
        .transpose()
        .map_err(|_| AppError::bad_request("Invalid department ID"))?;
    let machine = b
        .machine_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(ObjectId::parse_str)
        .transpose()
        .map_err(|_| AppError::bad_request("Invalid machine ID"))?;

    let spec = ReportSpec {
        report_type: b.report_type,
        start,
        end,
        department,
        machine,
    };
    let requester = Requester::User(user.id.map(|i| i.oid()));
    let report = build_report(&state, &spec, requester).await?;
    Ok(Json(doc_to_json(report)))
}

/// Compute a report from the production records, store it and return it.
async fn build_report(
    state: &AppState,
    spec: &ReportSpec,
    requester: Requester,
) -> AppResult<Document> {
    let store = &state.store;
    let (start, end) = (spec.start, spec.end);
    let (dept_oid, machine_oid) = (spec.department, spec.machine);

    let mut records = store
        .records
        .started_between(machine_oid, start, end)
        .await?;

    // Everything else the report needs depends only on the records, so it is
    // read together: one read per collection, however many rows are involved.
    let machine_ids: HashSet<ObjectId> = records.iter().map(|r| r.machine_id.oid()).collect();
    let (machines, molds, shifts, reasons) = try_join4(
        store
            .machines
            .rows
            .find(Filter::all().any_of("_id", machine_ids)),
        molds_used(store, &records),
        store.configs.shift_documents(),
        store.configs.stoppage_reasons(),
    )
    .await?;
    let kinds = reason_kinds(&reasons);

    // Machine → (name, departmentId) for naming + grouping.
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

    // (name, startTime, endTime) of each configured shift, with its totals.
    let mut by_shift: Vec<(String, String, String, Totals)> = shifts
        .unwrap_or_default()
        .iter()
        .filter_map(Bson::as_document)
        .map(|sd| {
            let text = |key: &str| sd.get_str(key).unwrap_or("").to_string();
            (
                text("name"),
                text("startTime"),
                text("endTime"),
                Totals::default(),
            )
        })
        .collect();

    // One pass over the hours fills every cut of the report.
    let mut overall = Totals::default();
    let mut by_machine: HashMap<ObjectId, Totals> = HashMap::new();
    let mut by_dept: HashMap<ObjectId, Totals> = HashMap::new();
    for r in &records {
        let machine = r.machine_id.oid();
        let department = machine_info.get(&machine).map(|(_, dep)| *dep);
        for h in &r.hourly_data {
            let rate = mold_rate(&molds, h);
            overall.add_hour(h, rate, &kinds);
            by_machine
                .entry(machine)
                .or_default()
                .add_hour(h, rate, &kinds);
            if let Some(dep) = department {
                by_dept.entry(dep).or_default().add_hour(h, rate, &kinds);
            }
            for (_, start_t, end_t, totals) in by_shift.iter_mut() {
                if shift_contains(h.hour as i64, start_t, end_t) {
                    totals.add_hour(h, rate, &kinds);
                }
            }
        }
    }

    // Per-machine metrics.
    let mut machine_data = Vec::new();
    let mut machine_oees = Vec::new();
    for (mid, totals) in &by_machine {
        let m = metrics_doc(totals, None);
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
    let overall = metrics_doc(&overall, Some(avg_oee));

    // Shift metrics.
    let shift_data: Vec<Document> = by_shift
        .into_iter()
        .map(|(name, start_t, end_t, t)| {
            doc! {
                "shiftName": name, "startTime": start_t, "endTime": end_t,
                "metrics": { "oee": avg_oee, "unitsProduced": t.units, "defectiveUnits": t.defective, "runningMinutes": t.running_minutes, "stoppageMinutes": t.stopped_minutes },
            }
        })
        .collect();

    // Department metrics.
    let dept_names = names_by_id(
        &store.departments.rows,
        by_dept.keys().copied().collect(),
        "name",
    )
    .await?;
    let mut department_data = Vec::new();
    for (dep, totals) in &by_dept {
        department_data.push(doc! {
            "departmentId": dep,
            "departmentName": dept_names.get(dep).cloned().unwrap_or_else(|| "Unknown".into()),
            "metrics": metrics_doc(totals, None),
        });
    }

    // Build + insert the report.
    let now = bson::DateTime::now();
    let mut report = doc! {
        "type": &spec.report_type,
        "period": { "start": bson::DateTime::from_chrono(start), "end": bson::DateTime::from_chrono(end) },
        "metrics": overall,
        "shiftData": shift_data,
        "machineData": machine_data,
        "departmentData": department_data,
        "generatedBy": match &requester {
            Requester::User(Some(id)) => Bson::ObjectId(*id),
            Requester::User(None) | Requester::Schedule => Bson::Null,
        },
        "scheduled": matches!(requester, Requester::Schedule),
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

    let report = store.reports.store(report).await?;
    cleanup_old_reports(state).await;

    Ok(report)
}

/// Drop all but the newest reports. The report that was just stored is good
/// whether or not this works, so a failure is logged and the next report
/// tries again.
async fn cleanup_old_reports(state: &AppState) {
    if let Err(e) = state.store.reports.keep_newest(KEPT_REPORTS).await {
        tracing::warn!("failed to drop old reports: {e}");
    }
}

// ── List / delete ────────────────────────────────────────────────────────────
pub async fn list(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let text = |key: &str| q.get(key).filter(|s| !s.is_empty());
    // An id that does not parse is ignored rather than refused.
    let oid = |key: &str| text(key).and_then(|s| ObjectId::parse_str(s).ok());
    let docs = state
        .store
        .reports
        .listed(
            text("type").map(String::as_str),
            oid("departmentId"),
            oid("machineId"),
        )
        .await?;
    Ok(Json(docs_to_json(docs)))
}

pub async fn delete(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let oid = ObjectId::parse_str(&id).map_err(|_| AppError::bad_request("invalid id"))?;
    if !state.store.reports.delete(oid).await? {
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
        .store
        .reports
        .get(oid)
        .await?
        .ok_or(AppError::NotFound)?;
    let username = match report.get_object_id("generatedBy").ok() {
        Some(uid) => state
            .store
            .users
            .rows
            .select_one(Filter::id(uid), &["username"])
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

/// Sender and recipients from the configuration document.
struct EmailSettings {
    sender: String,
    password: String,
    recipients: Vec<String>,
}

/// `None` when no sender or no recipient is configured.
async fn email_settings(state: &AppState) -> AppResult<Option<EmailSettings>> {
    let section = state.store.configs.section("email").await?;
    let email_cfg = section.as_ref();
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
        return Ok(None);
    }
    Ok(Some(EmailSettings {
        sender,
        password,
        recipients,
    }))
}

/// Send the report as a PDF attachment and mark it as emailed.
async fn send_report_email(
    state: &AppState,
    report: &Document,
    generated_by: &str,
    settings: EmailSettings,
) -> AppResult<()> {
    let EmailSettings {
        sender,
        password,
        recipients,
    } = settings;

    let bytes = render_pdf(report, generated_by)?;
    let filename = format!(
        "{}-report-{}.pdf",
        report.get_str("type").unwrap_or("report"),
        fmt_period(report, "start")
    );
    let subject = format!(
        "{} Production Report - {}",
        report.get_str("type").unwrap_or("report").to_uppercase(),
        fmt_period(report, "start")
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
                .singlepart(SinglePart::html(email_html(report, generated_by)))
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
        // The email has gone out. Failing now would have the caller send it
        // again, so a mark that could not be written is only logged.
        if let Err(e) = state.store.reports.mark_emailed(oid).await {
            tracing::warn!("report {oid} was emailed but could not be marked as sent: {e}");
        }
    }
    Ok(())
}

/// Email the report (PDF attachment) to the configured recipients.
pub async fn reports_email(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let (report, username) = load_report(&state, &id).await?;
    let settings = email_settings(&state)
        .await?
        .ok_or_else(|| AppError::bad_request("Email configuration not found"))?;
    send_report_email(&state, &report, &username, settings).await?;
    Ok(Json(json!({ "message": "Report emailed successfully" })))
}

// ── Daily schedule ───────────────────────────────────────────────────────────
const SCHEDULE_AUTHOR: &str = "System";

/// The `reportSchedule` section of the configuration document.
struct ReportSchedule {
    /// Factory-local hour (0-23) from which yesterday's report is due.
    hour: u32,
    email: bool,
}

impl ReportSchedule {
    /// `None` when the section is missing or switched off.
    async fn load(state: &AppState) -> AppResult<Option<Self>> {
        let Some(section) = state.store.configs.section("reportSchedule").await? else {
            return Ok(None);
        };
        if !section.get_bool("enabled").unwrap_or(false) {
            return Ok(None);
        }
        let hour = match section.get("hour") {
            Some(Bson::Int32(h)) => *h as i64,
            Some(Bson::Int64(h)) => *h,
            Some(Bson::Double(h)) => *h as i64,
            _ => 6,
        };
        Ok(Some(Self {
            hour: hour.clamp(0, 23) as u32,
            email: section.get_bool("email").unwrap_or(true),
        }))
    }
}

/// One round of the daily-report job. Once the factory clock passes the
/// configured hour it stores yesterday's report and emails it. `sent_through`
/// is the last day already handled (`YYYY-MM-DD`); the returned cursor moves it
/// forward only when the whole round worked, so a failed email is retried on
/// the next round with the report that is already stored.
pub async fn run_daily_schedule(
    state: &AppState,
    sent_through: Option<String>,
    factory_now: DateTime<Utc>,
) -> AppResult<Done> {
    let Some(schedule) = ReportSchedule::load(state).await? else {
        return Ok(Done::new("schedule is off"));
    };
    if factory_now.hour() < schedule.hour {
        return Ok(Done::new("not due yet"));
    }
    let Some(day) = factory_now.date_naive().pred_opt() else {
        return Ok(Done::new("not due yet"));
    };
    let label = day.format("%Y-%m-%d").to_string();
    if sent_through.as_deref() >= Some(label.as_str()) {
        return Ok(Done::new(format!("{label} already done")));
    }

    let (Some(start), Some(end)) = (
        parse_report_date(&label, false),
        parse_report_date(&label, true),
    ) else {
        return Err(AppError::Internal(anyhow::anyhow!(
            "bad report day {label}"
        )));
    };

    let stored = state.store.reports.scheduled_daily(start).await?;
    let report = match stored {
        Some(report) => report,
        None => {
            let spec = ReportSpec {
                report_type: "daily".to_string(),
                start,
                end,
                department: None,
                machine: None,
            };
            build_report(state, &spec, Requester::Schedule).await?
        }
    };

    let already_emailed = report.get_bool("emailSent").unwrap_or(false);
    let mut detail = format!("daily report for {label} stored");
    if schedule.email && !already_emailed {
        match email_settings(state).await? {
            Some(settings) => {
                send_report_email(state, &report, SCHEDULE_AUTHOR, settings).await?;
                detail.push_str(" and emailed");
            }
            None => detail.push_str("; not emailed, no sender or recipients configured"),
        }
    }
    Ok(Done::new(detail).with_cursor(label))
}
