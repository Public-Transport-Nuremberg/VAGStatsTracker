//! Historical assessment only; routing still optimizes scheduled arrival.
use chrono::{DateTime, Datelike, Timelike, Utc};
use history::{
    cancellation_key, day_type, hierarchy, normalize, CancellationStats, DataQuality,
    DelayHistogram, DelayStats, StatKey, StatsSnapshot, TransferStats, TransferStatsKey,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LookupRequest {
    pub product: u8,
    pub line: String,
    pub stop: i32,
    pub direction: Option<String>,
    pub headsign: Option<String>,
    pub scheduled: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Assessment {
    pub statistics_available: bool,
    pub arrival: Option<DelayStats>,
    pub departure: Option<DelayStats>,
    pub cancellation: Option<CancellationStats>,
    pub data_quality: Option<DataQuality>,
    pub insufficient_samples: u32,
    pub history_rejected: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ReliabilityConfig {
    pub delay_warning_probability: f32,
    pub delay_warning_seconds: i32,
    pub transfer_warning_probability: f32,
    pub transfer_critical_probability: f32,
    pub cancellation_warning_probability: f32,
    pub minimum_samples: u32,
}
impl Default for ReliabilityConfig {
    fn default() -> Self {
        Self {
            delay_warning_probability: 0.5,
            delay_warning_seconds: 300,
            transfer_warning_probability: 0.85,
            transfer_critical_probability: 0.65,
            cancellation_warning_probability: 0.03,
            minimum_samples: 20,
        }
    }
}
impl ReliabilityConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.minimum_samples < 20
            || self.delay_warning_seconds < 0
            || self.delay_warning_seconds > 3600
            || self.delay_warning_seconds % 30 != 0
            || [
                self.delay_warning_probability,
                self.transfer_warning_probability,
                self.transfer_critical_probability,
                self.cancellation_warning_probability,
            ]
            .iter()
            .any(|p| !p.is_finite() || !(0.0..=1.0).contains(p))
            || self.transfer_critical_probability > self.transfer_warning_probability
        {
            return Err("invalid reliability thresholds".into());
        }
        Ok(())
    }
}
fn empty(rejected: bool) -> Assessment {
    Assessment {
        statistics_available: false,
        arrival: None,
        departure: None,
        cancellation: None,
        data_quality: None,
        insufficient_samples: 0,
        history_rejected: rejected,
    }
}
/// Candidate texts must match one unique normalized historical direction for this
/// product/line. Numeric GTFS direction_id is intentionally absent from this API.
fn resolve_direction(s: &StatsSnapshot, r: &LookupRequest, line: &str) -> String {
    let Ok(tz) = s.timezone.parse::<chrono_tz::Tz>() else {
        return String::new();
    };
    let local = r.scheduled.with_timezone(&tz);
    let candidates: std::collections::HashSet<String> = r
        .direction
        .iter()
        .chain(r.headsign.iter())
        .map(|v| normalize(v))
        .filter(|v| !v.is_empty())
        .collect();
    let mut found = Vec::new();
    for direction in candidates {
        let base = StatKey {
            product: r.product,
            line: line.to_string(),
            stop: r.stop,
            direction: direction.clone(),
            weekday: local.weekday().number_from_monday() as u8,
            bucket: ((local.hour() * 60 + local.minute()) / 15) as u8,
            level: 0,
        };
        if hierarchy(&base, day_type(local.date_naive(), &s.holidays))
            .iter()
            .filter(|k| k.level <= 2)
            .any(|k| {
                s.arrivals.contains_key(k)
                    || s.departures.contains_key(k)
                    || s.cancellations.contains_key(&cancellation_key(k))
            })
        {
            found.push(direction);
        }
    }
    if found.len() == 1 {
        found.pop().unwrap()
    } else {
        String::new()
    }
}
impl Default for Assessment {
    fn default() -> Self {
        empty(false)
    }
}
pub fn assess_leg(s: &StatsSnapshot, r: &LookupRequest) -> Assessment {
    assess_leg_with_config(
        s,
        r,
        &ReliabilityConfig {
            minimum_samples: s.minimum_samples,
            ..Default::default()
        },
    )
}
pub fn assess_leg_with_config(
    s: &StatsSnapshot,
    r: &LookupRequest,
    c: &ReliabilityConfig,
) -> Assessment {
    let Ok(tz) = s.timezone.parse::<chrono_tz::Tz>() else {
        return empty(true);
    };
    let local = r.scheduled.with_timezone(&tz);
    if s.history_until >= local.date_naive() {
        return empty(true);
    }
    let minimum = c.minimum_samples.max(s.minimum_samples).max(20);
    let line = normalize(&r.line);
    let direction = resolve_direction(s, r, &line);
    let base = StatKey {
        product: r.product,
        line,
        stop: r.stop,
        direction,
        weekday: local.weekday().number_from_monday() as u8,
        bucket: ((local.hour() * 60 + local.minute()) / 15) as u8,
        level: 0,
    };
    let keys = hierarchy(&base, day_type(local.date_naive(), &s.holidays));
    let mut insufficient = 0;
    let mut lookup = |map: &std::collections::HashMap<StatKey, DelayStats>| {
        for k in &keys {
            if let Some(x) = map.get(k) {
                if x.samples >= minimum {
                    return Some(x.clone());
                }
                insufficient = insufficient.max(x.samples);
            }
        }
        None
    };
    let arrival = lookup(&s.arrivals);
    let departure = lookup(&s.departures);
    let mut cancellation = None;
    for k in &keys {
        if let Some(x) = s.cancellations.get(&cancellation_key(k)) {
            if x.samples >= minimum {
                cancellation = Some(x.clone());
                break;
            }
            insufficient = insufficient.max(x.samples);
        }
    }
    let data_quality = arrival
        .as_ref()
        .map(|x| x.data_quality)
        .or_else(|| departure.as_ref().map(|x| x.data_quality))
        .or_else(|| cancellation.as_ref().map(|x| x.data_quality));
    Assessment {
        statistics_available: arrival.is_some() || departure.is_some() || cancellation.is_some(),
        arrival,
        departure,
        cancellation,
        data_quality,
        insufficient_samples: insufficient,
        history_rejected: false,
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReliabilityModel {
    EmpiricalJoint,
    IndependentHistograms,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferReliability {
    pub scheduled_transfer_seconds: u32,
    pub walking_seconds: u32,
    pub usable_buffer_seconds: i32,
    pub success_probability: Option<f32>,
    pub probability_lower_bound: Option<f32>,
    pub probability_upper_bound: Option<f32>,
    pub samples: u32,
    pub model: ReliabilityModel,
    pub data_quality: DataQuality,
}
// Finite buckets use their lower endpoint (30 s resolution). Censored tails are
// unbounded intervals, never spuriously represented as +/- boundary point masses.
fn masses(h: &DelayHistogram) -> Vec<(f64, f64, u32)> {
    let mut out = Vec::new();
    if h.underflow > 0 {
        out.push((f64::NEG_INFINITY, -301.0, h.underflow));
    }
    for (i, &n) in h.bins.iter().enumerate() {
        if n > 0 {
            let x = (-300 + i as i32 * 30) as f64;
            out.push((x, x, n));
        }
    }
    if h.overflow > 0 {
        out.push((3600.0, f64::INFINITY, h.overflow));
    }
    out
}
/// Conditional independence of incoming arrival and outgoing departure delays.
/// Bounds expose unidentified censored-tail mass; only identified estimates are returned.
pub fn histogram_probability(
    incoming: &DelayHistogram,
    outgoing: &DelayHistogram,
    buffer: i32,
) -> (f32, f32) {
    let n = incoming.total() as f64 * outgoing.total() as f64;
    if n == 0.0 {
        return (0.0, 1.0);
    }
    let mut lower = 0.0;
    let mut upper = 0.0;
    for (al, ah, an) in masses(incoming) {
        for (bl, bh, bn) in masses(outgoing) {
            let weight = an as f64 * bn as f64 / n;
            if ah - bl <= buffer as f64 {
                lower += weight;
                upper += weight
            } else if al - bh <= buffer as f64 || (al - bh).is_nan() {
                upper += weight
            }
        }
    }
    (lower as f32, upper as f32)
}
pub fn transfer_reliability(
    incoming: Option<&DelayStats>,
    outgoing: Option<&DelayStats>,
    scheduled_transfer_seconds: u32,
    walking_seconds: u32,
    c: &ReliabilityConfig,
) -> TransferReliability {
    transfer_with_empirical(
        incoming,
        outgoing,
        None,
        scheduled_transfer_seconds,
        walking_seconds,
        c,
    )
}
pub fn transfer_with_empirical(
    incoming: Option<&DelayStats>,
    outgoing: Option<&DelayStats>,
    empirical: Option<&TransferStats>,
    scheduled_transfer_seconds: u32,
    walking_seconds: u32,
    c: &ReliabilityConfig,
) -> TransferReliability {
    let buffer = (scheduled_transfer_seconds as i64 - walking_seconds as i64)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let minimum = c.minimum_samples.max(20);
    let mut out = TransferReliability {
        scheduled_transfer_seconds,
        walking_seconds,
        usable_buffer_seconds: buffer,
        success_probability: None,
        probability_lower_bound: None,
        probability_upper_bound: None,
        samples: 0,
        model: ReliabilityModel::Unavailable,
        data_quality: DataQuality::Insufficient,
    };
    let bounds = if let Some(e) =
        empirical.filter(|e| e.samples >= minimum && e.difference.total() == e.samples as u64)
    {
        out.samples = e.samples;
        out.model = ReliabilityModel::EmpiricalJoint;
        let mut lo = 0.0;
        let mut hi = 0.0;
        for (a, b, n) in masses(&e.difference) {
            let w = n as f64 / e.samples as f64;
            if a >= -(buffer as f64) {
                lo += w;
                hi += w
            } else if b >= -(buffer as f64) {
                hi += w
            }
        }
        Some((lo as f32, hi as f32))
    } else if let (Some(a), Some(d)) = (incoming, outgoing) {
        out.samples = a.samples.min(d.samples);
        if out.samples >= minimum
            && a.histogram.total() == a.samples as u64
            && d.histogram.total() == d.samples as u64
        {
            out.model = ReliabilityModel::IndependentHistograms;
            Some(histogram_probability(&a.histogram, &d.histogram, buffer))
        } else {
            None
        }
    } else {
        None
    };
    if let Some((lo, hi)) = bounds {
        out.probability_lower_bound = Some(lo);
        out.probability_upper_bound = Some(hi);
        if (hi - lo).abs() < 1e-6 {
            out.success_probability = Some((lo + hi) / 2.0)
        }
        out.data_quality = history::quality(out.samples, minimum);
    }
    out
}
/// Empirical lookup has the same leakage guard as marginal lookups.
pub fn empirical_transfer<'a>(
    snapshot: &'a StatsSnapshot,
    key: &TransferStatsKey,
    route_date: chrono::NaiveDate,
) -> Option<&'a TransferStats> {
    if snapshot.history_until >= route_date {
        None
    } else {
        snapshot.transfers.get(key)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JourneyReliability {
    pub minimum_transfer_probability: Option<f32>,
    pub estimated_journey_success_probability: Option<f32>,
    pub model: &'static str,
}
pub fn journey_reliability(
    transfers: &[TransferReliability],
    cancellations: &[Option<CancellationStats>],
) -> JourneyReliability {
    let minimum = transfers
        .iter()
        .filter_map(|t| t.success_probability)
        .reduce(f32::min);
    let complete = transfers.iter().all(|t| t.success_probability.is_some())
        && cancellations.iter().all(Option::is_some)
        && !cancellations.is_empty();
    let probability = complete.then(|| {
        transfers
            .iter()
            .map(|t| t.success_probability.unwrap())
            .product::<f32>()
            * cancellations
                .iter()
                .map(|c| 1.0 - c.as_ref().unwrap().probability)
                .product::<f32>()
    });
    JourneyReliability {
        minimum_transfer_probability: minimum,
        estimated_journey_success_probability: probability,
        model: "independent_events",
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Flag {
    #[serde(rename = "type")]
    pub kind: String,
    pub severity: String,
    pub message_key: String,
    pub data: serde_json::Value,
}
fn flag(kind: &str, severity: &str, key: &str, data: serde_json::Value) -> Flag {
    Flag {
        kind: kind.into(),
        severity: severity.into(),
        message_key: key.into(),
        data,
    }
}
pub fn leg_flags(a: &Assessment, c: &ReliabilityConfig) -> Vec<Flag> {
    let mut out = Vec::new();
    if !a.statistics_available {
        out.push(flag(
            "NO_STATISTICS",
            "info",
            "statistics.unavailable",
            serde_json::json!({"history_rejected":a.history_rejected}),
        ));
    }
    if a.insufficient_samples > 0 || a.data_quality == Some(DataQuality::Low) {
        out.push(flag("LOW_STATISTICAL_SAMPLE","info","statistics.low_sample",serde_json::json!({"samples":a.insufficient_samples.max(a.arrival.as_ref().map_or(0,|s|s.samples))})));
    }
    if let Some(s) = a.arrival.as_ref().or(a.departure.as_ref()) {
        let p = s.histogram.probability_at_least(c.delay_warning_seconds);
        if p >= c.delay_warning_probability {
            out.push(flag("FREQUENT_DELAY","warning","delay.frequent",serde_json::json!({"probability":p,"seconds":c.delay_warning_seconds,"samples":s.samples})));
        }
        if s.p90_seconds >= c.delay_warning_seconds {
            out.push(flag(
                "HIGH_DELAY_RISK",
                "warning",
                "delay.high_risk",
                serde_json::json!({"p90_seconds":s.p90_seconds,"samples":s.samples}),
            ));
        }
    }
    if let Some(s) = &a.cancellation {
        if s.probability >= c.cancellation_warning_probability {
            out.push(flag(
                "HIGH_CANCELLATION_RATE",
                "warning",
                "cancellation.high_rate",
                serde_json::json!({"probability":s.probability,"samples":s.samples}),
            ));
        }
    }
    out
}
pub fn transfer_flags(t: &TransferReliability, c: &ReliabilityConfig) -> Vec<Flag> {
    let mut out = Vec::new();
    if t.usable_buffer_seconds <= 0 {
        out.push(flag(
            "TIGHT_TRANSFER",
            "warning",
            "transfer.tight",
            serde_json::json!({"usable_buffer_seconds":t.usable_buffer_seconds}),
        ));
    }
    if let Some(p) = t.success_probability {
        if p < c.transfer_warning_probability {
            out.push(flag("UNRELIABLE_TRANSFER",if p<c.transfer_critical_probability{"critical"}else{"warning"},"transfer.low_probability",serde_json::json!({"probability":p,"samples":t.samples,"scheduled_transfer_seconds":t.scheduled_transfer_seconds})));
        }
    } else {
        out.push(flag(
            "NO_STATISTICS",
            "info",
            "transfer.probability_unavailable",
            serde_json::json!({"samples":t.samples}),
        ));
    }
    if t.samples > 0 && t.samples < 50 {
        out.push(flag(
            "LOW_STATISTICAL_SAMPLE",
            "info",
            "statistics.low_sample",
            serde_json::json!({"samples":t.samples}),
        ));
    }
    out
}

pub mod backtest;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    fn key() -> StatKey {
        StatKey {
            product: 1,
            line: "X".into(),
            stop: 2,
            direction: "north".into(),
            weekday: 5,
            bucket: 50,
            level: 0,
        }
    }
    fn request() -> LookupRequest {
        LookupRequest {
            product: 1,
            line: "X".into(),
            stop: 2,
            direction: None,
            headsign: Some("North".into()),
            scheduled: Utc.with_ymd_and_hms(2026, 9, 18, 10, 30, 0).unwrap(),
        }
    }
    fn snapshot(n: usize) -> StatsSnapshot {
        let mut s = history::snapshot_from_rows(
            (0..n).map(|_| (key(), Some(300), Some(0), false)).collect(),
            20,
        );
        s.history_until = chrono::NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        s
    }
    fn stat(values: &[i32]) -> DelayStats {
        let s = history::snapshot_from_rows(
            values
                .iter()
                .map(|&v| (key(), Some(v), None, false))
                .collect(),
            20,
        );
        s.arrivals.values().next().unwrap().clone()
    }
    #[test]
    fn delta_histograms() {
        let a = stat(&[300; 20]);
        let d = stat(&[0; 20]);
        let c = ReliabilityConfig::default();
        assert_eq!(
            transfer_reliability(Some(&a), Some(&d), 300, 120, &c).success_probability,
            Some(0.0)
        );
        let a = stat(
            &(0..20)
                .map(|i| if i < 10 { 0 } else { 300 })
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            transfer_reliability(Some(&a), Some(&d), 300, 120, &c).success_probability,
            Some(0.5)
        );
    }
    #[test]
    fn censored_tails_do_not_claim_precision() {
        let a = stat(&[5000; 20]);
        let d = stat(&[6000; 20]);
        let t = transfer_reliability(Some(&a), Some(&d), 300, 120, &Default::default());
        assert_eq!(t.success_probability, None);
        assert_eq!(t.probability_lower_bound, Some(0.0));
        assert_eq!(t.probability_upper_bound, Some(1.0));
    }
    #[test]
    fn arrival_departure_cancellation_independent() {
        let mut s = snapshot(20);
        s.arrivals.clear();
        let k = hierarchy(
            &StatKey {
                line: "x".into(),
                ..key()
            },
            0,
        )
        .pop()
        .unwrap();
        s.cancellations.insert(
            cancellation_key(&k),
            CancellationStats {
                samples: 20,
                cancellations: 2,
                probability: 0.1,
                data_quality: DataQuality::Low,
            },
        );
        let a = assess_leg(&s, &request());
        assert!(a.statistics_available);
        assert!(a.arrival.is_none());
        assert!(a.departure.is_some());
        assert!(a.cancellation.is_some());
        let mut r = request();
        r.stop = i32::MIN;
        assert!(assess_leg(&s, &r).cancellation.is_some());
    }
    #[test]
    fn insufficiency_and_fallback() {
        let mut s = snapshot(19);
        let a = assess_leg(&s, &request());
        assert!(!a.statistics_available);
        assert_eq!(a.insufficient_samples, 19);
        assert!(leg_flags(&a, &Default::default())
            .iter()
            .any(|f| f.kind == "LOW_STATISTICAL_SAMPLE"));
        let broad = stat(&[0; 20]);
        let k = hierarchy(
            &StatKey {
                line: "x".into(),
                ..key()
            },
            0,
        )
        .pop()
        .unwrap();
        s.arrivals.insert(k, broad);
        assert!(assess_leg(&s, &request()).arrival.is_some());
    }
    #[test]
    fn timezones_dst_and_leakage() {
        let mut s = snapshot(20);
        let mut r = request();
        r.scheduled = Utc.with_ymd_and_hms(2026, 9, 17, 22, 30, 0).unwrap();
        assert!(!assess_leg(&s, &r).history_rejected);
        s.history_until = chrono::NaiveDate::from_ymd_opt(2026, 9, 18).unwrap();
        assert!(assess_leg(&s, &r).history_rejected);
        let tz: chrono_tz::Tz = s.timezone.parse().unwrap();
        for h in [0, 1] {
            let d = Utc
                .with_ymd_and_hms(2026, 10, 25, h, 30, 0)
                .unwrap()
                .with_timezone(&tz);
            assert_eq!(d.hour(), 2);
            assert_eq!(d.weekday().number_from_monday(), 7);
        }
    }
    #[test]
    fn direction_ambiguity_falls_back() {
        let mut s = snapshot(20);
        let mut k = StatKey {
            line: "x".into(),
            direction: "south".into(),
            ..key()
        };
        s.arrivals.insert(k.clone(), stat(&[0; 20]));
        let mut r = request();
        r.direction = Some("south".into());
        assert_eq!(resolve_direction(&s, &r, "x"), "");
        r.direction = Some("0".into());
        assert_eq!(resolve_direction(&s, &r, "x"), "north");
        k.direction = "unseen".into();
    }
    #[test]
    fn empirical_preferred_and_journey_missing() {
        let a = stat(&[300; 20]);
        let d = stat(&[0; 20]);
        let mut h = DelayHistogram::default();
        h.add(0, 20);
        let e = TransferStats {
            samples: 20,
            difference: h,
            data_quality: DataQuality::Low,
        };
        let t =
            transfer_with_empirical(Some(&a), Some(&d), Some(&e), 300, 120, &Default::default());
        assert_eq!(t.model, ReliabilityModel::EmpiricalJoint);
        assert_eq!(t.success_probability, Some(1.0));
        assert!(journey_reliability(&[t], &[None])
            .estimated_journey_success_probability
            .is_none());
    }
    #[test]
    fn calibration_rejects_overlap() {
        let train = chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        assert!(backtest::calibrate_csv(
            train,
            "date,predicted_probability,succeeded\n2025-12-31,0.8,true\n".as_bytes()
        )
        .is_err());
        let r = backtest::calibrate_csv(
            train,
            "date,predicted_probability,succeeded\n2026-01-01,0.5,true\n2026-01-02,0.5,false\n"
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(r.samples, 2);
        assert_eq!(r.brier_score, Some(0.25));
        assert_eq!(r.bins[5].observed_rate, Some(0.5));
    }
    #[test]
    fn invalid_thresholds_rejected() {
        let c = ReliabilityConfig {
            delay_warning_seconds: 4000,
            ..Default::default()
        };
        assert!(c.validate().is_err());
    }
}

mod indexed;
pub use indexed::RuntimeStats;
