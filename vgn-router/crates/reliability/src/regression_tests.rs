use super::*;
use chrono::TimeZone;

fn key() -> StatKey {
    StatKey {
        product: 2,
        line: "u1".into(),
        stop: 2,
        direction: "north".into(),
        weekday: 5,
        bucket: 50,
        level: 0,
    }
}
fn request() -> LookupRequest {
    LookupRequest {
        product: 2,
        line: "U1".into(),
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
    s.generated_at = Utc.with_ymd_and_hms(2026, 9, 18, 1, 0, 0).unwrap();
    s
}
fn delay(n: u32, value: i32) -> DelayStats {
    let mut s = snapshot(20).arrivals.into_values().next().unwrap();
    s.samples = n;
    s.histogram = DelayHistogram::default();
    s.histogram.add(value, n);
    s.mean_seconds = value as f32;
    s.p50_seconds = value;
    s.p80_seconds = value;
    s.p90_seconds = value;
    s.p95_seconds = value;
    s.probability_60s = s.histogram.probability_at_least(60);
    s.probability_180s = s.histogram.probability_at_least(180);
    s.probability_300s = s.histogram.probability_at_least(300);
    s.probability_600s = s.histogram.probability_at_least(600);
    s.data_quality = history::quality(n, 20);
    s
}
fn cancellation(n: u32) -> CancellationStats {
    CancellationStats {
        samples: n,
        cancellations: 0,
        probability: 0.0,
        data_quality: history::quality(n, 20),
    }
}
fn parity(s: StatsSnapshot) -> Assessment {
    let expected = assess_leg(&s, &request());
    let actual = RuntimeStats::from_snapshot(s)
        .unwrap()
        .assess_leg(&request());
    assert_eq!(
        serde_json::to_value(&actual).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    actual
}

#[test]
fn prefers_broader_4368_over_narrow_36_independently() {
    let mut s = snapshot(36);
    let broad = hierarchy(&key(), 0).pop().unwrap();
    s.arrivals.insert(broad.clone(), delay(4368, 0));
    s.departures.insert(broad.clone(), delay(14017, 0));
    s.cancellations
        .insert(cancellation_key(&key()), cancellation(36));
    s.cancellations
        .insert(cancellation_key(&broad), cancellation(200));
    let a = parity(s);
    assert_eq!(a.arrival.as_ref().unwrap().samples, 4368);
    assert_eq!(a.departure.as_ref().unwrap().samples, 14017);
    assert_eq!(a.cancellation.as_ref().unwrap().samples, 200);
    assert!(!leg_flags(&a, &Default::default())
        .iter()
        .any(|f| f.kind == "LOW_STATISTICAL_SAMPLE" || f.kind == "NO_STATISTICS"));
}
#[test]
fn retains_narrow_minimum_when_preferred_unavailable() {
    let a = parity(snapshot(36));
    assert_eq!(a.arrival.as_ref().unwrap().samples, 36);
    let flags = leg_flags(&a, &Default::default());
    let low: Vec<_> = flags
        .iter()
        .filter(|f| f.kind == "LOW_STATISTICAL_SAMPLE")
        .collect();
    assert_eq!(low.len(), 2);
    assert!(low.iter().all(|f| f.data["samples"] == 36));
    assert_eq!(low[0].data["dimension"], "arrival");
    assert_eq!(low[1].data["dimension"], "departure");
}
#[test]
fn skipped_insufficient_cohort_does_not_warn_after_good_fallback() {
    let mut s = snapshot(19);
    let broad = hierarchy(&key(), 0).pop().unwrap();
    s.arrivals.insert(broad.clone(), delay(4368, 0));
    s.departures.insert(broad, delay(4368, 0));
    let a = parity(s);
    assert_eq!(a.insufficient_samples, 19);
    assert!(!leg_flags(&a, &Default::default())
        .iter()
        .any(|f| f.kind == "LOW_STATISTICAL_SAMPLE"));
}
#[test]
fn low_flags_report_selected_dimension_not_unrelated_arrival() {
    let a = Assessment {
        arrival: Some(delay(4368, 0)),
        departure: Some(delay(36, 0)),
        cancellation: Some(cancellation(25)),
        ..Default::default()
    };
    let flags = leg_flags(&a, &Default::default());
    assert!(!flags.iter().any(|f| f.kind == "NO_STATISTICS"));
    let low: Vec<_> = flags
        .iter()
        .filter(|f| f.kind == "LOW_STATISTICAL_SAMPLE")
        .collect();
    assert_eq!(low.len(), 2);
    assert_eq!(
        low[0].data,
        serde_json::json!({"dimension":"departure","samples":36})
    );
    assert_eq!(
        low[1].data,
        serde_json::json!({"dimension":"cancellation","samples":25})
    );
}
#[test]
fn many_samples_with_censored_bounds_get_range_flag() {
    let a = delay(14017, 5000);
    let d = delay(4368, 6000);
    let t = transfer_reliability(Some(&a), Some(&d), 300, 120, &Default::default());
    assert_eq!(t.samples, 4368);
    assert_eq!(t.model, ReliabilityModel::IndependentHistograms);
    assert!(t.success_probability.is_none());
    let flags = transfer_flags(&t, &Default::default());
    assert!(!flags.iter().any(|f| f.kind == "NO_STATISTICS"));
    let range = flags
        .iter()
        .find(|f| f.kind == "TRANSFER_PROBABILITY_RANGE")
        .unwrap();
    assert_eq!(range.data["samples"], 4368);
    assert_eq!(range.data["probability_lower_bound"], 0.0);
    assert_eq!(range.data["probability_upper_bound"], 1.0);
}
#[test]
fn journey_propagates_bounds_but_never_invents_point() {
    let mut t = transfer_reliability(
        Some(&delay(200, 5000)),
        Some(&delay(200, 6000)),
        300,
        120,
        &Default::default(),
    );
    t.probability_lower_bound = Some(0.7);
    t.probability_upper_bound = Some(0.8);
    let c = CancellationStats {
        samples: 200,
        cancellations: 20,
        probability: 0.1,
        data_quality: DataQuality::High,
    };
    let j = journey_reliability(std::slice::from_ref(&t), &[Some(c)]);
    assert!(j.estimated_journey_success_probability.is_none());
    assert!((j.probability_lower_bound.unwrap() - 0.63).abs() < 1e-6);
    assert!((j.probability_upper_bound.unwrap() - 0.72).abs() < 1e-6);
    assert_eq!(j.model, "independent_events");
    let missing = journey_reliability(&[t], &[None]);
    assert!(missing.probability_lower_bound.is_none() && missing.probability_upper_bound.is_none());
}
#[test]
fn preferred_samples_config_default_and_validation() {
    let c: ReliabilityConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(c.preferred_samples, 50);
    assert!(ReliabilityConfig {
        minimum_samples: 60,
        ..Default::default()
    }
    .validate()
    .is_err());
    let s = snapshot(36);
    let c = ReliabilityConfig {
        preferred_samples: 100,
        ..Default::default()
    };
    let a = assess_leg_with_config(&s, &request(), &c);
    assert_eq!(a.arrival.unwrap().samples, 36);
}
