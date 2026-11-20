//! Signal-ingestion pipeline — the heart of LineSentry.
//!
//! A daemon posts its PLC's output bytes; each bit is a pin, each mapped pin is
//! a `power` or `unit-cycle` sensor on a machine. From those two signals the
//! pipeline keeps a four-state machine status, hourly production records, and
//! automatically detected stoppages.
//!
//! Everything that decides an outcome lives in the database, not in this
//! process:
//!
//!   * a machine's last power pulse, last cycle pulse and last counted running
//!     minute are fields on its row;
//!   * every write to a production record is one atomic update guarded by its
//!     own condition, never read-modify-write;
//!   * a retried payload is recognised through a short-lived receipt.
//!
//! So a restart loses nothing, any number of backend instances can take
//! payloads for the same PLC, and two payloads landing together cannot
//! overwrite each other's counts. What stays in memory is only caches and
//! write throttles, each safe to lose.
//!
//! Cost of one payload, however many machines the PLC carries: one read of the
//! machines' live state, one receipt insert, two batched writes (the machines'
//! marks, then production records), and one read of the hour buckets that
//! changed, for the realtime events. Sensor readings and power marks cost the
//! request nothing: a bulk entity writer stores them in the background. Rare transitions (a stoppage opening or
//! closing, the first unit of an hour) add their own writes.

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use bson::oid::ObjectId;
use chrono::{DateTime, Timelike, Utc};
use dashmap::DashMap;
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::persist::machines::{LiveState, IDLE, PRODUCING_UNPOWERED, RUNNING, STOPPED};
use crate::persist::records::NO_REASON;
use crate::persist::sensors::{POWER, UNIT_CYCLE};
use crate::persist::Reading;
use crate::realtime;
use crate::state::AppState;

const PIN_CACHE_TTL: Duration = Duration::from_secs(10);
const TIMEOUT_CACHE_TTL: Duration = Duration::from_secs(10);
const DEDUP_TTL: Duration = Duration::from_secs(30);
/// A posting PLC's `lastSeenAt` is written at most this often.
const PLC_SEEN_WRITE_EVERY: Duration = Duration::from_secs(10);
/// A machine's last-power mark is written at most this often while power stays
/// on. The power timeout is minutes, so a few seconds of slack changes nothing.
const POWER_WRITE_EVERY: Duration = Duration::from_secs(5);
/// An unchanged signal value is rewritten at most this often.
const SIGNAL_WRITE_EVERY: Duration = Duration::from_secs(10);

/// Upper edges, in seconds, of the cycle-time histogram kept per hour. A gap
/// longer than the last edge is a stoppage, not a slow cycle, and is not
/// counted here.
pub const CYCLE_BUCKET_EDGES: [f64; 12] = [
    1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0, 55.0, 90.0, 150.0, 300.0,
];

/// Index of the histogram bucket a gap between two units falls in.
pub fn cycle_bucket(seconds: f64) -> Option<usize> {
    if seconds <= 0.0 {
        return None;
    }
    CYCLE_BUCKET_EDGES.iter().position(|edge| seconds <= *edge)
}

/// One resolved pin → its sensor and machine.
#[derive(Clone)]
pub struct PinInfo {
    pub sensor_id: Id,
    pub sensor_type: String,
    pub machine_id: Id,
}

type PinMap = HashMap<String, PinInfo>;

/// Caches and write throttles. Nothing here decides an outcome; see the module
/// comment.
pub struct PipelineState {
    recent_payloads: DashMap<String, Instant>,
    plc_seen_written: DashMap<String, Instant>,
    power_written: DashMap<Id, Instant>,
    signal_written: DashMap<Id, (u8, Instant)>,
    pin_cache: RwLock<Option<(Instant, std::sync::Arc<PinMap>)>>,
    timeout_cache: RwLock<Option<(Instant, (chrono::Duration, chrono::Duration))>>,
    writer_full_warned: DashMap<&'static str, Instant>,
}

impl PipelineState {
    pub fn new() -> Self {
        Self {
            recent_payloads: DashMap::new(),
            plc_seen_written: DashMap::new(),
            power_written: DashMap::new(),
            signal_written: DashMap::new(),
            pin_cache: RwLock::new(None),
            timeout_cache: RwLock::new(None),
            writer_full_warned: DashMap::new(),
        }
    }

    /// A bulk writer refused a row. Said at most once a minute per writer.
    fn warn_writer_full(&self, writer: &'static str) {
        if Self::due(&self.writer_full_warned, &writer, Duration::from_secs(60)) {
            tracing::warn!(
                writer,
                "bulk writer buffer is full; rows are being retried by later payloads"
            );
        }
    }

    /// True if this exact payload was seen by this instance within the window.
    /// The cheap first check; the receipts cover the other instances.
    fn seen_here(&self, key: &str) -> bool {
        let now = Instant::now();
        if self.recent_payloads.len() > 5000 {
            self.recent_payloads.retain(|_, exp| *exp > now);
        }
        let fresh = self
            .recent_payloads
            .get(key)
            .map(|exp| *exp.value() > now)
            .unwrap_or(false);
        if !fresh {
            self.recent_payloads
                .insert(key.to_string(), now + DEDUP_TTL);
        }
        fresh
    }

    /// True when `key` has not been marked within `every`; marks it if so.
    fn due<K: std::hash::Hash + Eq + Clone>(
        map: &DashMap<K, Instant>,
        key: &K,
        every: Duration,
    ) -> bool {
        let now = Instant::now();
        let due = map
            .get(key)
            .map(|at| now.duration_since(*at.value()) >= every)
            .unwrap_or(true);
        if due {
            map.insert(key.clone(), now);
        }
        due
    }

    fn signal_write_due(&self, sensor: Id, value: u8) -> bool {
        let now = Instant::now();
        let due = self
            .signal_written
            .get(&sensor)
            .map(|e| {
                let (last, at) = *e.value();
                last != value || now.duration_since(at) >= SIGNAL_WRITE_EVERY
            })
            .unwrap_or(true);
        if due {
            self.signal_written.insert(sensor, (value, now));
        }
        due
    }

    /// Drop the cached pin mappings so the next signal reloads them. Call after
    /// wiring or removing a signal so it takes effect immediately.
    pub fn invalidate_pin_cache(&self) {
        *self.pin_cache.write().unwrap() = None;
    }
}

impl Default for PipelineState {
    fn default() -> Self {
        Self::new()
    }
}

/// Pin → {sensor, machine}, keyed "{plcId}|{pinId}" so the same pin address on
/// different PLCs resolves to different machines. Shared, not copied, between
/// payloads.
async fn pin_map(state: &AppState) -> AppResult<std::sync::Arc<PinMap>> {
    if let Some((at, map)) = state.pipeline.pin_cache.read().unwrap().as_ref() {
        if at.elapsed() < PIN_CACHE_TTL {
            return Ok(map.clone());
        }
    }
    let (mappings, sensors) =
        futures::future::try_join(state.store.pins.all(), state.store.sensors.all()).await?;
    let sensor_by_id: HashMap<Id, &Sensor> = sensors
        .iter()
        .filter_map(|s| s.id.map(|id| (id, s)))
        .collect();
    let map: PinMap = mappings
        .iter()
        .filter_map(|m| {
            let s = sensor_by_id.get(&m.sensor_id)?;
            Some((
                format!("{}|{}", m.plc_id, m.pin_id),
                PinInfo {
                    sensor_id: m.sensor_id,
                    sensor_type: s.sensor_type.clone(),
                    machine_id: s.machine_id,
                },
            ))
        })
        .collect();
    let map = std::sync::Arc::new(map);
    *state.pipeline.pin_cache.write().unwrap() = Some((Instant::now(), map.clone()));
    Ok(map)
}

async fn signal_timeouts(state: &AppState) -> (chrono::Duration, chrono::Duration) {
    if let Some((at, v)) = state.pipeline.timeout_cache.read().unwrap().as_ref() {
        if at.elapsed() < TIMEOUT_CACHE_TTL {
            return *v;
        }
    }
    let (power_min, cycle_min) = match state.store.configs.signal_timeouts().await {
        Ok(minutes) => minutes,
        Err(e) => {
            tracing::warn!("could not read signal timeouts, using the defaults: {e}");
            (5.0, 2.0)
        }
    };
    let v = (
        chrono::Duration::milliseconds((power_min * 60_000.0) as i64),
        chrono::Duration::milliseconds((cycle_min * 60_000.0) as i64),
    );
    *state.pipeline.timeout_cache.write().unwrap() = Some((Instant::now(), v));
    v
}

// ── Time helpers ─────────────────────────────────────────────────────────────
fn parse_timestamp(ts: Option<&str>) -> DateTime<Utc> {
    match ts {
        Some(s) if !s.is_empty() => DateTime::parse_from_rfc3339(s)
            .map(|d| d.with_timezone(&Utc))
            .or_else(|_| {
                chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
                    .map(|n| n.and_utc())
            })
            .unwrap_or_else(|_| Utc::now()),
        _ => Utc::now(),
    }
}

fn date_str(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%d").to_string()
}

/// Decode a hex string of whole bytes (even length) into bytes; `None` if malformed.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.is_empty() || !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

// ── Pipeline entry point ─────────────────────────────────────────────────────

/// What one payload means for one machine, worked out before anything is
/// written so the writes can go out together.
struct Step<'a> {
    machine: Id,
    was: &'a LiveState,
    cycles: u32,
    status: &'static str,
    color: &'static str,
    has_power: bool,
    has_cycle: bool,
    /// Position in the first batch of the running-minute claim, if one was made.
    minute_claim: Option<usize>,
}

fn state_of(has_power: bool, has_cycle: bool) -> (&'static str, &'static str) {
    match (has_power, has_cycle) {
        (true, true) => (RUNNING, "green"),
        (true, false) => (STOPPED, "red"),
        (false, true) => (PRODUCING_UNPOWERED, "orange"),
        (false, false) => (IDLE, "gray"),
    }
}

/// Process one pin-data payload. Returns the machine ids that recorded a unit.
pub async fn process_pin_data(
    state: &AppState,
    plc_id: &str,
    pin_data: &str,
    timestamp: Option<&str>,
) -> AppResult<Vec<String>> {
    // pinData is a hex string of one or more output bytes (LSB = bit 0). N bytes
    // expose pins Q0.0 … Q{N-1}.7 — so a PLC scales by reading more bytes.
    let bytes = decode_hex(pin_data).ok_or_else(|| {
        AppError::bad_request(
            "pinData must be a hex string of whole bytes (e.g. \"0f\" or \"0f1a\")",
        )
    })?;
    let store = &state.store;

    // Shift to factory-local wall-clock so production buckets into the right
    // hour/day on the floor. Differences between two such values are unchanged,
    // so signal-timeout / running-minute math stays correct.
    let now = parse_timestamp(timestamp) + state.config.factory_offset();

    // A retried payload still proves the daemon is alive, so this comes first.
    mark_plc_seen(state, plc_id).await;

    // Idempotency: a payload that carries its own timestamp is applied once,
    // whichever instance each attempt reaches. One without a timestamp cannot
    // be told from the next reading, so it is always applied.
    if let Some(ts) = timestamp.filter(|t| !t.is_empty()) {
        let key = format!("{plc_id}|{ts}|{pin_data}");
        if state.pipeline.seen_here(&key) || !store.ingests.claim(&key).await? {
            return Ok(Vec::new());
        }
    }

    let pins = pin_map(state).await?;
    let prefix = format!("{plc_id}|");
    let machine_ids: HashSet<Id> = pins
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .map(|(_, v)| v.machine_id)
        .collect();
    if machine_ids.is_empty() {
        return Ok(Vec::new());
    }

    let before = store.machines.live_states(&machine_ids).await?;
    let (power_to, cycle_to) = signal_timeouts(state).await;

    // ── First batch: the machines' own marks ─────────────────────────────────
    // Readings and power marks do not wait on the database at all: they go to
    // the bulk writers, which store them within a second.
    let mut first = store.batch();
    let mut power_now: HashSet<Id> = HashSet::new();
    let mut cycles_now: HashMap<Id, u32> = HashMap::new();
    for (byte_idx, &byte_value) in bytes.iter().enumerate() {
        for bit in 0u8..8 {
            let pin_value = (byte_value >> bit) & 1;
            // Siemens byte.bit address, scoped to the posting PLC.
            let Some(info) = pins.get(&format!("{plc_id}|Q{byte_idx}.{bit}")) else {
                continue;
            };
            if state.pipeline.signal_write_due(info.sensor_id, pin_value) {
                let reading = Reading {
                    machine: info.machine_id,
                    value: pin_value,
                    at: now,
                };
                if !store.latest_signals.try_write(info.sensor_id, reading) {
                    // Refused: let the next payload offer this reading again.
                    state.pipeline.signal_written.remove(&info.sensor_id);
                    state.pipeline.warn_writer_full("latest-signals");
                }
            }
            if pin_value != 1 {
                continue;
            }
            match info.sensor_type.as_str() {
                POWER => {
                    power_now.insert(info.machine_id);
                }
                UNIT_CYCLE => *cycles_now.entry(info.machine_id).or_default() += 1,
                _ => {}
            }
        }
    }

    let within =
        |last: Option<DateTime<Utc>>, timeout| last.map(|t| t >= now - timeout).unwrap_or(false);
    let minute = now.timestamp() / 60;
    let mut steps: Vec<Step<'_>> = Vec::with_capacity(machine_ids.len());
    for &machine in &machine_ids {
        let Some(was) = before.get(&machine) else {
            continue; // mapped to a machine that no longer exists
        };
        let powered = power_now.contains(&machine);
        let cycles = cycles_now.get(&machine).copied().unwrap_or(0);
        if powered
            && PipelineState::due(&state.pipeline.power_written, &machine, POWER_WRITE_EVERY)
            && !store.power_marks.try_write(machine, now)
        {
            state.pipeline.power_written.remove(&machine);
            state.pipeline.warn_writer_full("power-marks");
        }
        if cycles > 0 {
            store.machines.queue_cycle(&mut first, machine, now);
        }

        let has_power = powered || within(was.last_power, power_to);
        let has_cycle = cycles > 0 || within(was.last_cycle, cycle_to);
        let (status, color) = state_of(has_power, has_cycle);
        // Whichever payload moves the minute marker forward counts the minute.
        let minute_claim = (status == RUNNING && minute > was.last_running_minute).then(|| {
            store
                .machines
                .queue_running_minute_claim(&mut first, machine, minute)
        });
        if was.status != status {
            store.machines.queue_status(&mut first, machine, status);
        }
        steps.push(Step {
            machine,
            was,
            cycles,
            status,
            color,
            has_power,
            has_cycle,
            minute_claim,
        });
    }
    let first = first.send().await?;

    // ── Second batch: production records ─────────────────────────────────────
    let mut second = store.batch();
    // (position in the batch, machine, re-queue)
    let mut unit_writes: Vec<(usize, &Step<'_>, Option<usize>)> = Vec::new();
    let mut minute_writes: Vec<(usize, &Step<'_>)> = Vec::new();
    for step in &steps {
        if step.cycles > 0 {
            let gap = step
                .was
                .last_cycle
                .map(|prev| (now - prev).num_milliseconds() as f64 / 1000.0)
                .and_then(cycle_bucket);
            let at = store
                .records
                .queue_units(&mut second, step.machine, now, step.cycles, gap);
            unit_writes.push((at, step, gap));
        }
        let counts_minute = step
            .minute_claim
            .map(|i| first[i].modified == 1)
            .unwrap_or(false);
        if counts_minute {
            let at = store
                .records
                .queue_running_minute(&mut second, step.machine, now);
            minute_writes.push((at, step));
        }
    }
    let second = second.send().await?;

    // An hour's first write finds no bucket: create it and send those again.
    let mut retry = store.batch();
    for &(at, step, gap) in &unit_writes {
        if second[at].matched == 0 {
            store.records.ensure_hour(step.machine, now).await?;
            store
                .records
                .queue_units(&mut retry, step.machine, now, step.cycles, gap);
        }
    }
    for &(at, step) in &minute_writes {
        if second[at].matched == 0 {
            store.records.ensure_hour(step.machine, now).await?;
            store
                .records
                .queue_running_minute(&mut retry, step.machine, now);
        }
    }
    retry.send().await?;

    // ── Transitions: rare, so written one by one ─────────────────────────────
    for step in &steps {
        if step.cycles > 0 && step.was.status == STOPPED {
            store.records.close_stoppages(step.machine, now).await?;
            realtime::broadcast(
                &state.io,
                "stoppage-resolved",
                &json!({ "machineId": step.machine.to_hex(), "timestamp": now }),
            )
            .await;
        }
        if step.status == STOPPED && step.was.status != STOPPED {
            let stoppage_id = ObjectId::new();
            if store
                .records
                .open_stoppage(step.machine, now, stoppage_id)
                .await?
            {
                realtime::broadcast(
                    &state.io,
                    "unclassified-stoppage-detected",
                    &json!({
                        "machineId": step.machine.to_hex(),
                        "hour": now.hour() as i64,
                        "date": date_str(now),
                        "stoppageStart": now,
                        "pendingStoppageId": stoppage_id.to_hex(),
                        "timestamp": now,
                    }),
                )
                .await;
            }
        }
    }

    // ── Realtime events, from one read of the buckets that changed ───────────
    let changed: Vec<Id> = unit_writes
        .iter()
        .map(|(_, s, _)| s.machine)
        .chain(minute_writes.iter().map(|(_, s)| s.machine))
        .collect::<HashSet<Id>>()
        .into_iter()
        .collect();
    let hours = store.records.hours_at(&changed, now).await?;
    let hour = now.hour() as i64;
    for (_, step, _) in &unit_writes {
        if let Some(hd) = hours.get(&step.machine) {
            realtime::broadcast(
                &state.io,
                "production-update",
                &json!({
                    "machineId": step.machine.to_hex(),
                    "hour": hour,
                    "date": date_str(now),
                    "unitsProduced": hd.units_produced,
                    "status": hd.status,
                    "runningMinutes": hd.running_minutes,
                    "stoppageMinutes": hd.stoppage_minutes,
                    "timestamp": now,
                }),
            )
            .await;
        }
    }
    for (_, step) in &minute_writes {
        if let Some(hd) = hours.get(&step.machine) {
            realtime::broadcast(
                &state.io,
                "running-time-update",
                &json!({
                    "machineId": step.machine.to_hex(),
                    "hour": hour,
                    "date": date_str(now),
                    "runningMinutes": hd.running_minutes,
                    "timestamp": now,
                }),
            )
            .await;
        }
    }
    // A state is announced when it changes, not once per payload.
    for step in steps.iter().filter(|s| s.was.status != s.status) {
        realtime::broadcast(
            &state.io,
            "machine-state-update",
            &json!({
                "machineId": step.machine.to_hex(),
                "status": step.status,
                "color": step.color,
                "hasPower": step.has_power,
                "hasCycle": step.has_cycle,
                "dbStatus": step.status,
                "timestamp": now,
            }),
        )
        .await;
    }

    Ok(steps
        .iter()
        .filter(|s| s.cycles > 0)
        .map(|s| s.machine.to_hex())
        .collect())
}

/// Process several readings from one PLC in order, as a daemon sends them when
/// it reconnects after an outage. Returns how many were applied and how many
/// were rejected as malformed.
pub async fn process_batch(
    state: &AppState,
    plc_id: &str,
    readings: &[(String, Option<String>)],
) -> AppResult<(usize, usize)> {
    let (mut applied, mut rejected) = (0, 0);
    for (pin_data, timestamp) in readings {
        match process_pin_data(state, plc_id, pin_data, timestamp.as_deref()).await {
            Ok(_) => applied += 1,
            Err(AppError::BadRequest(_)) => rejected += 1,
            Err(e) => return Err(e),
        }
    }
    Ok((applied, rejected))
}

/// Record that a PLC's daemon just posted. The silent-PLC sweep reads this to
/// tell a stopped machine from a daemon that went away. A failed write must not
/// fail ingestion, so it is logged and retried on the next payload.
async fn mark_plc_seen(state: &AppState, plc_id: &str) {
    let key = plc_id.to_string();
    if !PipelineState::due(&state.pipeline.plc_seen_written, &key, PLC_SEEN_WRITE_EVERY) {
        return;
    }
    if let Err(e) = state.store.plcs.mark_seen(plc_id).await {
        tracing::warn!("failed to record that PLC {plc_id} was seen: {e}");
        state.pipeline.plc_seen_written.remove(&key);
    }
}

// ── Background jobs ──────────────────────────────────────────────────────────

/// Update the duration of every stoppage that is still open on a machine that
/// is still stopped. `now` is factory-local, like the stoppage start times.
/// Returns how many were updated. One failing stoppage does not stop the rest;
/// the first error is returned after all of them were tried.
pub async fn tick_ongoing_stoppages(state: &AppState, now: DateTime<Utc>) -> AppResult<usize> {
    let store = &state.store;
    let open = store.records.with_open_stoppages(now.date_naive()).await?;
    if open.is_empty() {
        return Ok(0);
    }
    let machine_ids: Vec<ObjectId> = open.iter().map(|r| r.machine_id.oid()).collect();
    let stopped = store.machines.with_status(&machine_ids, STOPPED).await?;

    let mut ticked = 0;
    let mut first_error = None;
    for rec in open
        .iter()
        .filter(|r| stopped.contains(&r.machine_id.oid()))
    {
        for hour in &rec.hourly_data {
            for stoppage in hour
                .stoppages
                .iter()
                .filter(|s| s.reason == NO_REASON && s.is_pending)
            {
                match tick_stoppage(state, rec, hour, stoppage, now).await {
                    Ok(true) => ticked += 1,
                    Ok(false) => {}
                    Err(e) => {
                        first_error.get_or_insert(e);
                    }
                }
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(ticked),
    }
}

async fn tick_stoppage(
    state: &AppState,
    rec: &ProductionRecord,
    hour: &HourlyData,
    stoppage: &Stoppage,
    now: DateTime<Utc>,
) -> AppResult<bool> {
    let (Some(rec_id), Some(stoppage_id), Some(started)) =
        (rec.id, stoppage.id, stoppage.start_time)
    else {
        return Ok(false);
    };
    let duration = ((now - started).num_seconds() / 60).max(0) as f64;
    let stored = duration.min(60.0);
    if stored == stoppage.duration {
        return Ok(false);
    }
    let hour_total: f64 = hour
        .stoppages
        .iter()
        .map(|s| {
            if s.id == Some(stoppage_id) {
                stored
            } else {
                s.duration
            }
        })
        .sum();

    let still_open = state
        .store
        .records
        .set_stoppage_duration(
            rec_id.oid(),
            hour.hour as i64,
            stoppage_id.oid(),
            stored,
            hour_total.min(60.0),
        )
        .await?;
    if !still_open {
        return Ok(false);
    }

    realtime::broadcast(
        &state.io,
        "stoppage-updated",
        &json!({
            "machineId": rec.machine_id.to_hex(),
            "hour": hour.hour as i64,
            "date": date_str(rec.start_time),
            "stoppageId": stoppage_id.to_hex(),
            "duration": duration,
        }),
    )
    .await;
    Ok(true)
}

/// Set machines to idle when every PLC they are wired to has stopped posting
/// for longer than both signal timeouts. Machine state is otherwise only
/// recomputed when a payload arrives, so without this a machine whose daemon
/// died would show its last state forever. `now` is real UTC, like
/// `lastSeenAt`. Returns how many machines changed.
pub async fn sweep_silent_plcs(state: &AppState, now: DateTime<Utc>) -> AppResult<usize> {
    let store = &state.store;
    store.plcs.stamp_unseen(now).await?;

    let (power_to, cycle_to) = signal_timeouts(state).await;
    let silent: HashSet<String> = store
        .plcs
        .silent_since(now - power_to.max(cycle_to))
        .await?
        .into_iter()
        .collect();
    if silent.is_empty() {
        return Ok(0);
    }

    // A machine wired to several PLCs is silent only when all of them are.
    let pins = pin_map(state).await?;
    let mut machine_silent: HashMap<Id, bool> = HashMap::new();
    for (key, info) in pins.iter() {
        let plc_id = key.rsplit_once('|').map(|(plc, _)| plc).unwrap_or(key);
        let is_silent = silent.contains(plc_id);
        machine_silent
            .entry(info.machine_id)
            .and_modify(|all| *all &= is_silent)
            .or_insert(is_silent);
    }
    let candidates: Vec<ObjectId> = machine_silent
        .iter()
        .filter(|(_, all)| **all)
        .map(|(id, _)| id.oid())
        .collect();

    let idled = store.machines.idle_all(&candidates, now).await?;
    for machine_id in &idled {
        realtime::broadcast(
            &state.io,
            "machine-state-update",
            &json!({
                "machineId": machine_id.to_hex(),
                "status": IDLE,
                "color": "gray",
                "hasPower": false,
                "hasCycle": false,
                "dbStatus": IDLE,
                "reason": "plc-silent",
                "timestamp": state.config.factory_now(),
            }),
        )
        .await;
    }
    Ok(idled.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycle_gaps_land_in_the_right_bucket() {
        assert_eq!(cycle_bucket(0.0), None);
        assert_eq!(cycle_bucket(-3.0), None);
        assert_eq!(cycle_bucket(0.4), Some(0));
        assert_eq!(cycle_bucket(1.0), Some(0));
        assert_eq!(cycle_bucket(1.01), Some(1));
        assert_eq!(cycle_bucket(4.0), Some(3));
        assert_eq!(cycle_bucket(300.0), Some(11));
        assert_eq!(
            cycle_bucket(300.5),
            None,
            "longer than the last edge is a stoppage"
        );
    }

    #[test]
    fn only_whole_ascii_hex_bytes_decode() {
        assert_eq!(decode_hex("0f1a"), Some(vec![0x0f, 0x1a]));
        assert_eq!(decode_hex(" ff "), Some(vec![0xff]));
        assert_eq!(decode_hex(""), None);
        assert_eq!(decode_hex("f"), None);
        assert_eq!(decode_hex("zz"), None);
        assert_eq!(decode_hex("\u{e9}0"), None);
    }

    #[test]
    fn the_four_states_follow_power_and_cycle() {
        assert_eq!(state_of(true, true).0, RUNNING);
        assert_eq!(state_of(true, false).0, STOPPED);
        assert_eq!(state_of(false, true).0, PRODUCING_UNPOWERED);
        assert_eq!(state_of(false, false).0, IDLE);
    }
}
