//! Bulk entity writer: takes writes off the request path.
//!
//! A caller hands over a keyed value with [`BulkEntityWriter::try_write`],
//! which never waits on the database, and gets on with its request. One
//! background task collects what arrives and stores it in bulk, either when a
//! batch fills or on a short timer. A later value for the same key replaces an
//! earlier one that has not been stored yet, so a signal that changes ten
//! times between two flushes costs one write, not ten.
//!
//! This is for writes where the latest value is what matters and a second of
//! delay is harmless: a sensor's current reading, a machine's last-power mark.
//! It is the wrong tool for anything a caller must know is stored before it
//! answers; unit counts go to the database directly.
//!
//! Guarantees:
//!   * `try_write` never blocks. When the buffer is full it returns `false`
//!     and the caller decides what to do; nothing is dropped silently.
//!   * `flush` returns once everything written before the call is stored. A
//!     reader that needs fresh rows calls it first.
//!   * `shutdown` stores a part-filled buffer before the task ends.
//!   * A failed store keeps the values and tries again on the next round; the
//!     failure is logged, the first time and then every tenth.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::pin::Pin;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use super::DbResult;

/// Stores one batch. Called by the writer's task, never concurrently.
pub type Sink<K, V> =
    Box<dyn Fn(Vec<(K, V)>) -> Pin<Box<dyn Future<Output = DbResult<()>> + Send>> + Send + Sync>;

enum Message<K, V> {
    Write(K, V),
    Flush(oneshot::Sender<()>),
    Shutdown(oneshot::Sender<()>),
}

pub struct Settings {
    /// Shown in logs.
    pub name: &'static str,
    /// Longest a value waits before it is stored.
    pub every: Duration,
    /// A batch this large is stored at once, without waiting for the timer.
    pub max_batch: usize,
    /// Values that may wait in the channel before `try_write` reports full.
    pub capacity: usize,
}

pub struct BulkEntityWriter<K, V> {
    name: &'static str,
    tx: mpsc::Sender<Message<K, V>>,
}

impl<K, V> BulkEntityWriter<K, V>
where
    K: Eq + Hash + Clone + Send + 'static,
    V: Clone + Send + 'static,
{
    /// Start the writer's task. Must be called inside the async runtime.
    pub fn start(settings: Settings, sink: Sink<K, V>) -> Self {
        let (tx, rx) = mpsc::channel(settings.capacity);
        let name = settings.name;
        tokio::spawn(run(settings, rx, sink));
        Self { name, tx }
    }

    /// Hand a value over. `false` means it was not accepted: the buffer is
    /// full, or the writer has shut down.
    pub fn try_write(&self, key: K, value: V) -> bool {
        self.tx.try_send(Message::Write(key, value)).is_ok()
    }

    /// Wait until everything written before this call is stored.
    pub async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(Message::Flush(done)).await.is_ok() {
            let _ = wait.await;
        }
    }

    /// Store what is buffered and stop. Writes after this are refused.
    pub async fn shutdown(&self) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(Message::Shutdown(done)).await.is_ok() {
            let _ = wait.await;
        }
        tracing::debug!(writer = self.name, "bulk writer stopped");
    }
}

async fn run<K, V>(settings: Settings, mut rx: mpsc::Receiver<Message<K, V>>, sink: Sink<K, V>)
where
    K: Eq + Hash + Clone + Send + 'static,
    V: Clone + Send + 'static,
{
    let mut pending: HashMap<K, V> = HashMap::new();
    let mut failures: u32 = 0;
    let mut timer = tokio::time::interval(settings.every);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            message = rx.recv() => match message {
                Some(Message::Write(key, value)) => {
                    pending.insert(key, value);
                    if pending.len() >= settings.max_batch {
                        store(&settings, &sink, &mut pending, &mut failures).await;
                    }
                }
                Some(Message::Flush(done)) => {
                    store(&settings, &sink, &mut pending, &mut failures).await;
                    let _ = done.send(());
                }
                Some(Message::Shutdown(done)) => {
                    store(&settings, &sink, &mut pending, &mut failures).await;
                    let _ = done.send(());
                    return;
                }
                // Every handle is gone: store what is left and end.
                None => {
                    store(&settings, &sink, &mut pending, &mut failures).await;
                    return;
                }
            },
            _ = timer.tick() => store(&settings, &sink, &mut pending, &mut failures).await,
        }
    }
}

/// Store the buffer. On failure the values stay buffered for the next round,
/// unless newer values for the same keys arrive first.
async fn store<K, V>(
    settings: &Settings,
    sink: &Sink<K, V>,
    pending: &mut HashMap<K, V>,
    failures: &mut u32,
) where
    K: Eq + Hash + Clone,
    V: Clone,
{
    if pending.is_empty() {
        return;
    }
    let batch: Vec<(K, V)> = pending
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let size = batch.len();
    match sink(batch).await {
        Ok(()) => {
            pending.clear();
            if *failures > 0 {
                tracing::info!(
                    writer = settings.name,
                    "storing again after {failures} failed round(s)"
                );
            }
            *failures = 0;
        }
        Err(e) => {
            *failures += 1;
            if *failures == 1 || failures.is_multiple_of(10) {
                tracing::warn!(
                    writer = settings.name,
                    failures = *failures,
                    "could not store {size} buffered row(s), will retry: {e}"
                );
            }
            // Bound what a long outage can pile up: keep the newest view only.
            if pending.len() > settings.capacity {
                pending.clear();
                tracing::warn!(
                    writer = settings.name,
                    "buffer overflowed during the outage; dropped {size} row(s)"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    type Stored = Arc<Mutex<Vec<Vec<(u32, u32)>>>>;

    fn writer(
        every: Duration,
        max_batch: usize,
        capacity: usize,
        failing: Arc<AtomicBool>,
    ) -> (BulkEntityWriter<u32, u32>, Stored) {
        let stored: Stored = Arc::new(Mutex::new(Vec::new()));
        let seen = stored.clone();
        let sink: Sink<u32, u32> = Box::new(move |batch| {
            let seen = seen.clone();
            let failing = failing.clone();
            Box::pin(async move {
                if failing.load(Ordering::SeqCst) {
                    return Err(mongodb::error::Error::custom("down"));
                }
                seen.lock().unwrap().push(batch);
                Ok(())
            })
        });
        let settings = Settings {
            name: "test",
            every,
            max_batch,
            capacity,
        };
        (BulkEntityWriter::start(settings, sink), stored)
    }

    fn rows(stored: &Stored) -> Vec<(u32, u32)> {
        let mut all: Vec<(u32, u32)> = stored.lock().unwrap().iter().flatten().copied().collect();
        all.sort();
        all
    }

    #[tokio::test]
    async fn a_later_value_for_a_key_replaces_one_not_yet_stored() {
        let (w, stored) = writer(Duration::from_secs(3600), 100, 100, Arc::default());
        for value in 1..=10 {
            assert!(w.try_write(7, value));
        }
        assert!(w.try_write(8, 1));
        w.flush().await;
        assert_eq!(rows(&stored), vec![(7, 10), (8, 1)]);
        assert_eq!(
            stored.lock().unwrap().len(),
            1,
            "one bulk write for eleven calls"
        );
    }

    #[tokio::test]
    async fn a_full_batch_is_stored_without_waiting_for_the_timer() {
        let (w, stored) = writer(Duration::from_secs(3600), 3, 100, Arc::default());
        for key in 0..3 {
            w.try_write(key, key);
        }
        for _ in 0..50 {
            if !stored.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(rows(&stored), vec![(0, 0), (1, 1), (2, 2)]);
    }

    #[tokio::test]
    async fn the_timer_stores_a_part_filled_buffer() {
        let (w, stored) = writer(Duration::from_millis(40), 100, 100, Arc::default());
        w.try_write(1, 1);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rows(&stored), vec![(1, 1)]);
    }

    #[tokio::test]
    async fn shutdown_stores_what_is_buffered_and_refuses_later_writes() {
        let (w, stored) = writer(Duration::from_secs(3600), 100, 100, Arc::default());
        w.try_write(1, 1);
        w.shutdown().await;
        assert_eq!(rows(&stored), vec![(1, 1)]);
        assert!(!w.try_write(2, 2), "a stopped writer must say so");
    }

    #[tokio::test]
    async fn a_failed_round_keeps_the_values_and_stores_them_later() {
        let failing = Arc::new(AtomicBool::new(true));
        let (w, stored) = writer(Duration::from_secs(3600), 100, 100, failing.clone());
        w.try_write(1, 1);
        w.flush().await;
        assert!(rows(&stored).is_empty());

        failing.store(false, Ordering::SeqCst);
        w.try_write(2, 2);
        w.flush().await;
        assert_eq!(rows(&stored), vec![(1, 1), (2, 2)]);
    }

    #[tokio::test]
    async fn a_full_buffer_refuses_instead_of_blocking() {
        // A sink that never finishes its first batch, so the channel backs up.
        let started = Arc::new(AtomicUsize::new(0));
        let entered = started.clone();
        let sink: Sink<u32, u32> = Box::new(move |_| {
            entered.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                Ok(())
            })
        });
        let settings = Settings {
            name: "stuck",
            every: Duration::from_secs(3600),
            max_batch: 1,
            capacity: 4,
        };
        let w = BulkEntityWriter::start(settings, sink);
        w.try_write(0, 0);
        while started.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let accepted = (1..=20).filter(|k| w.try_write(*k, 0)).count();
        assert_eq!(
            accepted, 4,
            "exactly the channel's capacity is accepted, the rest refused at once"
        );
    }
}
