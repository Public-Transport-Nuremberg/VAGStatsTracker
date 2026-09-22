//! Bounded historical aggregates; no database access is needed after loading a snapshot.
use anyhow::{ensure, Context, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    time::Duration as StdDuration,
};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

pub const HISTOGRAM_BINS: usize = 130;
pub const SCHEMA_VERSION: u16 = 1;
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct StatKey {
    pub product: u8,
    pub line: String,
    pub stop: i32,
    pub direction: String,
    pub weekday: u8,
    pub bucket: u8,
    pub level: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CancellationKey {
    pub product: u8,
    pub line: String,
    pub direction: String,
    pub weekday: u8,
    pub bucket: u8,
    pub level: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DelayHistogram {
    pub underflow: u32,
    #[serde(with = "serde_big_array::BigArray")]
    pub bins: [u32; HISTOGRAM_BINS],
    pub overflow: u32,
}
impl Default for DelayHistogram {
    fn default() -> Self {
        Self {
            underflow: 0,
            bins: [0; HISTOGRAM_BINS],
            overflow: 0,
        }
    }
}
impl DelayHistogram {
    pub fn total(&self) -> u64 {
        self.underflow as u64
            + self.overflow as u64
            + self.bins.iter().map(|&n| n as u64).sum::<u64>()
    }
    pub fn add(&mut self, seconds: i32, count: u32) {
        if seconds < -300 {
            self.underflow += count
        } else if seconds >= 3600 {
            self.overflow += count
        } else {
            self.bins[((seconds + 300) / 30) as usize] += count
        }
    }
    /// Exact for aligned thresholds in -300..=3600; a conservative lower bound
    /// outside that range or between bin boundaries. Tails are censored.
    pub fn probability_at_least(&self, seconds: i32) -> f32 {
        let n = self.total();
        if n == 0 {
            return 0.0;
        }
        let k = self
            .bins
            .iter()
            .enumerate()
            .filter(|(i, _)| -300 + (*i as i32) * 30 >= seconds)
            .map(|(_, x)| *x as u64)
            .sum::<u64>();
        let tail = if seconds <= 3600 {
            self.overflow as u64
        } else {
            0
        };
        (k + tail) as f32 / n as f32
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataQuality {
    #[default]
    Insufficient,
    Low,
    Medium,
    High,
}
pub fn quality(n: u32, min: u32) -> DataQuality {
    if n < min.max(20) {
        DataQuality::Insufficient
    } else if n < 50 {
        DataQuality::Low
    } else if n < 200 {
        DataQuality::Medium
    } else {
        DataQuality::High
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DelayStats {
    pub samples: u32,
    pub mean_seconds: f32,
    pub p50_seconds: i32,
    pub p80_seconds: i32,
    pub p90_seconds: i32,
    pub p95_seconds: i32,
    pub probability_60s: f32,
    pub probability_180s: f32,
    pub probability_300s: f32,
    pub probability_600s: f32,
    pub histogram: DelayHistogram,
    pub data_quality: DataQuality,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancellationStats {
    pub samples: u32,
    pub cancellations: u32,
    pub probability: f32,
    pub data_quality: DataQuality,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct TransferStatsKey {
    pub stop: i32,
    pub incoming_product: u8,
    pub incoming_line: String,
    pub incoming_direction: String,
    pub outgoing_product: u8,
    pub outgoing_line: String,
    pub outgoing_direction: String,
    pub weekday: u8,
    pub time_bucket: u8,
}
/// Histogram describes outgoing departure delay minus incoming arrival delay.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferStats {
    pub samples: u32,
    pub difference: DelayHistogram,
    pub data_quality: DataQuality,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StatsSnapshot {
    pub schema_version: u16,
    pub generated_at: DateTime<Utc>,
    pub history_from: NaiveDate,
    pub history_until: NaiveDate,
    pub timezone: String,
    pub holidays: Vec<NaiveDate>,
    pub minimum_samples: u32,
    pub arrivals: HashMap<StatKey, DelayStats>,
    pub departures: HashMap<StatKey, DelayStats>,
    pub cancellations: HashMap<CancellationKey, CancellationStats>,
    pub transfers: HashMap<TransferStatsKey, TransferStats>,
}
impl Default for StatsSnapshot {
    fn default() -> Self {
        let today = Utc::now().date_naive();
        Self {
            schema_version: SCHEMA_VERSION,
            generated_at: Utc::now(),
            history_from: today - Duration::days(90),
            history_until: today - Duration::days(1),
            timezone: "Europe/Berlin".into(),
            holidays: vec![],
            minimum_samples: 20,
            arrivals: HashMap::new(),
            departures: HashMap::new(),
            cancellations: HashMap::new(),
            transfers: HashMap::new(),
        }
    }
}
impl StatsSnapshot {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == SCHEMA_VERSION,
            "unsupported statistics schema"
        );
        let tz: chrono_tz::Tz = self
            .timezone
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid timezone"))?;
        ensure!(
            self.history_from <= self.history_until
                && self.history_until < self.generated_at.with_timezone(&tz).date_naive(),
            "invalid history date range"
        );
        ensure!(
            self.minimum_samples >= 20,
            "minimum sample count must be >=20"
        );
        for (k, s) in self.arrivals.iter().chain(self.departures.iter()) {
            validate_key(&k.line, &k.direction, k.weekday, k.bucket, k.level)?;
            ensure!(
                s.samples > 0
                    && s.histogram.total() == s.samples as u64
                    && s.mean_seconds.is_finite(),
                "invalid delay counts/mean"
            );
            ensure!(
                s.p50_seconds <= s.p80_seconds
                    && s.p80_seconds <= s.p90_seconds
                    && s.p90_seconds <= s.p95_seconds,
                "unordered quantiles"
            );
            let ps = [
                s.probability_60s,
                s.probability_180s,
                s.probability_300s,
                s.probability_600s,
            ];
            ensure!(
                ps.iter().all(|&p| valid_probability(p)) && ps.windows(2).all(|p| p[0] >= p[1]),
                "invalid delay probabilities"
            );
            ensure!(
                ps.iter().zip([60, 180, 300, 600]).all(|(&p, t)| (p - s
                    .histogram
                    .probability_at_least(t))
                .abs()
                    < 0.00001),
                "delay probability disagrees with histogram"
            );
            ensure!(
                s.data_quality == quality(s.samples, self.minimum_samples),
                "incorrect data quality"
            );
        }
        for (k, s) in &self.cancellations {
            validate_key(&k.line, &k.direction, k.weekday, k.bucket, k.level)?;
            ensure!(
                s.samples > 0
                    && s.cancellations <= s.samples
                    && valid_probability(s.probability)
                    && (s.probability - s.cancellations as f32 / s.samples as f32).abs() < 0.00001
                    && s.data_quality == quality(s.samples, self.minimum_samples),
                "invalid cancellation statistic"
            );
        }
        for (k, s) in &self.transfers {
            ensure!(
                !k.incoming_line.is_empty()
                    && !k.outgoing_line.is_empty()
                    && normalize(&k.incoming_line) == k.incoming_line
                    && normalize(&k.outgoing_line) == k.outgoing_line
                    && normalize(&k.incoming_direction) == k.incoming_direction
                    && normalize(&k.outgoing_direction) == k.outgoing_direction,
                "non-normalized transfer key"
            );
            ensure!(
                k.weekday >= 1
                    && k.weekday <= 7
                    && k.time_bucket < 96
                    && s.samples > 0
                    && s.difference.total() == s.samples as u64
                    && s.data_quality == quality(s.samples, self.minimum_samples),
                "invalid transfer statistic"
            );
        }
        Ok(())
    }
}
fn valid_probability(p: f32) -> bool {
    p.is_finite() && (0.0..=1.0).contains(&p)
}
fn validate_key(line: &str, direction: &str, weekday: u8, bucket: u8, level: u8) -> Result<()> {
    ensure!(
        !line.is_empty() && normalize(line) == line && normalize(direction) == direction,
        "non-normalized statistic key"
    );
    ensure!(
        match level {
            0 => (1..=7).contains(&weekday) && bucket < 96,
            1 => (1..=7).contains(&weekday) && bucket < 24,
            2 => weekday <= 2 && bucket == 0,
            3 => weekday <= 2 && bucket == 0 && direction.is_empty(),
            4 => weekday == 0 && bucket == 0 && direction.is_empty(),
            _ => false,
        },
        "invalid fallback dimensions"
    );
    Ok(())
}
pub fn normalize(s: &str) -> String {
    s.replace(['ß', 'ẞ'], "ss")
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn day_type(date: NaiveDate, holidays: &[NaiveDate]) -> u8 {
    if holidays.contains(&date) || date.weekday().number_from_monday() == 7 {
        2
    } else if date.weekday().number_from_monday() == 6 {
        1
    } else {
        0
    }
}
pub fn hierarchy(base: &StatKey, day_type: u8) -> Vec<StatKey> {
    let mut out = Vec::with_capacity(5);
    if !base.direction.is_empty() {
        if base.bucket < 96 {
            let mut k = base.clone();
            k.level = 0;
            out.push(k.clone());
            k.level = 1;
            k.bucket /= 4;
            out.push(k);
        }
        let mut k = base.clone();
        k.level = 2;
        k.weekday = day_type;
        k.bucket = 0;
        out.push(k);
    }
    let mut k = base.clone();
    k.direction.clear();
    k.level = 3;
    k.weekday = day_type;
    k.bucket = 0;
    out.push(k.clone());
    k.level = 4;
    k.weekday = 0;
    out.push(k);
    out
}
pub fn cancellation_key(k: &StatKey) -> CancellationKey {
    CancellationKey {
        product: k.product,
        line: k.line.clone(),
        direction: k.direction.clone(),
        weekday: k.weekday,
        bucket: k.bucket,
        level: k.level,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DelayUnit {
    Seconds,
    Minutes,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct HistoryConfig {
    pub url: String,
    pub database: String,
    pub user: String,
    pub password: String,
    pub delay_unit: DelayUnit,
    pub min_samples: u32,
    pub timeout_seconds: u64,
    pub timezone: String,
    pub holidays: Vec<NaiveDate>,
    pub primary_days: u32,
    pub fallback_days: u32,
    pub recent_days: u32,
    pub recent_weight: u32,
    pub product_map: HashMap<i16, u8>,
}
impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            url: "http://localhost:8123".into(),
            database: "default".into(),
            user: "default".into(),
            password: String::new(),
            delay_unit: DelayUnit::Seconds,
            min_samples: 20,
            timeout_seconds: 300,
            timezone: "Europe/Berlin".into(),
            holidays: vec![],
            primary_days: 30,
            fallback_days: 90,
            recent_days: 7,
            recent_weight: 4,
            product_map: HashMap::new(),
        }
    }
}
impl HistoryConfig {
    pub fn apply_env(&mut self) -> Result<()> {
        for (var, target) in [
            ("CH_URL", &mut self.url),
            ("CH_DATABASE", &mut self.database),
            ("CH_USER", &mut self.user),
            ("CH_PASSWORD", &mut self.password),
        ] {
            if let Ok(v) = std::env::var(var) {
                *target = v;
            }
        }
        if std::env::var_os("CH_URL").is_none() {
            if let Ok(host) = std::env::var("CH_HOST") {
                let scheme_host = if host.contains("://") {
                    host
                } else {
                    format!("http://{host}")
                };
                let mut url = reqwest::Url::parse(&scheme_host).context("invalid CH_HOST")?;
                if url.port().is_none() {
                    if let Ok(port) = std::env::var("CH_PORT") {
                        url.set_port(Some(port.parse().context("invalid CH_PORT")?))
                            .map_err(|_| anyhow::anyhow!("CH_HOST cannot accept a port"))?;
                    }
                }
                self.url = url.to_string().trim_end_matches('/').to_owned();
            }
        }
        if let Ok(v) = std::env::var("HISTORY_DELAY_UNIT") {
            self.delay_unit = match v.as_str() {
                "seconds" => DelayUnit::Seconds,
                "minutes" => DelayUnit::Minutes,
                _ => anyhow::bail!("HISTORY_DELAY_UNIT must be seconds or minutes"),
            }
        }
        Ok(())
    }
    pub fn set_product_map_toml(&mut self, text: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct Map {
            history_product: HashMap<String, String>,
        }
        let m: Map = toml::from_str(text)?;
        self.product_map = m
            .history_product
            .into_iter()
            .map(|(k, v)| {
                Ok((
                    k.parse::<i16>()?,
                    product_id(&v).context("unknown historical product name")?,
                ))
            })
            .collect::<Result<_>>()?;
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(self.min_samples >= 20, "min_samples must be at least 20");
        ensure!(
            self.primary_days > 0
                && self.primary_days <= self.fallback_days
                && self.fallback_days <= 1826,
            "history window must be positive and at most five years"
        );
        ensure!(
            self.recent_days > 0
                && self.recent_days <= self.primary_days
                && (1..=20).contains(&self.recent_weight),
            "recent history window/weight must fit inside the primary window"
        );
        ensure!(
            !self.product_map.is_empty(),
            "historical product mapping must be configured"
        );
        self.timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| anyhow::anyhow!("invalid history timezone"))?;
        Ok(())
    }
}
pub fn product_id(name: &str) -> Option<u8> {
    match name {
        "bus" => Some(1),
        "ubahn" => Some(2),
        "tram" => Some(3),
        "sbahn" => Some(4),
        "rbahn" => Some(5),
        _ => None,
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoricalStop {
    pub vgn_id: i32,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
}
#[derive(Default, Serialize, Deserialize)]
struct Acc {
    /// Sparse while building: most keys only observe a small subset of the 130 final bins.
    bins: Vec<(i32, u32)>,
    samples: u32,
    observations: u32,
    sum: f64,
    min: Option<i32>,
    max: Option<i32>,
}
impl Acc {
    fn add(&mut self, bin: i32, n: u32, sum: f64, min: i32, max: i32) -> Result<()> {
        self.add_weighted(bin, n, sum, min, max, 1)
    }
    fn add_weighted(
        &mut self,
        bin: i32,
        n: u32,
        sum: f64,
        min: i32,
        max: i32,
        weight: u32,
    ) -> Result<()> {
        self.observations = self
            .observations
            .checked_add(n)
            .context("observation count exceeds u32")?;
        let weighted_n = n
            .checked_mul(weight)
            .context("weighted histogram count exceeds u32")?;
        self.samples = self
            .samples
            .checked_add(weighted_n)
            .context("histogram count exceeds u32")?;
        if let Some((_, count)) = self.bins.iter_mut().find(|(value, _)| *value == bin) {
            *count = count
                .checked_add(weighted_n)
                .context("histogram bin count exceeds u32")?;
        } else {
            self.bins.push((bin, weighted_n));
        }
        self.sum += sum * weight as f64;
        self.min = Some(self.min.unwrap_or(min).min(min));
        self.max = Some(self.max.unwrap_or(max).max(max));
        Ok(())
    }
    fn observations(&self) -> u64 {
        self.observations as u64
    }
    fn finish(self, minimum: u32) -> DelayStats {
        let n = self.samples;
        let mut histogram = DelayHistogram::default();
        for (bin, count) in self.bins {
            histogram.add(bin, count);
        }
        let q = |p: f64| {
            let rank = (p * n as f64).ceil() as u64;
            let mut acc = histogram.underflow as u64;
            if acc >= rank {
                return self.min.unwrap_or(-301);
            }
            for (i, &c) in histogram.bins.iter().enumerate() {
                acc += c as u64;
                if acc >= rank {
                    return -300 + i as i32 * 30;
                }
            }
            self.max.unwrap_or(3600)
        };
        DelayStats {
            samples: n,
            mean_seconds: (self.sum / n as f64) as f32,
            p50_seconds: q(0.50),
            p80_seconds: q(0.80),
            p90_seconds: q(0.90),
            p95_seconds: q(0.95),
            probability_60s: histogram.probability_at_least(60),
            probability_180s: histogram.probability_at_least(180),
            probability_300s: histogram.probability_at_least(300),
            probability_600s: histogram.probability_at_least(600),
            histogram,
            data_quality: quality(n, minimum),
        }
    }
}
/// Test/offline helper. Each row is one stop observation; cancellation is deliberately not
/// inferred here, because a trip may have many stop observations.
pub fn snapshot_from_rows(
    rows: Vec<(StatKey, Option<i32>, Option<i32>, bool)>,
    minimum: u32,
) -> StatsSnapshot {
    let mut a: HashMap<StatKey, Acc> = HashMap::new();
    let mut d: HashMap<StatKey, Acc> = HashMap::new();
    for (mut k, ad, dd, _) in rows {
        k.line = normalize(&k.line);
        k.direction = normalize(&k.direction);
        let dt = if k.weekday == 7 {
            2
        } else if k.weekday == 6 {
            1
        } else {
            0
        };
        for key in hierarchy(&k, dt) {
            if let Some(v) = ad {
                a.entry(key.clone())
                    .or_default()
                    .add(v, 1, v as f64, v, v)
                    .unwrap()
            }
            if let Some(v) = dd {
                d.entry(key).or_default().add(v, 1, v as f64, v, v).unwrap()
            }
        }
    }
    StatsSnapshot {
        minimum_samples: minimum.max(20),
        arrivals: a.into_iter().map(|(k, v)| (k, v.finish(minimum))).collect(),
        departures: d.into_iter().map(|(k, v)| (k, v.finish(minimum))).collect(),
        ..Default::default()
    }
}

mod clickhouse_source;
pub use clickhouse_source::{
    aggregate_query, build, build_until, build_until_resumable, cancellation_query, fetch_stops,
    remove_checkpoint,
};

#[cfg(test)]
mod tests {
    use super::*;
    fn key() -> StatKey {
        StatKey {
            product: 1,
            line: "X".into(),
            stop: 2,
            direction: "Nürnberg—Hbf".into(),
            weekday: 1,
            bucket: 50,
            level: 0,
        }
    }
    #[test]
    fn normalization_unicode_and_punctuation() {
        assert_eq!(
            normalize("  STRAẞE, NürNberg—Hbf  "),
            "strasse nurnberg hbf"
        );
        assert_eq!(normalize("Nu\u{308}rnberg"), normalize("Nürnberg"));
    }
    #[test]
    fn exact_hierarchy() {
        let keys = hierarchy(&key(), 0);
        assert_eq!(
            keys.iter()
                .map(|k| (k.level, k.weekday, k.bucket))
                .collect::<Vec<_>>(),
            vec![(0, 1, 50), (1, 1, 12), (2, 0, 0), (3, 0, 0), (4, 0, 0)]
        );
        assert!(keys[3].direction.is_empty());
        let mut k = key();
        k.direction.clear();
        assert_eq!(hierarchy(&k, 2).len(), 2);
        k.bucket = 255;
        k.direction = "north".into();
        assert_eq!(hierarchy(&k, 0).len(), 3);
    }
    #[test]
    fn bins_tails_and_i32_quantiles() {
        let mut h = DelayHistogram::default();
        for v in [-301, -300, -1, 0, 3599, 3600, 100000] {
            h.add(v, 1)
        }
        assert_eq!(h.total(), 7);
        assert_eq!(h.underflow, 1);
        assert_eq!(h.overflow, 2);
        assert_eq!(h.bins[9], 1);
        let mut a = Acc::default();
        a.add(100000, 20, 2000000.0, 100000, 100000).unwrap();
        let s = a.finish(20);
        assert_eq!(s.p95_seconds, 100000);
        assert_eq!(s.data_quality, DataQuality::Low);
    }
    #[test]
    fn stop_rows_never_infer_trip_cancellations() {
        let s = snapshot_from_rows(
            (0..40).map(|_| (key(), Some(0), Some(30), true)).collect(),
            20,
        );
        assert!(s.cancellations.is_empty());
        assert_eq!(s.arrivals.len(), 5);
        s.validate().unwrap();
    }
    #[test]
    fn strict_snapshot_validation() {
        let mut s = snapshot_from_rows(vec![(key(), Some(0), None, false)], 20);
        s.validate().unwrap();
        s.schema_version = 99;
        assert!(s.validate().is_err());
        s.schema_version = 1;
        s.arrivals.values_mut().next().unwrap().histogram.overflow += 1;
        assert!(s.validate().is_err());
    }
    #[test]
    fn holiday_dates_and_thresholds() {
        let d = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        assert_eq!(day_type(d, &[d]), 2);
        assert_eq!(day_type(d, &[]), 0);
        assert_eq!(quality(19, 20), DataQuality::Insufficient);
        assert_eq!(quality(20, 20), DataQuality::Low);
        assert_eq!(quality(50, 20), DataQuality::Medium);
        assert_eq!(quality(200, 20), DataQuality::High);
    }
    #[test]
    fn product_mapping_independent() {
        let mut c = HistoryConfig::default();
        c.set_product_map_toml("[history_product]\n\"7\"=\"tram\"\n")
            .unwrap();
        assert_eq!(c.product_map[&7], 3);
        assert!(!c.product_map.contains_key(&3));
    }
}
