//! Outgoing email. One place that knows how to reach the mail server, used by
//! report emails and alerts alike.

use std::time::Duration;

use bson::Document;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

const DEFAULT_SMTP_HOST: &str = "smtp.gmail.com";
/// A mail server that does not answer must not hold a background job, or a
/// request, for a minute.
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

/// The `email` section of the configuration.
#[derive(Clone)]
pub struct Mailbox {
    pub sender: String,
    pub password: String,
    pub host: String,
    /// The default recipients.
    pub recipients: Vec<String>,
}

impl Mailbox {
    /// `None` when no sender is configured.
    pub fn from_section(section: Option<&Document>) -> Option<Self> {
        let section = section?;
        let text = |key: &str| section.get_str(key).unwrap_or("").trim().to_string();
        let sender = text("senderEmail");
        if sender.is_empty() {
            return None;
        }
        let host = text("smtpHost");
        Some(Self {
            sender,
            password: text("senderPassword"),
            host: if host.is_empty() {
                DEFAULT_SMTP_HOST.to_string()
            } else {
                host
            },
            recipients: addresses(section.get_array("recipients").ok()),
        })
    }
}

/// The non-empty strings of a configured address list.
pub fn addresses(list: Option<&Vec<bson::Bson>>) -> Vec<String> {
    list.map(|a| {
        a.iter()
            .filter_map(|b| b.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

pub struct File {
    pub name: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

/// Send one HTML email, optionally with a file attached. The error text is
/// safe to store and show to an administrator; it never contains the password.
pub async fn send(
    mailbox: &Mailbox,
    to: &[String],
    subject: &str,
    html: String,
    file: Option<File>,
) -> Result<(), String> {
    if to.is_empty() {
        return Err("no recipients".to_string());
    }
    let mut builder = Message::builder()
        .from(
            mailbox
                .sender
                .parse()
                .map_err(|e| format!("invalid sender address: {e}"))?,
        )
        .subject(subject);
    for address in to {
        builder = builder.to(address
            .parse()
            .map_err(|e| format!("invalid recipient {address}: {e}"))?);
    }
    let body = SinglePart::html(html);
    let message = match file {
        Some(f) => {
            let content_type =
                ContentType::parse(f.content_type).map_err(|e| format!("content type: {e}"))?;
            builder.multipart(
                MultiPart::mixed()
                    .singlepart(body)
                    .singlepart(Attachment::new(f.name).body(f.bytes, content_type)),
            )
        }
        None => builder.singlepart(body),
    }
    .map_err(|e| format!("could not build the message: {e}"))?;

    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay(&mailbox.host)
        .map_err(|e| format!("mail server {}: {e}", mailbox.host))?
        .credentials(Credentials::new(
            mailbox.sender.clone(),
            mailbox.password.clone(),
        ))
        .timeout(Some(SEND_TIMEOUT))
        .build();
    match tokio::time::timeout(SEND_TIMEOUT, mailer.send(message)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("mail server refused the message: {e}")),
        Err(_) => Err(format!(
            "mail server {} did not answer within {} s",
            mailbox.host,
            SEND_TIMEOUT.as_secs()
        )),
    }
}
