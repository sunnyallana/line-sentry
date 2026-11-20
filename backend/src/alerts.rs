//! Alerts: tell people when a machine has been stopped for too long, and tell
//! more people if it stays stopped.
//!
//! A background job (leased, so one instance does it) looks at every stoppage
//! that is still open on a machine that is still stopped. Past the first
//! threshold it raises a level-1 alert; past the second, a level-2 alert to the
//! escalation recipients. Each alert has a unique key, so it is raised and sent
//! once: the row is inserted first, and only the caller whose insert succeeded
//! delivers it.
//!
//! Delivery goes through channels. A channel is anything that can carry an
//! alert out of the system; adding one (SMS, a chat app) means adding a variant
//! here, and nothing else changes. Email uses the configured mailbox. The
//! webhook posts JSON with a `text` field, which chat tools that accept
//! incoming webhooks display as is. One channel failing does not stop the
//! others, and every outcome is stored on the alert.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::Json;
use bson::{doc, oid::ObjectId, Bson, Document};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::mail::{self, Mailbox};
use crate::persist::alerts::Delivery;
use crate::persist::configs::number;
use crate::persist::machines::STOPPED;
use crate::persist::records::NO_REASON;
use crate::persist::Filter;
use crate::pulse::Done;
use crate::realtime;
use crate::routes::common::docs_to_json;
use crate::state::AppState;

const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);

/// The `alerts` section of the configuration.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// Minutes a machine may stay stopped before the first alert.
    pub after_minutes: i64,
    /// Minutes before the alert goes to the escalation recipients too. Zero
    /// switches escalation off.
    pub escalate_minutes: i64,
    pub recipients: Vec<String>,
    pub escalation_recipients: Vec<String>,
    pub webhook_url: Option<String>,
}

impl Settings {
    /// `None` when alerts are switched off or the section is missing.
    pub fn from_section(section: Option<&Document>) -> Option<Self> {
        let section = section?;
        if !section.get_bool("enabled").unwrap_or(false) {
            return None;
        }
        let minutes = |key: &str, default: i64| {
            number(section.get(key))
                .map(|m| m as i64)
                .filter(|m| *m >= 0)
                .unwrap_or(default)
        };
        let webhook = section.get_str("webhookUrl").unwrap_or("").trim();
        Some(Self {
            after_minutes: minutes("stoppageMinutes", 10).max(1),
            escalate_minutes: minutes("escalateMinutes", 30),
            recipients: mail::addresses(section.get_array("recipients").ok()),
            escalation_recipients: mail::addresses(section.get_array("escalationRecipients").ok()),
            webhook_url: (!webhook.is_empty()).then(|| webhook.to_string()),
        })
    }

    /// The levels a stoppage of this age has reached, lowest first.
    pub fn levels_due(&self, stopped_minutes: i64) -> Vec<u8> {
        let mut levels = Vec::new();
        if stopped_minutes >= self.after_minutes {
            levels.push(1);
        }
        if self.escalate_minutes > self.after_minutes && stopped_minutes >= self.escalate_minutes {
            levels.push(2);
        }
        levels
    }
}

/// One thing to tell people.
struct Alert {
    key: String,
    level: u8,
    title: String,
    message: String,
    machine_id: ObjectId,
    machine_name: String,
    department_id: Option<ObjectId>,
    department_name: Option<String>,
    stopped_minutes: i64,
}

impl Alert {
    fn row(&self) -> Document {
        doc! {
            "key": &self.key,
            "kind": "stoppage",
            "level": self.level as i32,
            "title": &self.title,
            "message": &self.message,
            "machineId": self.machine_id,
            "machineName": &self.machine_name,
            "departmentId": self.department_id.map(Bson::ObjectId).unwrap_or(Bson::Null),
            "departmentName": self.department_name.clone().map(Bson::String).unwrap_or(Bson::Null),
            "stoppedMinutes": self.stopped_minutes,
            "at": bson::DateTime::now(),
            "deliveries": Bson::Array(Vec::new()),
        }
    }

    fn json(&self) -> Value {
        json!({
            "text": format!("{}: {}", self.title, self.message),
            "title": self.title,
            "message": self.message,
            "level": self.level,
            "kind": "stoppage",
            "machineId": self.machine_id.to_hex(),
            "machine": self.machine_name,
            "department": self.department_name,
            "stoppedMinutes": self.stopped_minutes,
        })
    }
}

/// A way out of the system for an alert.
enum Channel {
    Email { mailbox: Mailbox, to: Vec<String> },
    Webhook { url: String },
}

impl Channel {
    fn name(&self) -> &'static str {
        match self {
            Channel::Email { .. } => "email",
            Channel::Webhook { .. } => "webhook",
        }
    }

    async fn deliver(&self, http: &reqwest::Client, alert: &Alert) -> Result<(), String> {
        match self {
            Channel::Email { mailbox, to } => {
                let html = format!(
                    "<p style=\"font:14px/1.5 system-ui,sans-serif\"><strong>{}</strong><br>{}</p>",
                    escape(&alert.title),
                    escape(&alert.message)
                );
                mail::send(mailbox, to, &alert.title, html, None).await
            }
            Channel::Webhook { url } => {
                let sent = http
                    .post(url)
                    .timeout(WEBHOOK_TIMEOUT)
                    .json(&alert.json())
                    .send()
                    .await
                    .map_err(|e| format!("could not reach the webhook: {}", e.without_url()))?;
                if sent.status().is_success() {
                    Ok(())
                } else {
                    Err(format!("the webhook answered {}", sent.status()))
                }
            }
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The channels an alert of this level goes out on.
fn channels_for(level: u8, settings: &Settings, mailbox: Option<&Mailbox>) -> Vec<Channel> {
    let mut channels = Vec::new();
    if let Some(mailbox) = mailbox {
        let first_line = if settings.recipients.is_empty() {
            &mailbox.recipients
        } else {
            &settings.recipients
        };
        let to = if level >= 2 && !settings.escalation_recipients.is_empty() {
            // Escalation adds people; the first line still hears about it.
            let mut all = first_line.clone();
            for address in &settings.escalation_recipients {
                if !all.contains(address) {
                    all.push(address.clone());
                }
            }
            all
        } else {
            first_line.clone()
        };
        if !to.is_empty() {
            channels.push(Channel::Email {
                mailbox: mailbox.clone(),
                to,
            });
        }
    }
    if let Some(url) = &settings.webhook_url {
        channels.push(Channel::Webhook { url: url.clone() });
    }
    channels
}

/// One round of the alerts job. `factory_now` is factory-local, like the
/// stoppage start times.
pub async fn run(state: &AppState, factory_now: DateTime<Utc>) -> AppResult<Done> {
    let store = &state.store;
    let (alert_section, email_section) = futures::future::try_join(
        store.configs.section("alerts"),
        store.configs.section("email"),
    )
    .await?;
    let Some(settings) = Settings::from_section(alert_section.as_ref()) else {
        return Ok(Done::new("alerts are off"));
    };
    let mailbox = Mailbox::from_section(email_section.as_ref());

    let open = store
        .records
        .with_open_stoppages(factory_now.date_naive())
        .await?;
    if open.is_empty() {
        return Ok(Done::new("no machine is stopped"));
    }
    let machine_ids: Vec<ObjectId> = open.iter().map(|r| r.machine_id.oid()).collect();
    let stopped = store.machines.with_status(&machine_ids, STOPPED).await?;

    // Work out what is due before reading names, so a quiet round stays cheap.
    let mut due: Vec<(ObjectId, ObjectId, i64, u8)> = Vec::new();
    for rec in open
        .iter()
        .filter(|r| stopped.contains(&r.machine_id.oid()))
    {
        for stoppage in rec
            .hourly_data
            .iter()
            .flat_map(|h| h.stoppages.iter())
            .filter(|s| s.reason == NO_REASON && s.is_pending)
        {
            let (Some(id), Some(started)) = (stoppage.id, stoppage.start_time) else {
                continue;
            };
            let minutes = (factory_now - started).num_minutes();
            for level in settings.levels_due(minutes) {
                due.push((rec.machine_id.oid(), id.oid(), minutes, level));
            }
        }
    }
    if due.is_empty() {
        return Ok(Done::new("nothing has been stopped long enough"));
    }

    let names = machine_names(state, due.iter().map(|d| d.0)).await?;
    let mut raised = 0;
    let mut failed_deliveries = 0;
    for (machine_id, stoppage_id, minutes, level) in due {
        let (machine_name, department_id, department_name) = names
            .get(&machine_id)
            .cloned()
            .unwrap_or_else(|| ("A machine".to_string(), None, None));
        let alert = Alert {
            key: format!("stoppage:{}:{level}", stoppage_id.to_hex()),
            level,
            title: if level >= 2 {
                format!("{machine_name} is still stopped")
            } else {
                format!("{machine_name} has stopped")
            },
            message: format!(
                "Stopped for {minutes} min{} with no reason recorded.",
                department_name
                    .as_deref()
                    .map(|d| format!(" in {d}"))
                    .unwrap_or_default()
            ),
            machine_id,
            machine_name,
            department_id,
            department_name,
            stopped_minutes: minutes,
        };

        // Whoever inserts the row delivers it; everyone else moves on.
        let Some(id) = store.alerts.claim(alert.row()).await? else {
            continue;
        };
        raised += 1;

        let mut deliveries = Vec::new();
        for channel in channels_for(level, &settings, mailbox.as_ref()) {
            let error = channel.deliver(&state.http, &alert).await.err();
            if let Some(e) = &error {
                failed_deliveries += 1;
                tracing::warn!(channel = channel.name(), alert = %alert.key, "alert not delivered: {e}");
            }
            deliveries.push(Delivery {
                channel: channel.name(),
                error,
            });
        }
        store.alerts.record_deliveries(id, &deliveries).await?;
        realtime::broadcast(&state.io, "alert", &alert.json()).await;
    }

    Ok(Done::new(match (raised, failed_deliveries) {
        (0, _) => "no new alerts".to_string(),
        (n, 0) => format!("{n} alert(s) raised"),
        (n, f) => format!("{n} alert(s) raised, {f} delivery failure(s)"),
    }))
}

type Named = (String, Option<ObjectId>, Option<String>);

/// Machine name, department id and department name for each id, in two reads.
async fn machine_names(
    state: &AppState,
    ids: impl Iterator<Item = ObjectId>,
) -> AppResult<HashMap<ObjectId, Named>> {
    let ids: Vec<ObjectId> = ids.collect();
    let machines = state
        .store
        .machines
        .rows
        .select(Filter::all().any_of("_id", ids), &["name", "departmentId"])
        .await?;
    let department_ids: Vec<ObjectId> = machines
        .iter()
        .filter_map(|m| m.get_object_id("departmentId").ok())
        .collect();
    let departments: HashMap<ObjectId, String> = state
        .store
        .departments
        .rows
        .select(Filter::all().any_of("_id", department_ids), &["name"])
        .await?
        .iter()
        .filter_map(|d| {
            Some((
                d.get_object_id("_id").ok()?,
                d.get_str("name").ok()?.to_string(),
            ))
        })
        .collect();
    Ok(machines
        .iter()
        .filter_map(|m| {
            let department = m.get_object_id("departmentId").ok();
            Some((
                m.get_object_id("_id").ok()?,
                (
                    m.get_str("name").unwrap_or("A machine").to_string(),
                    department,
                    department.and_then(|d| departments.get(&d).cloned()),
                ),
            ))
        })
        .collect())
}

/// `GET /api/alerts?limit=`: the newest alerts. Operators see their own
/// department's.
pub async fn recent(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let department = if user.role == "operator" {
        Some(
            user.department_id
                .map(|d| d.oid())
                .ok_or(AppError::Forbidden)?,
        )
    } else {
        None
    };
    let limit = q
        .get("limit")
        .and_then(|l| l.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let rows = state.store.alerts.recent(department, limit).await?;
    Ok(Json(docs_to_json(rows)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(after: i64, escalate: i64) -> Settings {
        Settings {
            after_minutes: after,
            escalate_minutes: escalate,
            recipients: vec![],
            escalation_recipients: vec![],
            webhook_url: None,
        }
    }

    #[test]
    fn levels_follow_the_two_thresholds() {
        let s = settings(10, 30);
        assert!(s.levels_due(9).is_empty());
        assert_eq!(s.levels_due(10), vec![1]);
        assert_eq!(s.levels_due(29), vec![1]);
        assert_eq!(s.levels_due(30), vec![1, 2]);
    }

    #[test]
    fn escalation_is_off_when_it_would_not_come_after_the_first_alert() {
        assert_eq!(settings(10, 0).levels_due(500), vec![1]);
        assert_eq!(settings(10, 10).levels_due(500), vec![1]);
    }

    #[test]
    fn settings_are_read_only_when_switched_on() {
        assert!(Settings::from_section(None).is_none());
        assert!(Settings::from_section(Some(&doc! { "enabled": false })).is_none());
        let s = Settings::from_section(Some(&doc! {
            "enabled": true, "stoppageMinutes": 5, "escalateMinutes": 20.0,
            "recipients": ["a@x.io", " "], "webhookUrl": "  ",
        }))
        .unwrap();
        assert_eq!(s.after_minutes, 5);
        assert_eq!(s.escalate_minutes, 20);
        assert_eq!(s.recipients, vec!["a@x.io".to_string()]);
        assert_eq!(s.webhook_url, None);
    }

    #[test]
    fn escalation_adds_people_to_the_first_line() {
        let mailbox = Mailbox {
            sender: "s@x.io".into(),
            password: String::new(),
            host: "h".into(),
            recipients: vec!["default@x.io".into()],
        };
        let mut s = settings(10, 30);
        let to = |level, s: &Settings| match channels_for(level, s, Some(&mailbox)).first() {
            Some(Channel::Email { to, .. }) => to.clone(),
            _ => vec![],
        };
        assert_eq!(
            to(1, &s),
            vec!["default@x.io"],
            "falls back to the mailbox's recipients"
        );
        s.recipients = vec!["lead@x.io".into()];
        s.escalation_recipients = vec!["manager@x.io".into(), "lead@x.io".into()];
        assert_eq!(to(1, &s), vec!["lead@x.io"]);
        assert_eq!(to(2, &s), vec!["lead@x.io", "manager@x.io"]);
        assert!(
            channels_for(1, &s, None).is_empty(),
            "no mailbox and no webhook means no channel"
        );
    }
}
