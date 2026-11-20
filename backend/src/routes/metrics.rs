//! The one place OEE, MTBF, MTTR and the failure rate are worked out. Every
//! endpoint folds the hours it cares about into a [`Totals`] and asks it for
//! the figures, so two screens cannot disagree about the same hours.

use std::collections::HashMap;

use crate::models::HourlyData;
use crate::persist::configs::{KIND_BREAKDOWN, KIND_PLANNED, KIND_UNPLANNED};
use crate::persist::records::NO_REASON;

/// Stoppage reason key to its kind, from the plant's configured reasons.
pub type ReasonKinds = HashMap<String, String>;

/// The kind of a stoppage with the given reason. A reason the plant has since
/// removed, and a stoppage nobody has explained yet, count as unplanned: lost
/// time must not disappear from availability because its label did.
pub fn kind_of<'a>(kinds: &'a ReasonKinds, reason: &str) -> &'a str {
    if reason == NO_REASON {
        return KIND_UNPLANNED;
    }
    kinds
        .get(reason)
        .map(String::as_str)
        .unwrap_or(KIND_UNPLANNED)
}

/// A ratio as a whole percentage.
pub fn percent(ratio: f64) -> i64 {
    (ratio * 100.0).round() as i64
}

/// Running totals for a set of hours (a machine, a shift, a day, ...).
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Totals {
    pub units: f64,
    pub defective: f64,
    pub running_minutes: f64,
    pub stopped_minutes: f64,
    /// The part of `stopped_minutes` spent in planned stops.
    pub planned_minutes: f64,
    /// What the molds should have made in the running minutes.
    pub expected_units: f64,
    pub stoppages: i64,
    pub breakdowns: i64,
    pub breakdown_minutes: f64,
}

impl Totals {
    /// Add one hour. `mold_rate_per_hour` is the ideal rate of the mold the
    /// hour ran with, or 0 when it had none.
    pub fn add_hour(&mut self, h: &HourlyData, mold_rate_per_hour: f64, kinds: &ReasonKinds) {
        self.units += h.units_produced;
        self.defective += h.defective_units;
        self.running_minutes += h.running_minutes;
        self.stopped_minutes += h.stoppage_minutes;
        if mold_rate_per_hour > 0.0 {
            self.expected_units += mold_rate_per_hour / 60.0 * h.running_minutes;
        }
        self.stoppages += h.stoppages.len() as i64;
        let mut planned = 0.0;
        for s in &h.stoppages {
            match kind_of(kinds, &s.reason) {
                KIND_BREAKDOWN => {
                    self.breakdowns += 1;
                    self.breakdown_minutes += s.duration;
                }
                KIND_PLANNED => planned += s.duration,
                _ => {}
            }
        }
        // The hour's stopped minutes are capped at 60 and the stoppages'
        // durations are not, so the planned part is held to what was counted.
        self.planned_minutes += planned.min(h.stoppage_minutes);
    }

    /// Share of the time the machine was meant to run that it did run.
    /// Planned stops are left out of both sides.
    pub fn availability(&self) -> f64 {
        ratio(
            self.running_minutes,
            self.running_minutes + self.stopped_minutes - self.planned_minutes,
        )
    }

    pub fn quality(&self) -> f64 {
        ratio(self.units - self.defective, self.units)
    }

    /// Output against the molds' ideal rate, or `None` when no hour had a
    /// mold with a rate. Capped at 1: output above the ideal rate means the
    /// rate or the running time is wrong, and an OEE above 100% would only
    /// mislead.
    pub fn performance(&self) -> Option<f64> {
        (self.expected_units > 0.0).then(|| (self.units / self.expected_units).min(1.0))
    }

    /// `None` whenever there is no performance figure.
    pub fn oee(&self) -> Option<f64> {
        self.performance()
            .map(|p| self.availability() * self.quality() * p)
    }

    /// Running minutes per breakdown; 0 without a breakdown.
    pub fn mtbf_minutes(&self) -> f64 {
        self.per_breakdown(self.running_minutes)
    }

    /// Minutes a breakdown lasted on average; 0 without a breakdown.
    pub fn mttr_minutes(&self) -> f64 {
        self.per_breakdown(self.breakdown_minutes)
    }

    /// Breakdowns per 100 running hours.
    pub fn failure_rate(&self) -> f64 {
        if self.running_minutes > 0.0 {
            self.breakdowns as f64 / (self.running_minutes / 6000.0)
        } else {
            0.0
        }
    }

    fn per_breakdown(&self, total: f64) -> f64 {
        if self.breakdowns > 0 {
            total / self.breakdowns as f64
        } else {
            0.0
        }
    }
}

fn ratio(part: f64, whole: f64) -> f64 {
    if whole > 0.0 {
        part / whole
    } else {
        0.0
    }
}

/// The gaps between consecutive units over a period, counted into buckets by
/// their upper edge (`pipeline::CYCLE_BUCKET_EDGES`).
#[derive(Default)]
pub struct CycleTimes {
    counts: [u64; crate::pipeline::CYCLE_BUCKET_EDGES.len()],
}

impl CycleTimes {
    /// Add one hour's histogram, stored as `{ b0: n, b3: n, .. }`.
    pub fn add_hour(&mut self, h: &HourlyData) {
        let Some(buckets) = &h.cycle_buckets else {
            return;
        };
        for (i, count) in self.counts.iter_mut().enumerate() {
            *count += match buckets.get(format!("b{i}")) {
                Some(bson::Bson::Int32(n)) => (*n).max(0) as u64,
                Some(bson::Bson::Int64(n)) => (*n).max(0) as u64,
                Some(bson::Bson::Double(n)) => n.max(0.0) as u64,
                _ => 0,
            };
        }
    }

    pub fn total(&self) -> u64 {
        self.counts.iter().sum()
    }

    /// Upper edge of the bucket holding the middle gap: half of all units
    /// followed the one before within this many seconds.
    pub fn median_seconds(&self) -> Option<f64> {
        let total = self.total();
        if total == 0 {
            return None;
        }
        let mut seen = 0;
        for (i, count) in self.counts.iter().enumerate() {
            seen += count;
            if seen * 2 >= total {
                return Some(crate::pipeline::CYCLE_BUCKET_EDGES[i]);
            }
        }
        None
    }

    /// `ideal_seconds` is what the molds in use call for per unit, when known.
    pub fn to_json(&self, ideal_seconds: Option<f64>) -> serde_json::Value {
        serde_json::json!({
            "edges": crate::pipeline::CYCLE_BUCKET_EDGES,
            "counts": self.counts,
            "total": self.total(),
            "medianSeconds": self.median_seconds(),
            "idealSeconds": ideal_seconds.map(|s| (s * 10.0).round() / 10.0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycle_times_add_up_and_find_the_middle_gap() {
        let hour = |buckets: bson::Document| HourlyData {
            hour: 0.0,
            units_produced: 0.0,
            defective_units: 0.0,
            status: String::new(),
            operator_id: None,
            mold_id: None,
            stoppages: Vec::new(),
            running_minutes: 0.0,
            stoppage_minutes: 0.0,
            cycle_buckets: Some(buckets),
        };
        let mut times = CycleTimes::default();
        assert_eq!(times.median_seconds(), None);
        // 6 gaps of up to 5 s, 3 of up to 8 s, 1 of up to 90 s.
        times.add_hour(&hour(bson::doc! { "b3": 4, "b4": 3i64 }));
        times.add_hour(&hour(bson::doc! { "b3": 2, "b9": 1, "junk": "x" }));
        assert_eq!(times.total(), 10);
        assert_eq!(times.median_seconds(), Some(5.0));
        let json = times.to_json(Some(3.6));
        assert_eq!(json["counts"][3], 6);
        assert_eq!(json["counts"][9], 1);
        assert_eq!(json["idealSeconds"], 3.6);
    }
    use crate::models::Stoppage;

    fn kinds() -> ReasonKinds {
        [
            ("breakdown", KIND_BREAKDOWN),
            ("jam", KIND_BREAKDOWN),
            ("mold_change", KIND_UNPLANNED),
            ("planned", KIND_PLANNED),
        ]
        .into_iter()
        .map(|(key, kind)| (key.to_string(), kind.to_string()))
        .collect()
    }

    fn stop(reason: &str, minutes: f64) -> Stoppage {
        Stoppage {
            id: None,
            reason: reason.to_string(),
            description: None,
            sap_notification_number: None,
            start_time: None,
            end_time: None,
            duration: minutes,
            is_pending: false,
            is_classified: true,
        }
    }

    fn hour(units: f64, defective: f64, running: f64, stoppages: Vec<Stoppage>) -> HourlyData {
        HourlyData {
            hour: 0.0,
            units_produced: units,
            defective_units: defective,
            status: "running".to_string(),
            operator_id: None,
            mold_id: None,
            stoppage_minutes: stoppages.iter().map(|s| s.duration).sum::<f64>().min(60.0),
            stoppages,
            running_minutes: running,
            cycle_buckets: None,
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn nothing_recorded_gives_zeroes_and_no_oee() {
        let t = Totals::default();
        assert_eq!(t.availability(), 0.0);
        assert_eq!(t.quality(), 0.0);
        assert_eq!(t.performance(), None);
        assert_eq!(t.oee(), None);
        assert_eq!(t.mtbf_minutes(), 0.0);
        assert_eq!(t.mttr_minutes(), 0.0);
        assert_eq!(t.failure_rate(), 0.0);
    }

    #[test]
    fn oee_is_availability_times_quality_times_performance() {
        let mut t = Totals::default();
        t.add_hour(&hour(120.0, 0.0, 60.0, vec![]), 120.0, &kinds());
        t.add_hour(
            &hour(
                30.0,
                15.0,
                30.0,
                vec![stop("breakdown", 20.0), stop("mold_change", 10.0)],
            ),
            120.0,
            &kinds(),
        );
        // 90 running + 30 stopped; 150 units, 15 bad, against 180 expected.
        assert_eq!(t.units, 150.0);
        assert_eq!(t.expected_units, 180.0);
        assert_eq!(t.stoppages, 2);
        assert!(close(t.availability(), 0.75));
        assert!(close(t.quality(), 0.9));
        assert!(close(t.performance().unwrap(), 150.0 / 180.0));
        assert!(close(t.oee().unwrap(), 0.75 * 0.9 * 150.0 / 180.0));
        assert_eq!(percent(t.oee().unwrap()), 56);
    }

    #[test]
    fn performance_is_capped_and_missing_without_a_mold_rate() {
        let mut fast = Totals::default();
        fast.add_hour(&hour(200.0, 0.0, 60.0, vec![]), 120.0, &kinds());
        assert_eq!(fast.performance(), Some(1.0));
        assert_eq!(fast.oee(), Some(1.0));

        let mut no_mold = Totals::default();
        no_mold.add_hour(&hour(200.0, 0.0, 60.0, vec![]), 0.0, &kinds());
        assert_eq!(no_mold.expected_units, 0.0);
        assert_eq!(no_mold.performance(), None);
        assert_eq!(no_mold.oee(), None);
        assert_eq!(no_mold.availability(), 1.0);
    }

    #[test]
    fn planned_stops_do_not_count_against_availability() {
        let mut t = Totals::default();
        t.add_hour(
            &hour(
                0.0,
                0.0,
                30.0,
                vec![stop("planned", 20.0), stop("mold_change", 10.0)],
            ),
            0.0,
            &kinds(),
        );
        assert_eq!(t.stopped_minutes, 30.0);
        assert_eq!(t.planned_minutes, 20.0);
        // 30 running out of the 40 minutes it was meant to run.
        assert!(close(t.availability(), 0.75));
        assert_eq!(t.breakdowns, 0);
    }

    #[test]
    fn planned_minutes_never_exceed_the_stopped_minutes_counted() {
        let mut t = Totals::default();
        t.add_hour(
            &hour(0.0, 0.0, 0.0, vec![stop("planned", 240.0)]),
            0.0,
            &kinds(),
        );
        assert_eq!(t.stopped_minutes, 60.0);
        assert_eq!(t.planned_minutes, 60.0);
        assert_eq!(t.availability(), 0.0);
    }

    #[test]
    fn breakdowns_are_decided_by_kind_not_by_key() {
        let mut t = Totals::default();
        t.add_hour(
            &hour(
                0.0,
                0.0,
                300.0,
                vec![stop("jam", 30.0), stop("breakdown", 10.0)],
            ),
            0.0,
            &kinds(),
        );
        assert_eq!(t.breakdowns, 2);
        assert_eq!(t.breakdown_minutes, 40.0);
        assert_eq!(t.mtbf_minutes(), 150.0);
        assert_eq!(t.mttr_minutes(), 20.0);
        // Two breakdowns in five running hours is 40 per 100 hours.
        assert!(close(t.failure_rate(), 40.0));

        // With "breakdown" redefined as a planned stop it is no failure.
        let mut redefined = kinds();
        redefined.insert("breakdown".to_string(), KIND_PLANNED.to_string());
        let mut t = Totals::default();
        t.add_hour(
            &hour(0.0, 0.0, 50.0, vec![stop("breakdown", 10.0)]),
            0.0,
            &redefined,
        );
        assert_eq!(t.breakdowns, 0);
        assert_eq!(t.availability(), 1.0);
    }

    #[test]
    fn unknown_and_unexplained_stoppages_are_unplanned() {
        let mut odd = kinds();
        odd.insert(NO_REASON.to_string(), KIND_PLANNED.to_string());
        assert_eq!(kind_of(&odd, "retired_reason"), KIND_UNPLANNED);
        assert_eq!(kind_of(&odd, NO_REASON), KIND_UNPLANNED);

        let mut t = Totals::default();
        t.add_hour(
            &hour(
                0.0,
                0.0,
                40.0,
                vec![stop("retired_reason", 10.0), stop(NO_REASON, 10.0)],
            ),
            0.0,
            &odd,
        );
        assert_eq!(t.planned_minutes, 0.0);
        assert_eq!(t.breakdowns, 0);
        assert!(close(t.availability(), 40.0 / 60.0));
    }
}
