//! RAM representation with interned line/direction text and compact numeric keys.
//! Conversion consumes the serialized snapshot, moving each histogram exactly once.
use crate::{empty, Assessment, LookupRequest, ReliabilityConfig};
use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, NaiveDate, Timelike, Utc};
use history::{
    day_type, normalize, CancellationKey, CancellationStats, DelayStats, StatKey, StatsSnapshot,
    TransferStats, TransferStatsKey,
};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct NumericStatKey {
    product: u8,
    line: u32,
    stop: i32,
    direction: u32,
    weekday: u8,
    bucket: u8,
    level: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct NumericCancellationKey {
    product: u8,
    line: u32,
    direction: u32,
    weekday: u8,
    bucket: u8,
    level: u8,
}
impl From<NumericStatKey> for NumericCancellationKey {
    fn from(k: NumericStatKey) -> Self {
        Self {
            product: k.product,
            line: k.line,
            direction: k.direction,
            weekday: k.weekday,
            bucket: k.bucket,
            level: k.level,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct NumericTransferKey {
    stop: i32,
    incoming_product: u8,
    incoming_line: u32,
    incoming_direction: u32,
    outgoing_product: u8,
    outgoing_line: u32,
    outgoing_direction: u32,
    weekday: u8,
    time_bucket: u8,
}
#[derive(Debug)]
struct Interner {
    ids: HashMap<String, u32>,
}
impl Interner {
    fn new() -> Self {
        Self {
            ids: HashMap::from([(String::new(), 0)]),
        }
    }
    fn intern(&mut self, text: String) -> Result<u32> {
        if let Some(&id) = self.ids.get(&text) {
            return Ok(id);
        }
        let id = self
            .ids
            .len()
            .try_into()
            .context("too many interned statistics strings")?;
        self.ids.insert(text, id);
        Ok(id)
    }
    fn id(&self, text: &str) -> Option<u32> {
        self.ids.get(text).copied()
    }
    fn stat_key(&mut self, k: StatKey) -> Result<NumericStatKey> {
        Ok(NumericStatKey {
            product: k.product,
            line: self.intern(k.line)?,
            stop: k.stop,
            direction: self.intern(k.direction)?,
            weekday: k.weekday,
            bucket: k.bucket,
            level: k.level,
        })
    }
    fn cancellation_key(&mut self, k: CancellationKey) -> Result<NumericCancellationKey> {
        Ok(NumericCancellationKey {
            product: k.product,
            line: self.intern(k.line)?,
            direction: self.intern(k.direction)?,
            weekday: k.weekday,
            bucket: k.bucket,
            level: k.level,
        })
    }
    fn transfer_key(&mut self, k: TransferStatsKey) -> Result<NumericTransferKey> {
        Ok(NumericTransferKey {
            stop: k.stop,
            incoming_product: k.incoming_product,
            incoming_line: self.intern(k.incoming_line)?,
            incoming_direction: self.intern(k.incoming_direction)?,
            outgoing_product: k.outgoing_product,
            outgoing_line: self.intern(k.outgoing_line)?,
            outgoing_direction: self.intern(k.outgoing_direction)?,
            weekday: k.weekday,
            time_bucket: k.time_bucket,
        })
    }
}
/// An immutable, shareable runtime snapshot. Wire-format strings are discarded
/// after interning; every marginal/cancellation/transfer lookup key is numeric.
#[derive(Debug)]
pub struct RuntimeStats {
    pub schema_version: u16,
    pub generated_at: DateTime<Utc>,
    pub history_from: NaiveDate,
    pub history_until: NaiveDate,
    pub timezone: String,
    pub holidays: Vec<NaiveDate>,
    pub minimum_samples: u32,
    timezone_parsed: chrono_tz::Tz,
    strings: Interner,
    arrivals: HashMap<NumericStatKey, DelayStats>,
    departures: HashMap<NumericStatKey, DelayStats>,
    cancellations: HashMap<NumericCancellationKey, CancellationStats>,
    transfers: HashMap<NumericTransferKey, TransferStats>,
}
fn hierarchy(k: NumericStatKey, day_type: u8) -> [NumericStatKey; 5] {
    [
        NumericStatKey { level: 0, ..k },
        NumericStatKey {
            level: 1,
            bucket: k.bucket / 4,
            ..k
        },
        NumericStatKey {
            level: 2,
            weekday: day_type,
            bucket: 0,
            ..k
        },
        NumericStatKey {
            level: 3,
            direction: 0,
            weekday: day_type,
            bucket: 0,
            ..k
        },
        NumericStatKey {
            level: 4,
            direction: 0,
            weekday: 0,
            bucket: 0,
            ..k
        },
    ]
}
fn usable(k: &NumericStatKey) -> bool {
    k.level >= 3
        || k.direction != 0
            && (k.level >= 2
                || if k.level == 0 {
                    k.bucket < 96
                } else {
                    k.bucket < 24
                })
}
impl RuntimeStats {
    pub fn from_snapshot(snapshot: StatsSnapshot) -> Result<Self> {
        snapshot.validate()?;
        let StatsSnapshot {
            schema_version,
            generated_at,
            history_from,
            history_until,
            timezone,
            holidays,
            minimum_samples,
            arrivals,
            departures,
            cancellations,
            transfers,
        } = snapshot;
        let timezone_parsed = timezone
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid statistics timezone"))?;
        let mut strings = Interner::new();
        let arrivals = arrivals
            .into_iter()
            .map(|(k, v)| Ok((strings.stat_key(k)?, v)))
            .collect::<Result<_>>()?;
        let departures = departures
            .into_iter()
            .map(|(k, v)| Ok((strings.stat_key(k)?, v)))
            .collect::<Result<_>>()?;
        let cancellations = cancellations
            .into_iter()
            .map(|(k, v)| Ok((strings.cancellation_key(k)?, v)))
            .collect::<Result<_>>()?;
        let transfers = transfers
            .into_iter()
            .map(|(k, v)| Ok((strings.transfer_key(k)?, v)))
            .collect::<Result<_>>()?;
        Ok(Self {
            schema_version,
            generated_at,
            history_from,
            history_until,
            timezone,
            holidays,
            minimum_samples,
            timezone_parsed,
            strings,
            arrivals,
            departures,
            cancellations,
            transfers,
        })
    }
    /// Counts are useful for reload telemetry without exposing runtime key details.
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        (
            self.arrivals.len(),
            self.departures.len(),
            self.cancellations.len(),
            self.transfers.len(),
        )
    }
    pub fn interned_strings(&self) -> usize {
        self.strings.ids.len()
    }
    pub fn assess_leg(&self, request: &LookupRequest) -> Assessment {
        self.assess_leg_with_config(
            request,
            &ReliabilityConfig {
                minimum_samples: self.minimum_samples,
                ..Default::default()
            },
        )
    }
    pub fn assess_leg_with_config(&self, r: &LookupRequest, c: &ReliabilityConfig) -> Assessment {
        let local = r.scheduled.with_timezone(&self.timezone_parsed);
        if self.history_until >= local.date_naive() {
            return empty(true);
        }
        let Some(line) = self.strings.id(&normalize(&r.line)) else {
            return empty(false);
        };
        let dt = day_type(local.date_naive(), &self.holidays);
        let mut base = NumericStatKey {
            product: r.product,
            line,
            stop: r.stop,
            direction: 0,
            weekday: local.weekday().number_from_monday() as u8,
            bucket: ((local.hour() * 60 + local.minute()) / 15) as u8,
            level: 0,
        };
        // At most two boundary strings are normalized. All candidate and fallback
        // checks below use numeric keys with no string clones or heap vectors.
        let mut direction = None;
        let mut ambiguous = false;
        for text in r.direction.iter().chain(r.headsign.iter()) {
            let Some(id) = self.strings.id(&normalize(text)).filter(|&id| id != 0) else {
                continue;
            };
            if direction == Some(id) {
                continue;
            }
            let candidate = NumericStatKey {
                direction: id,
                ..base
            };
            if hierarchy(candidate, dt)[..3]
                .iter()
                .filter(|k| usable(k))
                .any(|k| {
                    self.arrivals.contains_key(k)
                        || self.departures.contains_key(k)
                        || self.cancellations.contains_key(&(*k).into())
                })
            {
                if direction.is_some() {
                    ambiguous = true;
                    break;
                }
                direction = Some(id);
            }
        }
        if !ambiguous {
            base.direction = direction.unwrap_or(0)
        }
        let keys = hierarchy(base, dt);
        let minimum = c.minimum_samples.max(self.minimum_samples).max(20);
        let mut insufficient_samples = 0;
        let mut delay = |map: &HashMap<NumericStatKey, DelayStats>| {
            for k in keys.iter().filter(|k| usable(k)) {
                if let Some(s) = map.get(k) {
                    if s.samples >= minimum {
                        return Some(s.clone());
                    }
                    insufficient_samples = insufficient_samples.max(s.samples)
                }
            }
            None
        };
        let arrival = delay(&self.arrivals);
        let departure = delay(&self.departures);
        let mut cancellation = None;
        for k in keys.iter().filter(|k| usable(k)) {
            if let Some(s) = self.cancellations.get(&(*k).into()) {
                if s.samples >= minimum {
                    cancellation = Some(s.clone());
                    break;
                }
                insufficient_samples = insufficient_samples.max(s.samples)
            }
        }
        let data_quality = arrival
            .as_ref()
            .map(|s| s.data_quality)
            .or_else(|| departure.as_ref().map(|s| s.data_quality))
            .or_else(|| cancellation.as_ref().map(|s| s.data_quality));
        Assessment {
            statistics_available: arrival.is_some()
                || departure.is_some()
                || cancellation.is_some(),
            arrival,
            departure,
            cancellation,
            data_quality,
            insufficient_samples,
            history_rejected: false,
        }
    }
    pub fn empirical_transfer(
        &self,
        key: &TransferStatsKey,
        route_date: NaiveDate,
    ) -> Option<&TransferStats> {
        if self.history_until >= route_date {
            return None;
        }
        let key = NumericTransferKey {
            stop: key.stop,
            incoming_product: key.incoming_product,
            incoming_line: self.strings.id(&normalize(&key.incoming_line))?,
            incoming_direction: self.strings.id(&normalize(&key.incoming_direction))?,
            outgoing_product: key.outgoing_product,
            outgoing_line: self.strings.id(&normalize(&key.outgoing_line))?,
            outgoing_direction: self.strings.id(&normalize(&key.outgoing_direction))?,
            weekday: key.weekday,
            time_bucket: key.time_bucket,
        };
        self.transfers.get(&key)
    }
}
impl TryFrom<StatsSnapshot> for RuntimeStats {
    type Error = anyhow::Error;
    fn try_from(snapshot: StatsSnapshot) -> Result<Self> {
        Self::from_snapshot(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    fn snapshot() -> StatsSnapshot {
        let key = StatKey {
            product: 1,
            line: "X".into(),
            stop: 2,
            direction: "Nürnberg—Hbf".into(),
            weekday: 5,
            bucket: 50,
            level: 0,
        };
        let mut s = history::snapshot_from_rows(
            (0..20)
                .map(|_| (key.clone(), Some(300), Some(0), false))
                .collect(),
            20,
        );
        s.history_until = NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
        s.generated_at = Utc.with_ymd_and_hms(2026, 9, 18, 1, 0, 0).unwrap();
        s
    }
    fn request() -> LookupRequest {
        LookupRequest {
            product: 1,
            line: "X".into(),
            stop: 2,
            direction: None,
            headsign: Some("NURNBERG HBF".into()),
            scheduled: Utc.with_ymd_and_hms(2026, 9, 18, 10, 30, 0).unwrap(),
        }
    }
    #[test]
    fn numerical_index_matches_wire_lookup() {
        let s = snapshot();
        let expected = serde_json::to_value(crate::assess_leg(&s, &request())).unwrap();
        let counts = (
            s.arrivals.len(),
            s.departures.len(),
            s.cancellations.len(),
            s.transfers.len(),
        );
        let runtime = RuntimeStats::from_snapshot(s).unwrap();
        assert_eq!(
            serde_json::to_value(runtime.assess_leg(&request())).unwrap(),
            expected
        );
        assert_eq!(runtime.counts(), counts);
        assert_eq!(runtime.interned_strings(), 3);
        assert!(std::mem::size_of::<NumericStatKey>() < std::mem::size_of::<StatKey>());
    }
    #[test]
    fn fallbacks_missing_leakage_and_cancellation_match() {
        let mut s = snapshot();
        s.arrivals.clear();
        for d in s.departures.values_mut() {
            d.samples = 19;
            d.histogram.bins[10] = 19;
            d.data_quality = history::DataQuality::Insufficient;
        }
        let key = CancellationKey {
            product: 1,
            line: "x".into(),
            direction: String::new(),
            weekday: 0,
            bucket: 0,
            level: 4,
        };
        s.cancellations.insert(
            key,
            CancellationStats {
                samples: 20,
                cancellations: 2,
                probability: 0.1,
                data_quality: history::DataQuality::Low,
            },
        );
        let runtime = RuntimeStats::from_snapshot(s.clone()).unwrap();
        for (line, stop, day) in [
            ("X", 2, 18),
            ("X", i32::MIN, 18),
            ("Unknown", 2, 18),
            ("X", 2, 17),
        ] {
            let mut r = request();
            r.line = line.into();
            r.stop = stop;
            r.scheduled = Utc.with_ymd_and_hms(2026, 9, day, 10, 30, 0).unwrap();
            assert_eq!(
                serde_json::to_value(runtime.assess_leg(&r)).unwrap(),
                serde_json::to_value(crate::assess_leg(&s, &r)).unwrap()
            );
        }
    }
    #[test]
    fn empirical_keys_are_interned_and_guarded() {
        let mut s = snapshot();
        let key = TransferStatsKey {
            stop: 2,
            incoming_product: 1,
            incoming_line: "x".into(),
            incoming_direction: "nurnberg hbf".into(),
            outgoing_product: 2,
            outgoing_line: "u1".into(),
            outgoing_direction: "furth".into(),
            weekday: 5,
            time_bucket: 50,
        };
        let mut difference = history::DelayHistogram::default();
        difference.add(0, 20);
        s.transfers.insert(
            key.clone(),
            TransferStats {
                samples: 20,
                difference,
                data_quality: history::DataQuality::Low,
            },
        );
        let runtime = RuntimeStats::from_snapshot(s).unwrap();
        assert!(runtime
            .empirical_transfer(&key, NaiveDate::from_ymd_opt(2026, 9, 18).unwrap())
            .is_some());
        assert!(runtime
            .empirical_transfer(&key, NaiveDate::from_ymd_opt(2026, 9, 17).unwrap())
            .is_none());
        assert_eq!(runtime.interned_strings(), 5);
    }
    #[test]
    fn rejects_invalid_snapshot() {
        let mut s = snapshot();
        s.schema_version = 99;
        assert!(RuntimeStats::from_snapshot(s).is_err());
    }
}
