//! Readings waiting to reach the backend.
//!
//! The daemon reads the PLC on a fixed beat whether or not the backend can be
//! reached. Each reading goes into the outbox with the time it was taken, and
//! leaves only when the backend has accepted it. During an outage the outbox
//! fills; when the backend is back the readings are replayed oldest first, in
//! batches, with their original timestamps, so production lands in the right
//! minute and hour. The backend applies a timestamped reading at most once, so
//! a batch whose answer was lost can simply be sent again.
//!
//! The outbox is in memory and bounded. If an outage outlasts it, the oldest
//! readings are dropped and counted, never silently.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub pin_data: String,
    pub timestamp: String,
}

pub struct Outbox {
    readings: VecDeque<Reading>,
    capacity: usize,
    /// Readings dropped because the outbox was full, since the last report.
    dropped: u64,
    failures: u32,
    next_attempt: Option<Instant>,
}

impl Outbox {
    pub fn new(capacity: usize) -> Self {
        Self {
            readings: VecDeque::with_capacity(capacity.min(1024)),
            capacity: capacity.max(1),
            dropped: 0,
            failures: 0,
            next_attempt: None,
        }
    }

    pub fn len(&self) -> usize {
        self.readings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.readings.is_empty()
    }

    /// Add a reading. When full, the oldest one makes room.
    pub fn push(&mut self, reading: Reading) {
        if self.readings.len() == self.capacity {
            self.readings.pop_front();
            self.dropped += 1;
        }
        self.readings.push_back(reading);
    }

    /// The oldest readings, at most `max`, without removing them.
    pub fn oldest(&self, max: usize) -> Vec<Reading> {
        self.readings.iter().take(max).cloned().collect()
    }

    /// The backend accepted the `count` oldest readings.
    pub fn delivered(&mut self, count: usize) {
        self.readings.drain(..count.min(self.readings.len()));
        self.failures = 0;
        self.next_attempt = None;
    }

    /// A delivery failed. The readings stay. Returns how many attempts have
    /// failed in a row, for the caller to choose how long to wait.
    pub fn failed(&mut self) -> u32 {
        self.failures += 1;
        self.failures
    }

    /// Do not try again before `delay` has passed.
    pub fn wait(&mut self, now: Instant, delay: Duration) {
        self.next_attempt = Some(now + delay);
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Whether to try the backend now, or keep collecting until the wait ends.
    pub fn should_attempt(&self, now: Instant) -> bool {
        !self.readings.is_empty() && self.next_attempt.map(|at| now >= at).unwrap_or(true)
    }

    /// How many readings were dropped since this was last asked.
    pub fn take_dropped(&mut self) -> u64 {
        std::mem::take(&mut self.dropped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(n: u32) -> Reading {
        Reading {
            pin_data: format!("{n:02x}"),
            timestamp: format!("t{n}"),
        }
    }

    #[test]
    fn readings_leave_oldest_first_and_only_when_delivered() {
        let mut outbox = Outbox::new(10);
        for n in 0..5 {
            outbox.push(reading(n));
        }
        assert_eq!(outbox.oldest(3), vec![reading(0), reading(1), reading(2)]);
        assert_eq!(outbox.len(), 5, "looking does not remove");
        outbox.delivered(3);
        assert_eq!(outbox.oldest(10), vec![reading(3), reading(4)]);
        outbox.delivered(99);
        assert!(outbox.is_empty());
    }

    #[test]
    fn a_full_outbox_drops_the_oldest_and_counts_it() {
        let mut outbox = Outbox::new(3);
        for n in 0..5 {
            outbox.push(reading(n));
        }
        assert_eq!(outbox.oldest(10), vec![reading(2), reading(3), reading(4)]);
        assert_eq!(outbox.take_dropped(), 2);
        assert_eq!(outbox.take_dropped(), 0, "reported once");
    }

    #[test]
    fn a_failure_keeps_the_readings_and_delays_the_next_attempt() {
        let mut outbox = Outbox::new(10);
        let now = Instant::now();
        assert!(!outbox.should_attempt(now), "nothing to send");
        outbox.push(reading(1));
        assert!(outbox.should_attempt(now));

        assert_eq!(outbox.failed(), 1);
        outbox.wait(now, Duration::from_secs(5));
        assert_eq!(outbox.len(), 1);
        assert!(!outbox.should_attempt(now + Duration::from_secs(4)));
        assert!(outbox.should_attempt(now + Duration::from_secs(5)));
        assert_eq!(outbox.failed(), 2);

        outbox.push(reading(2));
        outbox.delivered(2);
        assert_eq!(outbox.failures(), 0, "a delivery clears the failure count");
    }
}
