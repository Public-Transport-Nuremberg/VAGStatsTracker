pub mod catalog;
pub mod metrics;
pub mod scoring;

use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json,
};
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use futures_util::StreamExt;
use history::StatsSnapshot;
use router_model::StaticData;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use snapshot::{Bundle, Config, Manifest, Store};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant},
};

use catalog::{Catalog, StopInfo};
use metrics::Metrics;

#[derive(Clone)]
pub struct Loaded {
    pub data: Arc<StaticData>,
    pub router: Arc<csa::Router>,
    pub catalog: Arc<Catalog>,
    pub gtfs_manifest: Manifest,
    pub stats: Option<Arc<reliability::RuntimeStats>>,
    pub stats_manifest: Option<Manifest>,
    pub timezone: Tz,
    pub valid_from: NaiveDate,
    pub valid_until: NaiveDate,
    pub trip_terminals: Vec<Option<u32>>,
    pub trip_departures: Vec<Option<u32>>,
    pub trip_connections: Vec<Vec<u32>>,
    pub departures_by_stop: Vec<Vec<u32>>,
    pub trip_interpolated: Vec<bool>,
}

impl Loaded {
    pub fn new(gtfs: Bundle, stats: Option<Bundle>, config: &Config) -> Result<Self> {
        gtfs.validate()?;
        anyhow::ensure!(gtfs.manifest.kind == "gtfs", "expected GTFS snapshot");
        let (data, station_names): (StaticData, HashMap<i32, String>) =
            snapshot::packaging::unpack_gtfs_with_station_names(&gtfs)?;
        data.validate().map_err(anyhow::Error::msg)?;
        let timezone = data.timezone.parse::<Tz>()?;
        let valid_from = data
            .calendar
            .iter()
            .map(|c| c.start)
            .chain(data.exceptions.iter().filter(|e| e.added).map(|e| e.date))
            .min()
            .context("no service dates")?;
        let valid_until = last_operating_date(&data, timezone).context("no service dates")?;
        let mut terminal_sequences = vec![None; data.trips.len()];
        let mut trip_departures: Vec<Option<u32>> = vec![None; data.trips.len()];
        let mut trip_connections = vec![Vec::new(); data.trips.len()];
        let mut departures_by_stop = vec![Vec::new(); data.stops.len()];
        let mut trip_interpolated = vec![false; data.trips.len()];
        for (trip, _) in &data.interpolated_stop_times {
            trip_interpolated[*trip as usize] = true;
        }
        for (connection_index, c) in data.connections.iter().enumerate() {
            let start = &mut trip_departures[c.trip as usize];
            *start = Some(start.unwrap_or(c.departure).min(c.departure));
            trip_connections[c.trip as usize].push(connection_index as u32);
            departures_by_stop[c.from as usize].push(connection_index as u32);
            let slot = &mut terminal_sequences[c.trip as usize];
            if slot.is_none_or(|(sequence, _)| c.stop_sequence > sequence) {
                *slot = Some((c.stop_sequence, c.to));
            }
        }
        let trip_terminals = terminal_sequences
            .into_iter()
            .map(|s| s.map(|(_, stop)| stop))
            .collect();
        for connections in &mut trip_connections {
            connections
                .sort_unstable_by_key(|index| data.connections[*index as usize].stop_sequence);
        }
        let data = Arc::new(data);
        let router = Arc::new(csa::Router::new(
            data.clone(),
            config.day_cache_capacity,
            config.horizon_seconds,
        )?);
        let catalog = Arc::new(Catalog::with_station_names(&data, &station_names));
        let (stats, stats_manifest) = match stats {
            Some(bundle) => {
                bundle.validate()?;
                anyhow::ensure!(
                    bundle.manifest.kind == "stats",
                    "expected statistics snapshot"
                );
                let stats: StatsSnapshot = snapshot::packaging::unpack_stats(&bundle)?;
                anyhow::ensure!(
                    stats.timezone == data.timezone,
                    "statistics timezone differs from GTFS agency timezone"
                );
                (
                    Some(Arc::new(reliability::RuntimeStats::from_snapshot(stats)?)),
                    Some(bundle.manifest),
                )
            }
            None => (None, None),
        };
        Ok(Self {
            data,
            router,
            catalog,
            gtfs_manifest: gtfs.manifest,
            stats,
            stats_manifest,
            timezone,
            valid_from,
            valid_until,
            trip_terminals,
            trip_departures,
            trip_connections,
            departures_by_stop,
            trip_interpolated,
        })
    }
}

fn last_operating_date(data: &StaticData, timezone: Tz) -> Option<NaiveDate> {
    let removed: std::collections::HashSet<_> = data
        .exceptions
        .iter()
        .filter(|e| !e.added)
        .map(|e| (e.service_id, e.date))
        .collect();
    let mut last: HashMap<u32, NaiveDate> = HashMap::new();
    for calendar in &data.calendar {
        let mut day = calendar.end;
        while day >= calendar.start {
            if calendar.weekdays[day.weekday().num_days_from_monday() as usize]
                && !removed.contains(&(calendar.service_id, day))
            {
                last.entry(calendar.service_id)
                    .and_modify(|old| *old = (*old).max(day))
                    .or_insert(day);
                break;
            }
            let Some(previous) = day.pred_opt() else {
                break;
            };
            day = previous;
        }
    }
    for e in data.exceptions.iter().filter(|e| e.added) {
        last.entry(e.service_id)
            .and_modify(|old| *old = (*old).max(e.date))
            .or_insert(e.date);
    }
    let mut max_seconds: HashMap<u32, u32> = HashMap::new();
    for c in &data.connections {
        let service = data.trips[c.trip as usize].service_id;
        max_seconds
            .entry(service)
            .and_modify(|old| *old = (*old).max(c.arrival))
            .or_insert(c.arrival);
    }
    last.into_iter()
        .filter_map(|(service, date)| {
            let origin = timezone
                .from_local_datetime(&date.and_hms_opt(12, 0, 0)?)
                .single()?;
            Some(
                (origin - chrono::Duration::hours(12)
                    + chrono::Duration::seconds(*max_seconds.get(&service).unwrap_or(&0) as i64))
                .date_naive()
                .max(date),
            )
        })
        .max()
}

pub struct AppState {
    pub active: ArcSwapOption<Loaded>,
    pub config: Config,
    pub metrics: Metrics,
    pub redis_connected: AtomicBool,
    pub products: HashMap<String, u8>,
    pub reliability_config: reliability::ReliabilityConfig,
    history_store: OnceLock<Store>,
    stats_cache: tokio::sync::Mutex<StatsCache>,
}

#[derive(Clone)]
struct CachedStats {
    stats: Arc<reliability::RuntimeStats>,
    manifest: Manifest,
}

#[derive(Default)]
struct StatsCache {
    entries: HashMap<String, CachedStats>,
    lru: VecDeque<String>,
}

struct SelectedStats {
    stats: Option<Arc<reliability::RuntimeStats>>,
    manifest: Option<Manifest>,
    history_rejected: bool,
}

impl AppState {
    pub fn new(config: Config, products: HashMap<String, u8>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            active: ArcSwapOption::empty(),
            config,
            metrics: Metrics::new()?,
            redis_connected: AtomicBool::new(false),
            products,
            reliability_config: reliability::ReliabilityConfig::default(),
            history_store: OnceLock::new(),
            stats_cache: tokio::sync::Mutex::new(StatsCache::default()),
        }))
    }
    pub fn set_history_store(&self, store: Store) -> Result<()> {
        self.history_store
            .set(store)
            .map_err(|_| anyhow::anyhow!("history store already configured"))
    }
    pub fn install(&self, loaded: Loaded) {
        self.metrics.gtfs_timestamp.set(
            DateTime::parse_from_rfc3339(&loaded.gtfs_manifest.generated_at)
                .map(|t| t.timestamp())
                .unwrap_or(0),
        );
        self.metrics.stats_timestamp.set(
            loaded
                .stats
                .as_ref()
                .map(|s| s.generated_at.timestamp())
                .unwrap_or(0),
        );
        self.active.store(Some(Arc::new(loaded)));
    }

    async fn statistics_for(&self, loaded: &Loaded, route_date: NaiveDate) -> SelectedStats {
        if let Some(stats) = loaded
            .stats
            .as_ref()
            .filter(|stats| stats.history_until < route_date)
        {
            return SelectedStats {
                stats: Some(stats.clone()),
                manifest: loaded.stats_manifest.clone(),
                history_rejected: false,
            };
        }

        let rejected = loaded
            .stats
            .as_ref()
            .is_some_and(|stats| stats.history_until >= route_date);
        let Some(store) = self.history_store.get() else {
            return SelectedStats {
                stats: None,
                manifest: None,
                history_rejected: rejected,
            };
        };
        let id = match store.stats_version_before(route_date).await {
            Ok(Some(id)) => id,
            Ok(None) => {
                return SelectedStats {
                    stats: None,
                    manifest: None,
                    history_rejected: rejected,
                }
            }
            Err(error) => {
                tracing::warn!(%error, route_date=%route_date, "historical statistics lookup failed");
                return SelectedStats {
                    stats: None,
                    manifest: None,
                    history_rejected: rejected,
                };
            }
        };

        {
            let mut cache = self.stats_cache.lock().await;
            if let Some(entry) = cache.entries.get(&id).cloned() {
                cache.lru.retain(|cached| cached != &id);
                cache.lru.push_back(id);
                return SelectedStats {
                    stats: Some(entry.stats),
                    manifest: Some(entry.manifest),
                    history_rejected: false,
                };
            }
        }

        let bundle = match store.load_version("stats", &id).await {
            Ok(Some(bundle)) => bundle,
            Ok(None) => {
                tracing::warn!(snapshot=%id, "indexed historical statistics snapshot is missing");
                return SelectedStats {
                    stats: None,
                    manifest: None,
                    history_rejected: rejected,
                };
            }
            Err(error) => {
                tracing::warn!(%error, snapshot=%id, "historical statistics snapshot load failed");
                return SelectedStats {
                    stats: None,
                    manifest: None,
                    history_rejected: rejected,
                };
            }
        };
        let manifest = bundle.manifest.clone();
        let statistics = match tokio::task::spawn_blocking(move || -> Result<_> {
            let snapshot = snapshot::packaging::unpack_stats(&bundle)?;
            reliability::RuntimeStats::from_snapshot(snapshot)
        })
        .await
        {
            Ok(Ok(stats)) if stats.timezone == loaded.data.timezone => Arc::new(stats),
            Ok(Ok(_)) => {
                tracing::warn!(snapshot=%id, "historical statistics timezone differs from GTFS");
                return SelectedStats {
                    stats: None,
                    manifest: None,
                    history_rejected: rejected,
                };
            }
            result => {
                tracing::warn!(error=?result, snapshot=%id, "historical statistics validation failed");
                return SelectedStats {
                    stats: None,
                    manifest: None,
                    history_rejected: rejected,
                };
            }
        };
        if statistics.history_until >= route_date {
            tracing::warn!(snapshot=%id, route_date=%route_date, "indexed statistics violate route cutoff");
            return SelectedStats {
                stats: None,
                manifest: None,
                history_rejected: true,
            };
        }

        let entry = CachedStats {
            stats: statistics.clone(),
            manifest: manifest.clone(),
        };
        let mut cache = self.stats_cache.lock().await;
        cache.entries.insert(id.clone(), entry);
        cache.lru.retain(|cached| cached != &id);
        cache.lru.push_back(id);
        while cache.lru.len() > self.config.stats_history_cache_capacity {
            if let Some(evicted) = cache.lru.pop_front() {
                cache.entries.remove(&evicted);
            }
        }
        SelectedStats {
            stats: Some(statistics),
            manifest: Some(manifest),
            history_rejected: false,
        }
    }
}

pub fn app(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics))
        .route("/v1/stops/search", get(search))
        .route("/v1/stops/near", get(near))
        .route("/v1/journeys", post(journeys))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .with_state(state)
}

#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
fn loaded(state: &AppState) -> std::result::Result<Arc<Loaded>, ApiError> {
    state.active.load_full().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "SNAPSHOT_NOT_LOADED",
    ))
}
async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    let active = state.active.load_full();
    let connected = state.redis_connected.load(Ordering::Relaxed);
    let offline = state.config.local_gtfs.is_some();
    let status = if active.is_none() {
        "down"
    } else if (!offline && !connected) || active.as_ref().is_some_and(|s| s.stats.is_none()) {
        "degraded"
    } else {
        "ok"
    };
    Json(json!({"status": status, "gtfs": {"loaded":active.is_some(),
        "version":active.as_ref().map(|s| &s.gtfs_manifest.snapshot_id),
        "valid_from":active.as_ref().map(|s| s.valid_from),
        "valid_until":active.as_ref().map(|s| s.valid_until)},
        "statistics":{"loaded":active.as_ref().is_some_and(|s|s.stats.is_some()),
            "age_seconds":active.as_ref().and_then(|s|s.stats.as_ref()).map(|s|(Utc::now()-s.generated_at).num_seconds().max(0))},
        "redis":{"connected":connected,"enabled":!offline}}))
}
async fn ready(State(state): State<Arc<AppState>>) -> Response {
    if state.active.load().is_some() {
        (StatusCode::OK, Json(json!({"ready":true}))).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ready":false})),
        )
            .into_response()
    }
}
async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    match state.metrics.render() {
        Ok(mut text) => {
            if let Some(active) = state.active.load_full() {
                let m = active.router.metrics();
                text.push_str(&format!("# TYPE router_connections_scanned counter\nrouter_connections_scanned {}\n# TYPE router_daygraph_cache_hits_total counter\nrouter_daygraph_cache_hits_total {}\n# TYPE router_daygraph_cache_misses_total counter\nrouter_daygraph_cache_misses_total {}\n# TYPE router_daygraph_build_seconds summary\nrouter_daygraph_build_seconds_sum {}\nrouter_daygraph_build_seconds_count {}\n", m.connections_scanned, m.daygraph_hits, m.daygraph_misses,m.daygraph_build_seconds,m.daygraph_builds));
            }
            (
                [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
                text,
            )
                .into_response()
        }
        Err(_) => ApiError(StatusCode::INTERNAL_SERVER_ERROR, "METRICS_ERROR").into_response(),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<usize>,
}
async fn search(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SearchQuery>,
) -> std::result::Result<Json<Value>, ApiError> {
    let active = loaded(&state)?;
    if q.q.len() > 256 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "INVALID_QUERY"));
    }
    let stops: Vec<_> = active
        .catalog
        .search(&q.q, q.limit.unwrap_or(20).clamp(1, 100))
        .into_iter()
        .map(|i| StopInfo::from(&active.data.stops[i as usize]))
        .collect();
    Ok(Json(json!({"stops":stops})))
}
#[derive(Deserialize)]
struct NearQuery {
    latitude: f64,
    longitude: f64,
    radius_meters: Option<f64>,
    limit: Option<usize>,
}
async fn near(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NearQuery>,
) -> std::result::Result<Json<Value>, ApiError> {
    let active = loaded(&state)?;
    let radius = q.radius_meters.unwrap_or(1000.0); // Max 1000m
                                                    // Validate coordinates and radius
    if !q.latitude.is_finite()
        || !q.longitude.is_finite()
        || !(-90.0..=90.0).contains(&q.latitude)
        || !(-180.0..=180.0).contains(&q.longitude)
        || !radius.is_finite()
        || !(1.0..=50_000.0).contains(&radius)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "INVALID_COORDINATES"));
    }
    let stops:Vec<_> = active.catalog.near(q.latitude,q.longitude,radius,q.limit.unwrap_or(20).clamp(1,100)).into_iter()
        .map(|(i,d)|json!({"stop":StopInfo::from(&active.data.stops[i as usize]),"distance_meters":d.round() as u32,
            "walking_seconds":(d/state.config.walking_speed_mps).ceil() as u32})).collect();
    Ok(Json(json!({"stops":stops})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    #[serde(default)]
    pub stop_id: Option<String>,
    #[serde(default, deserialize_with = "station_id_string", alias = "VGNKennung")]
    pub station_id: Option<String>,
    #[serde(default, alias = "Haltestellenname")]
    pub station_name: Option<String>,
}
fn station_id_string<'de, D>(deserializer: D) -> std::result::Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Id {
        Text(String),
        Number(i32),
    }
    Ok(Option::<Id>::deserialize(deserializer)?.map(|id| match id {
        Id::Text(value) => value,
        Id::Number(value) => value.to_string(),
    }))
}
#[derive(Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct JourneyOptions {
    pub max_walk_seconds: u32,
    pub max_transfers: u16,
    pub max_results: u8,
    pub allow_tight_transfers: bool,
    pub products: Option<Vec<String>>,
}
impl Default for JourneyOptions {
    fn default() -> Self {
        Self {
            max_walk_seconds: 900,
            max_transfers: 5,
            max_results: 5,
            allow_tight_transfers: false,
            products: None,
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JourneyRequest {
    pub from: Endpoint,
    pub to: Endpoint,
    pub departure: DateTime<FixedOffset>,
    #[serde(default)]
    pub options: JourneyOptions,
    #[serde(default = "fastest")]
    pub profile: String,
}
fn fastest() -> String {
    "fastest".into()
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ServiceKey {
    product: u8,
    line: String,
    direction: String,
}

fn journey_services(loaded: &Loaded, journey: &csa::Journey) -> Vec<(ServiceKey, i64)> {
    journey
        .legs
        .iter()
        .filter_map(|leg| {
            let trip = &loaded.data.trips[leg.trip? as usize];
            let route = &loaded.data.routes[trip.route as usize];
            Some((
                ServiceKey {
                    product: route.product,
                    line: history::normalize(&route.short_name),
                    direction: history::normalize(trip.headsign.as_deref().unwrap_or("")),
                },
                (leg.arrival - leg.departure).max(1),
            ))
        })
        .collect()
}

struct RankedJourney {
    journey: csa::Journey,
    output: Value,
    preference_penalty_seconds: i64,
}

fn preference_penalty_seconds(output: &Value, allow_tight_transfers: bool) -> i64 {
    if allow_tight_transfers {
        return 0;
    }
    // Punish journeys with many transfers and risky transfers
    let transfer_count = output["transfers"].as_u64().unwrap_or(0) as i64;
    let risk_penalty = output["transfer_reliability"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|transfer| {
            transfer["flags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|flag| flag["type"].as_str())
                .map(|flag| match flag {
                    "UNRELIABLE_TRANSFER" => 4 * 60,
                    "TIGHT_TRANSFER" => 2 * 60,
                    _ => 0,
                })
                .max()
                .unwrap_or(0)
        })
        .sum::<i64>();
    transfer_count
        .saturating_mul(5 * 60)
        .saturating_add(risk_penalty)
}

fn diversify_journeys(
    loaded: &Loaded,
    mut candidates: Vec<RankedJourney>,
    limit: usize,
    requested_departure: i64,
) -> Vec<RankedJourney> {
    if candidates.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut used_services: HashMap<ServiceKey, u32> = HashMap::new();
    let initial_score = |candidate: &RankedJourney| {
        (
            (candidate.journey.arrival - requested_departure)
                .max(0)
                .saturating_add(candidate.preference_penalty_seconds),
            candidate.journey.arrival,
        )
    };
    let first_index = candidates
        .iter()
        .enumerate()
        .min_by_key(|(_, candidate)| initial_score(candidate))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let first = candidates.remove(first_index);
    let mut selected = Vec::with_capacity(limit.min(candidates.len() + 1));
    for (key, _) in journey_services(loaded, &first.journey) {
        *used_services.entry(key).or_default() += 1;
    }
    selected.push(first);

    while selected.len() < limit && !candidates.is_empty() {
        let score = |candidate: &RankedJourney| {
            let base = (candidate.journey.arrival - requested_departure)
                .max(0)
                .saturating_add(candidate.preference_penalty_seconds);
            let repeated_service_penalty = journey_services(loaded, &candidate.journey)
                .into_iter()
                .map(|(key, _)| {
                    (5i64 * 60).saturating_mul(i64::from(*used_services.get(&key).unwrap_or(&0)))
                })
                .fold(0i64, i64::saturating_add);
            (
                base.saturating_add(repeated_service_penalty),
                candidate.journey.arrival,
            )
        };
        // Diversity is a soft preference. Nearby departures of the same useful
        // service must not be displaced by a different route an hour later.
        let best = candidates
            .iter()
            .enumerate()
            .min_by_key(|(_, candidate)| score(candidate))
            .map(|(index, _)| index);
        let Some(best) = best else { break };
        let journey = candidates.remove(best);
        for (key, _) in journey_services(loaded, &journey.journey) {
            *used_services.entry(key).or_default() += 1;
        }
        selected.push(journey);
    }
    selected
}

async fn journeys(
    State(state): State<Arc<AppState>>,
    Json(request): Json<JourneyRequest>,
) -> std::result::Result<Json<Value>, ApiError> {
    let request_started = Instant::now();
    state.metrics.requests.inc();
    let timer = state.metrics.duration.start_timer();
    let active = loaded(&state)?;
    let date = request
        .departure
        .with_timezone(&active.timezone)
        .date_naive();
    if date < active.valid_from || date > active.valid_until {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "DATE_OUTSIDE_GTFS_RANGE",
        ));
    }
    if request.profile != "fastest" {
        return Err(ApiError(StatusCode::BAD_REQUEST, "UNSUPPORTED_PROFILE"));
    }
    if request.options.max_transfers > 20
        || request.options.max_walk_seconds > 86400
        || !(1..=10).contains(&request.options.max_results)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "INVALID_OPTIONS"));
    }
    let products = request
        .options
        .products
        .as_ref()
        .map(|names| {
            names
                .iter()
                .map(|name| {
                    state
                        .products
                        .get(name)
                        .copied()
                        .ok_or(ApiError(StatusCode::BAD_REQUEST, "UNKNOWN_PRODUCT"))
                })
                .collect::<std::result::Result<Vec<_>, _>>()
        })
        .transpose()?;
    let resolve = |endpoint: &Endpoint, is_from: bool| -> std::result::Result<Vec<u32>, ApiError> {
        let bad = || ApiError(StatusCode::BAD_REQUEST, "INVALID_ENDPOINT");
        let supplied = endpoint.stop_id.is_some() as u8
            + endpoint.station_id.is_some() as u8
            + endpoint.station_name.is_some() as u8;
        if supplied != 1 {
            return Err(bad());
        }
        let candidates = if let Some(id) = &endpoint.stop_id {
            vec![*active.catalog.ids.get(id).ok_or(ApiError(
                StatusCode::BAD_REQUEST,
                if is_from {
                    "UNKNOWN_FROM_STOP"
                } else {
                    "UNKNOWN_TO_STOP"
                },
            ))?]
        } else if let Some(id) = &endpoint.station_id {
            let parsed = id.parse::<i32>().map_err(|_| bad())?;
            active.catalog.by_station_id(parsed).ok_or(ApiError(
                StatusCode::BAD_REQUEST,
                if is_from {
                    "UNKNOWN_FROM_STATION"
                } else {
                    "UNKNOWN_TO_STATION"
                },
            ))?
        } else {
            let groups = active
                .catalog
                .by_exact_name(endpoint.station_name.as_deref().unwrap_or_default());
            if groups.is_empty() {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    if is_from {
                        "UNKNOWN_FROM_STATION"
                    } else {
                        "UNKNOWN_TO_STATION"
                    },
                ));
            }
            if groups.len() != 1 {
                return Err(ApiError(StatusCode::BAD_REQUEST, "AMBIGUOUS_STATION_NAME"));
            }
            groups.into_iter().next().unwrap_or_default()
        };
        let candidates = if endpoint.stop_id.is_none() {
            active
                .catalog
                .filter_products(candidates, products.as_deref(), is_from)
        } else {
            candidates
        };
        if candidates.is_empty() {
            return Err(ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "NO_PLATFORM_FOR_PRODUCTS",
            ));
        }
        Ok(candidates)
    };
    let from = resolve(&request.from, true)?;
    let to = resolve(&request.to, false)?;
    let options = csa::RouteOptions {
        max_walk_seconds: request.options.max_walk_seconds,
        max_transfers: request.options.max_transfers,
        allowed_products: products,
    };
    let router = active.router.clone();
    let departure = request.departure;
    let max_results = request.options.max_results;
    let endpoint_resolution_ms = request_started.elapsed().as_secs_f64() * 1000.0;
    let routing_started = Instant::now();
    let journeys = tokio::task::spawn_blocking(move || {
        let mut search_departure = departure;
        let candidate_limit = usize::from(max_results).saturating_mul(4);
        let mut journeys = Vec::with_capacity(candidate_limit);
        let result_window_end = departure.timestamp().saturating_add(6 * 60 * 60);
        for _ in 0..candidate_limit {
            let Some(journey) =
                router.route_many_with_options(&from, &to, search_departure, &options)?
            else {
                break;
            };
            if !journeys.is_empty() && journey.departure > result_window_end {
                break;
            }
            let next_timestamp = journey
                .legs
                .iter()
                .find(|leg| leg.trip.is_some())
                .map(|leg| leg.departure)
                .unwrap_or(journey.departure)
                .saturating_add(1);
            let advance_seconds = (next_timestamp - search_departure.timestamp()).max(1);
            search_departure += chrono::Duration::seconds(advance_seconds);
            journeys.push(journey);
        }
        Ok::<_, anyhow::Error>(journeys)
    })
    .await
    .map_err(|e| {
        tracing::error!(error=%e,"routing worker failed");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "ROUTING_FAILED")
    })?
    .map_err(|e| {
        tracing::error!(error=%e,"routing failed");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "ROUTING_FAILED")
    })?;
    let routing_search_ms = routing_started.elapsed().as_secs_f64() * 1000.0;
    let candidate_count = journeys.len();
    let statistics_started = Instant::now();
    let selected_stats = state.statistics_for(&active, date).await;
    let statistics_selection_ms = statistics_started.elapsed().as_secs_f64() * 1000.0;
    let scoring_started = Instant::now();
    let candidates: Vec<_> = journeys
        .into_iter()
        .map(|journey| {
            let output = scoring::score(
                &state,
                &active,
                &journey,
                date,
                selected_stats.stats.as_deref(),
                selected_stats.history_rejected,
            );
            RankedJourney {
                preference_penalty_seconds: preference_penalty_seconds(
                    &output,
                    request.options.allow_tight_transfers,
                ),
                journey,
                output,
            }
        })
        .collect();
    let scoring_ms = scoring_started.elapsed().as_secs_f64() * 1000.0;
    let diversification_started = Instant::now();
    let results: Vec<_> = diversify_journeys(
        &active,
        candidates,
        usize::from(max_results),
        request.departure.timestamp(),
    )
    .into_iter()
    .map(|candidate| candidate.output)
    .collect();
    let diversification_ms = diversification_started.elapsed().as_secs_f64() * 1000.0;
    let total_ms = request_started.elapsed().as_secs_f64() * 1000.0;
    if results.is_empty() {
        state.metrics.not_found.inc();
    }
    tracing::info!(
        event = "route_completed",
        duration_ms = total_ms,
        journey_found = !results.is_empty()
    );
    timer.observe_duration();
    Ok(Json(
        json!({"snapshot":{"gtfs":active.gtfs_manifest.snapshot_id,
        "statistics":selected_stats.manifest.as_ref().map(|m|&m.snapshot_id),
        "statistics_generated_at":selected_stats.stats.as_ref().map(|s|s.generated_at),
        "statistics_history_from":selected_stats.stats.as_ref().map(|s|s.history_from),
        "statistics_history_until":selected_stats.stats.as_ref().map(|s|s.history_until)},
        "metadata":{"timings_ms":{
            "endpoint_resolution":endpoint_resolution_ms,
            "routing_search":routing_search_ms,
            "diversification":diversification_ms,
            "statistics_selection":statistics_selection_ms,
            "scoring":scoring_ms,
            "total":total_ms
        },"candidate_count":candidate_count,"result_count":results.len(),
        "allow_tight_transfers":request.options.allow_tight_transfers},
        "statistics_age_seconds":selected_stats.stats.as_ref().map(|s|(Utc::now()-s.generated_at).num_seconds().max(0)),
        "journeys":results}),
    ))
}

pub async fn reload(state: &Arc<AppState>, store: &Store) -> Result<()> {
    let old = state.active.load_full();
    let gtfs_id = store
        .active_id("gtfs")
        .await?
        .context("GTFS active pointer missing")?;
    let gtfs_changed = old
        .as_ref()
        .is_none_or(|o| o.gtfs_manifest.snapshot_id != gtfs_id);
    let mut next = if gtfs_changed {
        let gtfs = store
            .load_version("gtfs", &gtfs_id)
            .await?
            .context("GTFS snapshot missing")?;
        let config = state.config.clone();
        let mut next =
            tokio::task::spawn_blocking(move || Loaded::new(gtfs, None, &config)).await??;
        if let Some(old) = &old {
            if old.timezone == next.timezone {
                next.stats = old.stats.clone();
                next.stats_manifest = old.stats_manifest.clone();
            }
        }
        next
    } else {
        old.as_ref().unwrap().as_ref().clone()
    };
    // Statistics are optional. A bad update must never block valid GTFS routing,
    // and a missing pointer must not erase the last good historical snapshot.
    let stats_result: Result<bool> = async {
        let id = store.active_id("stats").await?;
        let Some(id) = id else {
            anyhow::ensure!(
                next.stats.is_none(),
                "statistics pointer missing; retained old statistics"
            );
            return Ok(false);
        };
        if next
            .stats_manifest
            .as_ref()
            .is_some_and(|m| m.snapshot_id == id)
        {
            return Ok(false);
        }
        let bundle = store
            .load_version("stats", &id)
            .await?
            .context("statistics snapshot missing")?;
        let (stats, manifest) = tokio::task::spawn_blocking(move || -> Result<_> {
            let stats = snapshot::packaging::unpack_stats(&bundle)?;
            Ok((
                reliability::RuntimeStats::from_snapshot(stats)?,
                bundle.manifest,
            ))
        })
        .await??;
        anyhow::ensure!(
            stats.timezone == next.data.timezone,
            "statistics timezone differs from GTFS agency"
        );
        next.stats = Some(Arc::new(stats));
        next.stats_manifest = Some(manifest);
        Ok(true)
    }
    .await;
    if gtfs_changed || matches!(stats_result, Ok(true)) {
        tracing::info!(gtfs=%next.gtfs_manifest.snapshot_id,"validated snapshots activated");
        state.install(next);
    }
    stats_result.map(|_| ())
}

pub async fn run_reload(state: Arc<AppState>, store: Store) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let subscriber = store.clone();
    tokio::spawn(async move {
        loop {
            match subscriber.client().get_async_pubsub().await {
                Ok(mut pubsub) => {
                    if pubsub.subscribe(snapshot::RELOAD_CHANNEL).await.is_ok() {
                        let _ = tx.try_send(());
                        let mut messages = pubsub.on_message();
                        while messages.next().await.is_some() {
                            let _ = tx.try_send(());
                        }
                    }
                }
                Err(e) => tracing::debug!(error=%e,"reload subscription unavailable"),
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    let mut interval = tokio::time::interval(Duration::from_secs(state.config.reload_seconds));
    loop {
        tokio::select! { _ = interval.tick() => {}, _ = rx.recv() => {} }
        match tokio::time::timeout(Duration::from_secs(120), reload(&state, &store)).await {
            Ok(Ok(())) => state.redis_connected.store(true, Ordering::Relaxed),
            result => {
                state.redis_connected.store(false, Ordering::Relaxed);
                state.metrics.reload_failures.inc();
                tracing::warn!(error=?result,"reload failed; retaining previous RAM snapshot");
            }
        }
    }
}

#[cfg(test)]
mod alternative_tests {
    use super::*;

    #[test]
    fn tight_transfer_penalty_is_disabled_only_when_requested() {
        let output = json!({
            "transfers": 1,
            "transfer_reliability": [{
                "flags": [
                    {"type": "TIGHT_TRANSFER"},
                    {"type": "UNRELIABLE_TRANSFER"}
                ]
            }]
        });
        assert_eq!(preference_penalty_seconds(&output, false), 9 * 60);
        assert_eq!(preference_penalty_seconds(&output, true), 0);
    }
}
