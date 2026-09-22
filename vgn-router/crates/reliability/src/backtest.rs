//! Offline calibration of held-out observed transfers. `train_until` is inclusive;
//! each observation must occur strictly later, and snapshots must not cross it.
use crate::*;
use anyhow::{ensure, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub date: NaiveDate,
    pub predicted_probability: f32,
    pub succeeded: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CalibrationBin {
    pub lower: f32,
    pub upper: f32,
    pub samples: u32,
    pub predicted_mean: Option<f64>,
    pub observed_rate: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CalibrationReport {
    pub train_until: NaiveDate,
    pub samples: u32,
    pub brier_score: Option<f64>,
    pub bins: Vec<CalibrationBin>,
}
pub fn calibrate(
    train_until: NaiveDate,
    observations: &[Observation],
) -> Result<CalibrationReport> {
    let mut n = [0u32; 10];
    let mut predictions = [0.0f64; 10];
    let mut successes = [0u32; 10];
    let mut loss = 0.0;
    for o in observations {
        ensure!(
            o.date > train_until,
            "test observation must be strictly after training cutoff"
        );
        ensure!(
            o.predicted_probability.is_finite() && (0.0..=1.0).contains(&o.predicted_probability),
            "invalid predicted probability"
        );
        let b = ((o.predicted_probability * 10.0) as usize).min(9);
        n[b] += 1;
        predictions[b] += o.predicted_probability as f64;
        successes[b] += u32::from(o.succeeded);
        loss += (o.predicted_probability as f64 - f64::from(u8::from(o.succeeded))).powi(2);
    }
    let samples = observations.len() as u32;
    Ok(CalibrationReport {
        train_until,
        samples,
        brier_score: (samples > 0).then(|| loss / samples as f64),
        bins: (0..10)
            .map(|i| CalibrationBin {
                lower: i as f32 / 10.0,
                upper: (i + 1) as f32 / 10.0,
                samples: n[i],
                predicted_mean: (n[i] > 0).then(|| predictions[i] / n[i] as f64),
                observed_rate: (n[i] > 0).then(|| successes[i] as f64 / n[i] as f64),
            })
            .collect(),
    })
}
pub fn calibrate_csv(
    train_until: NaiveDate,
    reader: impl std::io::Read,
) -> Result<CalibrationReport> {
    let observations = csv::Reader::from_reader(reader)
        .deserialize::<Observation>()
        .collect::<std::result::Result<Vec<_>, _>>()?;
    calibrate(train_until, &observations)
}
/// Evaluate a model against actual held-out arrival/departure delays, rather than
/// accepting caller-provided predictions. Lookup requests provide scheduled times.
#[derive(Clone, Debug)]
pub struct TransferObservation {
    pub incoming: LookupRequest,
    pub outgoing: LookupRequest,
    pub arrival_delay_seconds: i32,
    pub departure_delay_seconds: i32,
    pub scheduled_transfer_seconds: u32,
    pub walking_seconds: u32,
}
pub fn evaluate(
    snapshot: &StatsSnapshot,
    train_until: NaiveDate,
    observations: &[TransferObservation],
    config: &ReliabilityConfig,
) -> Result<CalibrationReport> {
    ensure!(
        snapshot.history_until <= train_until,
        "snapshot exceeds training cutoff"
    );
    let tz: chrono_tz::Tz = snapshot
        .timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid timezone"))?;
    let mut predictions = Vec::new();
    for o in observations {
        let date = o.incoming.scheduled.with_timezone(&tz).date_naive();
        let outgoing_date = o.outgoing.scheduled.with_timezone(&tz).date_naive();
        ensure!(
            date > train_until && outgoing_date > train_until,
            "test observations overlap training"
        );
        let a = assess_leg_with_config(snapshot, &o.incoming, config);
        let d = assess_leg_with_config(snapshot, &o.outgoing, config);
        let t = transfer_reliability(
            a.arrival.as_ref(),
            d.departure.as_ref(),
            o.scheduled_transfer_seconds,
            o.walking_seconds,
            config,
        );
        if let Some(p) = t.success_probability {
            predictions.push(Observation {
                date,
                predicted_probability: p,
                succeeded: o.arrival_delay_seconds as i64 - o.departure_delay_seconds as i64
                    <= o.scheduled_transfer_seconds as i64 - o.walking_seconds as i64,
            });
        }
    }
    calibrate(train_until, &predictions)
}
