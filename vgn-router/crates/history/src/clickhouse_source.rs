use super::*;
use futures_util::StreamExt;
use std::path::{Path, PathBuf};

/// FINAL is essential for the existing ReplacingMergeTree source tables. Arrival
/// and departure queries deliberately bucket their own scheduled event times.
pub fn aggregate_query(arrival: bool) -> String {
    let (time, delay) = if arrival {
        ("AnkunftszeitSoll", "AnkunftszeitVerspätung")
    } else {
        ("AbfahrtszeitSoll", "AbfahrtszeitVerspätung")
    };
    format!(
        r#"SELECT product,line,stop,direction,weekday,day_type,bucket,recent,hot,
 groupArray((delay_bin,n,sum_delay,min_delay,max_delay)) AS bins
 FROM (
 SELECT product,line,stop,direction,weekday,day_type,bucket,recent,hot,delay_bin,
 count() AS n,sum(delay_seconds) AS sum_delay,min(delay_seconds) AS min_delay,max(delay_seconds) AS max_delay
 FROM (
 SELECT f.Produkt AS product,f.Linienname AS line,toInt32(h.VGNKennung) AS stop,h.Richtungstext AS direction,
 toDayOfWeek(toTimeZone(h.{time},{{timezone:String}})) AS weekday,
 multiIf(toDate(toTimeZone(h.{time},{{timezone:String}})) IN {{holidays:Array(Date)}},2,weekday=7,2,weekday=6,1,0) AS day_type,
 intDiv(toHour(toTimeZone(h.{time},{{timezone:String}}))*60+toMinute(toTimeZone(h.{time},{{timezone:String}})),15) AS bucket,
 h.Betriebstag >= {{recent_from:Date}} AS recent,
 h.Betriebstag >= {{hot_from:Date}} AS hot,
 toInt32(h.`{delay}`)*{{multiplier:Int32}} AS delay_seconds,
 multiIf(delay_seconds < -300,-301,delay_seconds >= 3600,3600,toInt32(floor(delay_seconds/30.0))*30) AS delay_bin
 FROM (SELECT * FROM fahrten_halte FINAL WHERE Betriebstag >= {{history_from:Date}} AND Betriebstag < {{until:Date}}) AS h
 INNER JOIN (SELECT * FROM fahrten FINAL WHERE Betriebstag >= {{history_from:Date}} AND Betriebstag < {{until:Date}}) AS f
 ON h.Betriebstag=f.Betriebstag AND h.Fahrtnummer=f.Fahrtnummer AND h.Produkt=f.Produkt
 WHERE h.{time} IS NOT NULL AND h.`{delay}` IS NOT NULL AND f.FaelltAus=0
 ) GROUP BY product,line,stop,direction,weekday,day_type,bucket,recent,hot,delay_bin
 ) GROUP BY product,line,stop,direction,weekday,day_type,bucket,recent,hot FORMAT JSONEachRow"#
    )
}
/// Aggregate stop records to one row per dated product/trip BEFORE joining the
/// trip table. A cancellation is therefore counted once, regardless of stop count.
pub fn cancellation_query() -> &'static str {
    r#"SELECT product,line,direction,weekday,day_type,bucket,recent,hot,count() AS n,countIf(cancelled=1) AS cancellations
 FROM (
 SELECT f.Produkt AS product,f.Linienname AS line,ifNull(h.direction,'') AS direction,
 toDayOfWeek(ifNull(toDate(toTimeZone(h.first_departure,{timezone:String})),f.Betriebstag)) AS weekday,
 multiIf(ifNull(toDate(toTimeZone(h.first_departure,{timezone:String})),f.Betriebstag) IN {holidays:Array(Date)},2,weekday=7,2,weekday=6,1,0) AS day_type,
 if(isNull(h.first_departure),255,intDiv(toHour(toTimeZone(h.first_departure,{timezone:String}))*60+toMinute(toTimeZone(h.first_departure,{timezone:String})),15)) AS bucket,
 f.Betriebstag >= {recent_from:Date} AS recent,f.Betriebstag >= {hot_from:Date} AS hot,f.FaelltAus AS cancelled
 FROM (SELECT * FROM fahrten FINAL WHERE Betriebstag >= {history_from:Date} AND Betriebstag < {until:Date}) AS f
 LEFT JOIN (
 SELECT Betriebstag,Fahrtnummer,Produkt,min(AbfahrtszeitSoll) AS first_departure,
 argMinIf(Richtungstext,ifNull(AbfahrtszeitSoll,AnkunftszeitSoll),Richtungstext!='') AS direction
 FROM fahrten_halte FINAL WHERE Betriebstag >= {history_from:Date} AND Betriebstag < {until:Date}
 GROUP BY Betriebstag,Fahrtnummer,Produkt
 ) AS h ON h.Betriebstag=f.Betriebstag AND h.Fahrtnummer=f.Fahrtnummer AND h.Produkt=f.Produkt
 ) GROUP BY product,line,direction,weekday,day_type,bucket,recent,hot FORMAT JSONEachRow"#
}
struct Source {
    config: HistoryConfig,
    client: reqwest::Client,
}
impl Source {
    fn new(mut config: HistoryConfig) -> Result<Self> {
        config.apply_env()?;
        let client = reqwest::Client::builder()
            .timeout(StdDuration::from_secs(config.timeout_seconds))
            .gzip(true)
            .build()?;
        Ok(Self { config, client })
    }
    async fn query(&self, sql: &str, params: &[(String, String)]) -> Result<String> {
        self.response(sql, params)
            .await?
            .text()
            .await
            .context("read ClickHouse response")
    }
    async fn response(&self, sql: &str, params: &[(String, String)]) -> Result<reqwest::Response> {
        let response = self
            .client
            .post(&self.config.url)
            .basic_auth(&self.config.user, Some(&self.config.password))
            .query(&[
                ("database", self.config.database.as_str()),
                ("output_format_json_quote_64bit_integers", "0"),
                ("join_use_nulls", "1"),
                ("enable_http_compression", "1"),
                ("http_zlib_compression_level", "1"),
                // Both source tables partition by the service month and the sorting key
                // starts with Betriebstag, so rows that can replace each other never cross
                // partitions. Let FINAL deduplicate partitions independently in parallel.
                ("do_not_merge_across_partitions_select_final", "1"),
            ])
            .query(params)
            .body(sql.to_owned())
            .send()
            .await
            .context("ClickHouse request failed")?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response
                .text()
                .await
                .unwrap_or_else(|_| "response body unavailable".into());
            anyhow::bail!(
                "ClickHouse rejected aggregation ({status}): {}",
                detail.trim()
            );
        }
        Ok(response)
    }
    async fn for_each_row<T, F>(
        &self,
        sql: &str,
        params: &[(String, String)],
        mut consume: F,
    ) -> Result<()>
    where
        T: serde::de::DeserializeOwned,
        F: FnMut(T) -> Result<()>,
    {
        const MAX_ROW_BYTES: usize = 16 * 1024 * 1024;
        let mut stream = self.response(sql, params).await?.bytes_stream();
        let mut pending = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("read ClickHouse response stream")?;
            pending.extend_from_slice(&chunk);
            let mut consumed = 0;
            while let Some(relative) = pending[consumed..].iter().position(|&b| b == b'\n') {
                let end = consumed + relative;
                let mut line = &pending[consumed..end];
                if line.last() == Some(&b'\r') {
                    line = &line[..line.len() - 1];
                }
                if !line.is_empty() {
                    consume(serde_json::from_slice(line).context("invalid aggregate row")?)?;
                }
                consumed = end + 1;
            }
            if consumed > 0 {
                pending.drain(..consumed);
            }
            ensure!(
                pending.len() <= MAX_ROW_BYTES,
                "oversized ClickHouse JSON row"
            );
        }
        if !pending.iter().all(u8::is_ascii_whitespace) {
            consume(serde_json::from_slice(&pending).context("invalid aggregate row")?)?;
        }
        Ok(())
    }
}
#[derive(Deserialize)]
struct DelayRow {
    product: i16,
    line: String,
    stop: i32,
    direction: String,
    weekday: u8,
    day_type: u8,
    bucket: u8,
    recent: u8,
    #[serde(default)]
    hot: u8,
    bins: Vec<(i32, u32, f64, i32, i32)>,
}
#[derive(Deserialize)]
struct CancelRow {
    product: i16,
    line: String,
    direction: String,
    weekday: u8,
    day_type: u8,
    bucket: u8,
    recent: u8,
    #[serde(default)]
    hot: u8,
    n: u32,
    cancellations: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct CheckpointMeta {
    version: u16,
    until: NaiveDate,
    history_from: NaiveDate,
    recent_from: NaiveDate,
    hot_from: NaiveDate,
    timezone: String,
    holidays: Vec<NaiveDate>,
    minimum_samples: u32,
    multiplier: i32,
    recent_weight: u32,
    product_map: std::collections::BTreeMap<i16, u8>,
}

#[derive(Serialize, Deserialize)]
struct BuildCheckpoint {
    meta: CheckpointMeta,
    next_from: NaiveDate,
    arrivals_primary: HashMap<StatKey, Acc>,
    arrivals_total: HashMap<StatKey, Acc>,
    departures_primary: HashMap<StatKey, Acc>,
    departures_total: HashMap<StatKey, Acc>,
    cancellations_primary: HashMap<CancellationKey, CountAcc>,
    cancellations_total: HashMap<CancellationKey, CountAcc>,
    unmapped: HashSet<i16>,
}

#[derive(Default, Serialize, Deserialize)]
struct CountAcc {
    observations: u32,
    samples: u32,
    cancellations: u32,
}

impl CountAcc {
    fn add(&mut self, samples: u32, cancellations: u32, weight: u32) -> Result<()> {
        self.observations = self
            .observations
            .checked_add(samples)
            .context("cancellation observation count overflow")?;
        self.samples = self
            .samples
            .checked_add(
                samples
                    .checked_mul(weight)
                    .context("weighted cancellation count overflow")?,
            )
            .context("cancellation count overflow")?;
        self.cancellations = self
            .cancellations
            .checked_add(
                cancellations
                    .checked_mul(weight)
                    .context("weighted cancellation count overflow")?,
            )
            .context("cancellation count overflow")?;
        Ok(())
    }
}

impl BuildCheckpoint {
    fn new(meta: CheckpointMeta) -> Self {
        Self {
            next_from: meta.history_from,
            meta,
            arrivals_primary: HashMap::new(),
            arrivals_total: HashMap::new(),
            departures_primary: HashMap::new(),
            departures_total: HashMap::new(),
            cancellations_primary: HashMap::new(),
            cancellations_total: HashMap::new(),
            unmapped: HashSet::new(),
        }
    }
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("checkpoint.previous.zst")
}

fn load_checkpoint(path: &Path, expected: &CheckpointMeta) -> Result<Option<BuildCheckpoint>> {
    for candidate in [path.to_path_buf(), backup_path(path)] {
        let bytes = match std::fs::read(&candidate) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("read checkpoint {}", candidate.display()))
            }
        };
        let raw = match zstd::stream::decode_all(bytes.as_slice()) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(path=%candidate.display(), %error, "ignoring unreadable statistics checkpoint");
                continue;
            }
        };
        let checkpoint: BuildCheckpoint = match bincode::deserialize(&raw) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                tracing::warn!(path=%candidate.display(), %error, "ignoring invalid statistics checkpoint");
                continue;
            }
        };
        if &checkpoint.meta != expected
            || checkpoint.next_from < expected.history_from
            || checkpoint.next_from > expected.until
        {
            tracing::warn!(path=%candidate.display(), "ignoring statistics checkpoint with different build parameters");
            continue;
        }
        tracing::info!(path=%candidate.display(), next_from=%checkpoint.next_from, "resuming statistics build");
        return Ok(Some(checkpoint));
    }
    Ok(None)
}

fn save_checkpoint(path: &Path, checkpoint: &BuildCheckpoint) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("checkpoint.{}.tmp", std::process::id()));
    let backup = backup_path(path);
    let raw = bincode::serialize(checkpoint).context("serialize statistics checkpoint")?;
    let compressed =
        zstd::stream::encode_all(raw.as_slice(), 3).context("compress statistics checkpoint")?;
    std::fs::write(&temporary, compressed)
        .with_context(|| format!("write checkpoint {}", temporary.display()))?;
    if path.exists() {
        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
        std::fs::rename(path, &backup)?;
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        if !path.exists() && backup.exists() {
            let _ = std::fs::rename(&backup, path);
        }
        return Err(error).with_context(|| format!("activate checkpoint {}", path.display()));
    }
    if backup.exists() {
        std::fs::remove_file(backup)?;
    }
    Ok(())
}

pub fn remove_checkpoint(path: &Path) -> Result<()> {
    for candidate in [path.to_path_buf(), backup_path(path)] {
        match std::fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("remove checkpoint {}", candidate.display()))
            }
        }
    }
    Ok(())
}
fn choose_acc(
    primary: HashMap<StatKey, Acc>,
    mut total: HashMap<StatKey, Acc>,
    minimum: u32,
) -> HashMap<StatKey, DelayStats> {
    for (k, v) in primary {
        if v.observations() >= minimum as u64 {
            total.insert(k, v);
        }
    }
    total
        .into_iter()
        // Runtime lookup rejects smaller samples and continues through the same hierarchy.
        // Omitting them avoids expanding millions of unusable sparse accumulators into
        // fixed 130-bin wire histograms.
        .filter(|(_, value)| value.observations() >= minimum as u64)
        .map(|(k, v)| (k, v.finish(minimum)))
        .collect()
}

async fn aggregate_delay_into(
    source: &Source,
    config: &HistoryConfig,
    params: &[(String, String)],
    arrival: bool,
    needs_separate_primary: bool,
    primary: &mut HashMap<StatKey, Acc>,
    total: &mut HashMap<StatKey, Acc>,
) -> Result<HashSet<i16>> {
    let mut unmapped = HashSet::new();
    let query = aggregate_query(arrival);
    source
        .for_each_row::<DelayRow, _>(&query, params, |r| {
            let Some(&product) = config.product_map.get(&r.product) else {
                unmapped.insert(r.product);
                return Ok(());
            };
            ensure!(!r.bins.is_empty(), "empty server histogram aggregate");
            let base = StatKey {
                product,
                line: normalize(&r.line),
                stop: r.stop,
                direction: normalize(&r.direction),
                weekday: r.weekday,
                bucket: r.bucket,
                level: 0,
            };
            let keys = hierarchy(&base, r.day_type);
            let weight = if r.hot != 0 { config.recent_weight } else { 1 };
            for (delay_bin, n, sum_delay, min_delay, max_delay) in r.bins {
                ensure!(
                    n > 0 && sum_delay.is_finite() && min_delay <= max_delay,
                    "invalid server aggregate"
                );
                for key in &keys {
                    total
                        .entry(key.clone())
                        .or_default()
                        .add_weighted(delay_bin, n, sum_delay, min_delay, max_delay, weight)?;
                    if needs_separate_primary && r.recent != 0 {
                        primary
                            .entry(key.clone())
                            .or_default()
                            .add_weighted(delay_bin, n, sum_delay, min_delay, max_delay, weight)?;
                    }
                }
            }
            Ok(())
        })
        .await?;
    Ok(unmapped)
}

pub async fn build(config: HistoryConfig) -> Result<StatsSnapshot> {
    let mut config = config;
    config.apply_env()?;
    let tz: chrono_tz::Tz = config
        .timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid timezone"))?;
    let until = Utc::now().with_timezone(&tz).date_naive();
    build_until(config, until).await
}
/// `until` is exclusive and is also the strict training cutoff for offline builds.
pub async fn build_until(config: HistoryConfig, until: NaiveDate) -> Result<StatsSnapshot> {
    build_internal(config, until, None, u32::MAX).await
}

/// Builds in bounded date ranges and persists lossless, unfinished aggregates after every range.
/// The checkpoint remains in place until the caller has successfully published the final snapshot.
pub async fn build_until_resumable(
    config: HistoryConfig,
    until: NaiveDate,
    checkpoint_path: &Path,
    chunk_days: u32,
) -> Result<StatsSnapshot> {
    ensure!(chunk_days > 0, "statistics chunk size must be positive");
    build_internal(config, until, Some(checkpoint_path), chunk_days).await
}

async fn build_internal(
    config: HistoryConfig,
    until: NaiveDate,
    checkpoint_path: Option<&Path>,
    chunk_days: u32,
) -> Result<StatsSnapshot> {
    let source = Source::new(config)?;
    let c = &source.config;
    c.validate()?;
    let expected = until - Duration::days(1);
    let recent = until - Duration::days(c.primary_days as i64);
    let hot = until - Duration::days(c.recent_days as i64);
    let requested_oldest = until - Duration::days(c.fallback_days as i64);
    let freshness=source.query("SELECT toString(minOrNull(Betriebstag)) AS earliest,toString(maxOrNull(Betriebstag)) AS latest FROM fahrten FINAL FORMAT JSONEachRow",&[]).await?;
    #[derive(Deserialize)]
    struct Coverage {
        #[serde(default)]
        earliest: Option<String>,
        latest: Option<String>,
    }
    let coverage: Coverage =
        serde_json::from_str(freshness.trim()).context("invalid freshness response")?;
    let latest = NaiveDate::parse_from_str(
        coverage
            .latest
            .as_deref()
            .context("history source is empty")?,
        "%Y-%m-%d",
    )?;
    ensure!(
        latest >= expected,
        "history is incomplete: latest {latest}, expected at least {expected}"
    );
    let oldest = match coverage.earliest {
        Some(value) => requested_oldest.max(NaiveDate::parse_from_str(&value, "%Y-%m-%d")?),
        None => requested_oldest,
    };
    ensure!(oldest < until, "history source has no rows before {until}");
    let multiplier = if matches!(c.delay_unit, DelayUnit::Minutes) {
        60
    } else {
        1
    };
    let meta = CheckpointMeta {
        version: 2,
        until,
        history_from: oldest,
        recent_from: recent,
        hot_from: hot,
        timezone: c.timezone.clone(),
        holidays: c.holidays.clone(),
        minimum_samples: c.min_samples,
        multiplier,
        recent_weight: c.recent_weight,
        product_map: c.product_map.iter().map(|(&k, &v)| (k, v)).collect(),
    };
    let mut state = match checkpoint_path {
        Some(path) => load_checkpoint(path, &meta)?.unwrap_or_else(|| BuildCheckpoint::new(meta)),
        None => BuildCheckpoint::new(meta),
    };
    // When the source starts inside the primary window, primary and fallback contain
    // exactly the same observations. Keeping both would double the largest maps.
    let needs_separate_primary = oldest < recent;
    while state.next_from < until {
        let chunk_from = state.next_from;
        let remaining_days = (until - chunk_from).num_days();
        let chunk_until = chunk_from + Duration::days(remaining_days.min(chunk_days as i64));
        let params = vec![
            ("param_until".into(), chunk_until.to_string()),
            ("param_history_from".into(), chunk_from.to_string()),
            ("param_recent_from".into(), recent.to_string()),
            ("param_hot_from".into(), hot.to_string()),
            ("param_timezone".into(), c.timezone.clone()),
            ("param_multiplier".into(), multiplier.to_string()),
            (
                "param_holidays".into(),
                format!(
                    "[{}]",
                    c.holidays
                        .iter()
                        .map(|d| format!("'{d}'"))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            ),
        ];
        tracing::info!(from=%chunk_from, until=%chunk_until, "aggregating statistics date range");
        let arrivals = aggregate_delay_into(
            &source,
            c,
            &params,
            true,
            needs_separate_primary,
            &mut state.arrivals_primary,
            &mut state.arrivals_total,
        );
        let departures = aggregate_delay_into(
            &source,
            c,
            &params,
            false,
            needs_separate_primary,
            &mut state.departures_primary,
            &mut state.departures_total,
        );
        let (arrival_unmapped, departure_unmapped) = futures_util::try_join!(arrivals, departures)?;
        state.unmapped.extend(arrival_unmapped);
        state.unmapped.extend(departure_unmapped);
        source
            .for_each_row::<CancelRow, _>(cancellation_query(), &params, |r| {
                let Some(&product) = c.product_map.get(&r.product) else {
                    state.unmapped.insert(r.product);
                    return Ok(());
                };
                ensure!(
                    r.n > 0 && r.cancellations <= r.n,
                    "invalid cancellation count"
                );
                let base = StatKey {
                    product,
                    line: normalize(&r.line),
                    stop: 0,
                    direction: normalize(&r.direction),
                    weekday: r.weekday,
                    bucket: r.bucket,
                    level: 0,
                };
                for k in hierarchy(&base, r.day_type) {
                    let k = cancellation_key(&k);
                    for map in std::iter::once(&mut state.cancellations_total).chain(
                        if needs_separate_primary && r.recent != 0 {
                            Some(&mut state.cancellations_primary)
                        } else {
                            None
                        },
                    ) {
                        let x = map.entry(k.clone()).or_default();
                        x.add(
                            r.n,
                            r.cancellations,
                            if r.hot != 0 { c.recent_weight } else { 1 },
                        )?;
                    }
                }
                Ok(())
            })
            .await?;
        state.next_from = chunk_until;
        if let Some(path) = checkpoint_path {
            save_checkpoint(path, &state)?;
            tracing::info!(path=%path.display(), completed_through=%expected.min(chunk_until - Duration::days(1)), "statistics checkpoint saved");
        }
    }
    ensure!(
        state.unmapped.is_empty(),
        "unmapped historical product codes: {:?}; configure history_product",
        state.unmapped
    );
    for (k, v) in state.cancellations_primary {
        if v.observations >= c.min_samples {
            state.cancellations_total.insert(k, v);
        }
    }
    let cancellations = state
        .cancellations_total
        .into_iter()
        .filter(|(_, value)| value.observations >= c.min_samples)
        .map(|(k, value)| {
            let samples = value.samples;
            let cancellations = value.cancellations;
            (
                k,
                CancellationStats {
                    samples,
                    cancellations,
                    probability: cancellations as f32 / samples as f32,
                    data_quality: quality(samples, c.min_samples),
                },
            )
        })
        .collect();
    let arrivals = choose_acc(state.arrivals_primary, state.arrivals_total, c.min_samples);
    let departures = choose_acc(
        state.departures_primary,
        state.departures_total,
        c.min_samples,
    );
    ensure!(
        !arrivals.is_empty() || !departures.is_empty(),
        "empty delay aggregation; retaining previous snapshot"
    );
    let snapshot = StatsSnapshot {
        schema_version: SCHEMA_VERSION,
        generated_at: Utc::now(),
        history_from: oldest,
        history_until: expected,
        timezone: c.timezone.clone(),
        holidays: c.holidays.clone(),
        minimum_samples: c.min_samples,
        arrivals,
        departures,
        cancellations,
        transfers: HashMap::new(),
    };
    snapshot.validate()?;
    Ok(snapshot)
}
pub async fn fetch_stops(config: &HistoryConfig) -> Result<Vec<HistoricalStop>> {
    let source = Source::new(config.clone())?;
    let mut stops = Vec::new();
    source.for_each_row("SELECT toInt32(VGNKennung) AS vgn_id,Haltestellenname AS name,Latitude AS latitude,Longitude AS longitude FROM haltestellen FINAL FORMAT JSONEachRow",&[], |stop| {
        stops.push(stop);
        Ok(())
    }).await?;
    Ok(stops)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queries_use_real_source_and_separate_event_times() {
        let a = aggregate_query(true);
        let d = aggregate_query(false);
        for q in [&a, &d] {
            assert!(q.contains("fahrten_halte FINAL"));
            assert!(q.contains("fahrten FINAL"));
            assert!(q.contains("h.Fahrtnummer=f.Fahrtnummer AND h.Produkt=f.Produkt"));
            assert!(q.contains("{history_from:Date}"));
            assert!(q.contains(
                "GROUP BY product,line,stop,direction,weekday,day_type,bucket,recent,hot,delay_bin"
            ));
            assert!(q.contains("{hot_from:Date}"));
        }
        assert!(a.contains("toHour(toTimeZone(h.AnkunftszeitSoll"));
        assert!(d.contains("toHour(toTimeZone(h.AbfahrtszeitSoll"));
        assert!(cancellation_query().contains("GROUP BY Betriebstag,Fahrtnummer,Produkt"));
        assert!(cancellation_query().contains(",recent,hot FORMAT JSONEachRow"));
        assert!(!cancellation_query().contains("Richtung AS"));
    }
    #[test]
    fn primary_then_broader_fallback() {
        let key = StatKey {
            product: 1,
            line: "x".into(),
            stop: 1,
            direction: "north".into(),
            weekday: 1,
            bucket: 0,
            level: 0,
        };
        let acc = |n, v| {
            let mut a = Acc::default();
            a.add(v, n, v as f64 * n as f64, v, v).unwrap();
            a
        };
        let selected = choose_acc(
            HashMap::from([(key.clone(), acc(20, 0))]),
            HashMap::from([(key.clone(), acc(100, 300))]),
            20,
        );
        assert_eq!(selected[&key].samples, 20);
        assert_eq!(selected[&key].mean_seconds, 0.0);
        let selected = choose_acc(
            HashMap::from([(key.clone(), acc(19, 0))]),
            HashMap::from([(key.clone(), acc(100, 300))]),
            20,
        );
        assert_eq!(selected[&key].samples, 100);
    }
    #[test]
    fn recent_weight_changes_distribution_not_minimum_observations() {
        let key = StatKey {
            product: 1,
            line: "x".into(),
            stop: 1,
            direction: "north".into(),
            weekday: 1,
            bucket: 0,
            level: 0,
        };
        let mut ten_recent = Acc::default();
        ten_recent.add_weighted(0, 10, 0.0, 0, 0, 4).unwrap();
        let mut fallback = Acc::default();
        fallback
            .add_weighted(300, 100, 30_000.0, 300, 300, 1)
            .unwrap();
        let selected = choose_acc(
            HashMap::from([(key.clone(), ten_recent)]),
            HashMap::from([(key.clone(), fallback)]),
            20,
        );
        assert_eq!(selected[&key].samples, 100);
        assert_eq!(selected[&key].mean_seconds, 300.0);

        let mut twenty_recent = Acc::default();
        twenty_recent.add_weighted(0, 20, 0.0, 0, 0, 4).unwrap();
        let mut fallback = Acc::default();
        fallback
            .add_weighted(300, 100, 30_000.0, 300, 300, 1)
            .unwrap();
        let selected = choose_acc(
            HashMap::from([(key.clone(), twenty_recent)]),
            HashMap::from([(key.clone(), fallback)]),
            20,
        );
        assert_eq!(selected[&key].samples, 80);
        assert_eq!(selected[&key].mean_seconds, 0.0);
    }
    #[tokio::test]
    async fn http_builder_is_parameterized_and_preserves_counts() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for i in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(StdDuration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut b = [0; 4096];
                    let n = stream.read(&mut b).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&b[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..end]);
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|x| x.parse::<usize>().ok())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                assert!(request.to_lowercase().contains("authorization: basic"));
                if i > 0 {
                    assert!(request.contains("param_until=2026-01-02"));
                    assert!(request.contains("{history_from:Date}"));
                }
                let body=match i{0=>"{\"latest\":\"2026-01-01\"}\n",1|2=>"{\"product\":1,\"line\":\"X\",\"stop\":1,\"direction\":\"North\",\"weekday\":4,\"day_type\":0,\"bucket\":48,\"recent\":1,\"bins\":[[0,20,0,0,0]]}\n",_=>"{\"product\":1,\"line\":\"X\",\"direction\":\"North\",\"weekday\":4,\"day_type\":0,\"bucket\":48,\"recent\":1,\"n\":20,\"cancellations\":2}\n"};
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let config = HistoryConfig {
            url: format!("http://{address}"),
            product_map: HashMap::from([(1, 1)]),
            ..Default::default()
        };
        let snapshot = build_until(config, NaiveDate::from_ymd_opt(2026, 1, 2).unwrap())
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(snapshot.arrivals.len(), 5);
        assert_eq!(snapshot.departures.len(), 5);
        assert!(snapshot
            .cancellations
            .values()
            .all(|s| s.samples == 20 && s.cancellations == 2));
        snapshot.validate().unwrap();
    }
}
