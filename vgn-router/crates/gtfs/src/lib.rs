use anyhow::{anyhow, bail, Context, Result};
use chrono::NaiveDate;
use router_model::*;
use serde::Deserialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::{Cursor, Read};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Deserialize)]
pub struct HistoricalStop {
    pub id: i32,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
}
#[derive(Clone, Debug)]
pub struct ImportOptions {
    pub default_transfer_seconds: u32,
    /// Retained for callers; the feed's required agency_timezone is authoritative.
    pub timezone: String,
    pub product_map: HashMap<i16, u8>,
    pub line_overrides: HashMap<String, u8>,
    pub historical_stops: Vec<HistoricalStop>,
    pub stop_overrides: HashMap<String, i32>,
}
impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            default_transfer_seconds: 120,
            timezone: "Europe/Berlin".into(),
            product_map: HashMap::new(),
            line_overrides: HashMap::new(),
            historical_stops: vec![],
            stop_overrides: HashMap::new(),
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProductMapConfig {
    #[serde(default)]
    pub route_types: HashMap<String, u8>,
    #[serde(default)]
    pub line_overrides: HashMap<String, u8>,
}
impl ProductMapConfig {
    pub fn from_toml(input: &str) -> Result<Self> {
        let document: toml::Value = toml::from_str(input)?;
        let mut out = Self::default();
        fn product(value: &toml::Value) -> Result<u8> {
            match value {
                toml::Value::String(name) => {
                    product_id(name).ok_or_else(|| anyhow!("unknown product {name}"))
                }
                toml::Value::Integer(id) => Ok(u8::try_from(*id)?),
                _ => bail!("product must be a name or u8"),
            }
        }
        for section in ["route_type", "route_types"] {
            if let Some(value) = document.get(section) {
                for (key, value) in value
                    .as_table()
                    .ok_or_else(|| anyhow!("{section} must be a table"))?
                {
                    key.parse::<i16>()
                        .context("route_type keys must be integers")?;
                    if out
                        .route_types
                        .insert(key.clone(), product(value)?)
                        .is_some()
                    {
                        bail!("duplicate route_type mapping {key}");
                    }
                }
            }
        }
        for section in ["line_override", "line_overrides"] {
            if let Some(value) = document.get(section) {
                for (line, value) in value
                    .as_table()
                    .ok_or_else(|| anyhow!("{section} must be a table"))?
                {
                    let value = if let Some(table) = value.as_table() {
                        table
                            .get("product")
                            .ok_or_else(|| anyhow!("line override {line} requires product"))?
                    } else {
                        value
                    };
                    if out
                        .line_overrides
                        .insert(line.clone(), product(value)?)
                        .is_some()
                    {
                        bail!("duplicate line override {line}");
                    }
                }
            }
        }
        Ok(out)
    }
    pub fn apply(&self, options: &mut ImportOptions) -> Result<()> {
        options.product_map = self
            .route_types
            .iter()
            .map(|(k, v)| Ok((k.parse::<i16>()?, *v)))
            .collect::<Result<_>>()?;
        options.line_overrides = self.line_overrides.clone();
        Ok(())
    }
}
/// Canonical product IDs shared with historical VGN products; zero is unknown.
pub fn product_id(name: &str) -> Option<u8> {
    match name.trim().to_ascii_lowercase().as_str() {
        "unknown" => Some(0),
        "bus" => Some(1),
        "ubahn" => Some(2),
        "tram" => Some(3),
        "sbahn" => Some(4),
        "rbahn" => Some(5),
        _ => None,
    }
}
pub fn load_stop_overrides(input: &str) -> Result<HashMap<String, i32>> {
    #[derive(Deserialize)]
    struct Override {
        stop_id: String,
        #[serde(alias = "historical_vgn_id")]
        vgn_id: i32,
    }
    let mut result = HashMap::new();
    for r in read_csv::<Override>(input.as_bytes(), "stop-overrides.csv", &["stop_id"])? {
        if r.stop_id.is_empty() || result.insert(r.stop_id, r.vgn_id).is_some() {
            bail!("duplicate or empty stop override");
        }
    }
    Ok(result)
}
#[derive(Deserialize)]
struct AgencyRow {
    agency_timezone: String,
}
#[derive(Deserialize)]
struct StopRow {
    stop_id: String,
    stop_name: Option<String>,
    stop_lat: Option<f64>,
    stop_lon: Option<f64>,
    parent_station: Option<String>,
    location_type: Option<u8>,
}
#[derive(Deserialize)]
struct RouteRow {
    route_id: String,
    route_short_name: Option<String>,
    route_long_name: Option<String>,
    route_type: i16,
}
#[derive(Deserialize)]
struct TripRow {
    route_id: String,
    service_id: String,
    trip_id: String,
    direction_id: Option<u8>,
    trip_headsign: Option<String>,
    block_id: Option<String>,
    shape_id: Option<String>,
}
#[derive(Deserialize)]
struct TimeRow {
    trip_id: String,
    arrival_time: String,
    departure_time: String,
    stop_id: String,
    stop_sequence: u16,
    pickup_type: Option<u8>,
    drop_off_type: Option<u8>,
    timepoint: Option<u8>,
    shape_dist_traveled: Option<f64>,
}
type ParsedStopTime = (TimeRow, u32, Option<u32>, Option<u32>);
#[derive(Deserialize)]
struct CalRow {
    service_id: String,
    monday: u8,
    tuesday: u8,
    wednesday: u8,
    thursday: u8,
    friday: u8,
    saturday: u8,
    sunday: u8,
    start_date: String,
    end_date: String,
}
#[derive(Deserialize)]
struct ExRow {
    service_id: String,
    date: String,
    exception_type: u8,
}
#[derive(Deserialize)]
struct TransferRow {
    from_stop_id: String,
    to_stop_id: String,
    transfer_type: Option<u8>,
    min_transfer_time: Option<u32>,
    from_route_id: Option<String>,
    to_route_id: Option<String>,
    from_trip_id: Option<String>,
    to_trip_id: Option<String>,
}
#[derive(Deserialize)]
struct ShapeRow {
    shape_id: String,
    shape_pt_lat: f64,
    shape_pt_lon: f64,
    shape_pt_sequence: u32,
    shape_dist_traveled: Option<f64>,
}
#[derive(Deserialize)]
struct FeedRow {
    feed_publisher_name: String,
    feed_publisher_url: String,
    feed_lang: String,
    feed_version: Option<String>,
    feed_start_date: Option<String>,
    feed_end_date: Option<String>,
}
fn read_csv<T: for<'de> Deserialize<'de>>(
    r: impl Read,
    name: &str,
    required: &[&str],
) -> Result<Vec<T>> {
    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(r);
    let headers = reader
        .headers()
        .with_context(|| format!("{name}: invalid CSV headers"))?;
    let mut seen = HashSet::new();
    for h in headers {
        if !seen.insert(h) {
            bail!("{name}: duplicate column {h}");
        }
    }
    for h in required {
        if !headers.iter().any(|v| v == *h) {
            bail!("{name}: missing column {h}");
        }
    }
    reader
        .deserialize()
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("{name}: malformed CSV"))
}
fn load<T: for<'de> Deserialize<'de>>(
    z: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    required: bool,
    headers: &[&str],
) -> Result<Vec<T>> {
    match z.by_name(name) {
        Ok(f) => read_csv(f, name, headers),
        Err(zip::result::ZipError::FileNotFound) if !required => Ok(vec![]),
        Err(e) => Err(e).with_context(|| format!("cannot read {name}")),
    }
}
pub fn parse_service_time(s: &str) -> Result<ServiceTime> {
    let parts: Vec<_> = s.split(':').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
        || parts[1].len() != 2
        || parts[2].len() != 2
    {
        bail!("invalid GTFS time {s}");
    }
    let h: u32 = parts[0].parse()?;
    let m: u32 = parts[1].parse()?;
    let sec: u32 = parts[2].parse()?;
    if m >= 60 || sec >= 60 {
        bail!("invalid GTFS time {s}");
    }
    Ok(ServiceTime(
        h.checked_mul(3600)
            .and_then(|v| v.checked_add(m * 60 + sec))
            .ok_or_else(|| anyhow!("GTFS time overflow"))?,
    ))
}
fn date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y%m%d").with_context(|| format!("invalid GTFS date {s}"))
}
fn insert_id(map: &mut HashMap<String, u32>, id: &str) -> Result<u32> {
    if id.is_empty() {
        bail!("empty GTFS identifier");
    }
    let idx = u32::try_from(map.len())?;
    if map.insert(id.to_owned(), idx).is_some() {
        bail!("duplicate GTFS identifier {id}");
    }
    Ok(idx)
}
fn reference(map: &HashMap<String, u32>, id: &str, kind: &str) -> Result<u32> {
    map.get(id)
        .copied()
        .ok_or_else(|| anyhow!("unknown {kind} reference: {id}"))
}
fn optional_reference(
    map: &HashMap<String, u32>,
    id: Option<String>,
    kind: &str,
) -> Result<Option<u32>> {
    id.filter(|x| !x.is_empty())
        .map(|s| reference(map, &s, kind))
        .transpose()
}

/// Import scheduled GTFS. Untimed intermediate stops are interpolated between
/// known bounds using shape distances, or geographic segment lengths; zero-length
/// runs use equal intervals. Provenance is retained in `interpolated_stop_times`.
/// Missing endpoint or explicitly exact times and frequency service are errors.
/// Pickup/drop-off requiring booking (2/3) is not offered by the regular router.
pub fn import_zip(bytes: &[u8], opt: &ImportOptions) -> Result<StaticData> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).context("invalid GTFS ZIP")?;
    let mut filenames = HashSet::new();
    for name in z.file_names() {
        if !filenames.insert(name.to_owned()) {
            bail!("duplicate ZIP entry {name}");
        }
    }
    if filenames.contains("frequencies.txt") {
        bail!("frequencies.txt is unsupported: expand frequency trips to scheduled trips before importing");
    }
    if !filenames.contains("calendar.txt") && !filenames.contains("calendar_dates.txt") {
        bail!("calendar.txt or calendar_dates.txt is required");
    }
    let agency: Vec<AgencyRow> = load(&mut z, "agency.txt", true, &["agency_timezone"])?;
    let timezone = agency
        .first()
        .ok_or_else(|| anyhow!("agency.txt is empty"))?
        .agency_timezone
        .clone();
    timezone
        .parse::<chrono_tz::Tz>()
        .context("invalid agency_timezone")?;
    if agency.iter().any(|a| a.agency_timezone != timezone) {
        bail!("all agencies must share agency_timezone");
    }
    let mut d = StaticData {
        timezone,
        default_transfer_seconds: opt.default_transfer_seconds,
        ..Default::default()
    };
    let rows: Vec<StopRow> = load(
        &mut z,
        "stops.txt",
        true,
        &["stop_id", "stop_name", "stop_lat", "stop_lon"],
    )?;
    if rows.is_empty() {
        bail!("stops.txt is empty");
    }
    let mut sm = HashMap::new();
    for r in &rows {
        insert_id(&mut sm, &r.stop_id)?;
        if r.location_type.unwrap_or(0) > 4 {
            bail!("invalid location_type for {}", r.stop_id);
        }
    }
    for r in &rows {
        let parent = optional_reference(&sm, r.parent_station.clone(), "parent_station")?;
        let lat = r
            .stop_lat
            .or_else(|| parent.and_then(|p| rows[p as usize].stop_lat))
            .ok_or_else(|| anyhow!("missing stop_lat for {}", r.stop_id))?;
        let lon = r
            .stop_lon
            .or_else(|| parent.and_then(|p| rows[p as usize].stop_lon))
            .ok_or_else(|| anyhow!("missing stop_lon for {}", r.stop_id))?;
        d.stops.push(Stop {
            gtfs_id: r.stop_id.clone(),
            name: r
                .stop_name
                .clone()
                .or_else(|| parent.and_then(|p| rows[p as usize].stop_name.clone()))
                .unwrap_or_default(),
            latitude: lat,
            longitude: lon,
            parent_station: parent,
            historical_vgn_id: None,
        });
    }
    let mut rm = HashMap::new();
    for r in load::<RouteRow>(&mut z, "routes.txt", true, &["route_id", "route_type"])? {
        insert_id(&mut rm, &r.route_id)?;
        let short_name = r.route_short_name.unwrap_or_default();
        let product = opt
            .line_overrides
            .get(&short_name)
            .or_else(|| opt.product_map.get(&r.route_type))
            .copied()
            .unwrap_or(0);
        d.routes.push(Route {
            gtfs_id: r.route_id,
            short_name,
            long_name: r.route_long_name.unwrap_or_default(),
            route_type: r.route_type,
            product,
        });
    }
    let mut services = HashMap::new();
    for r in load::<CalRow>(
        &mut z,
        "calendar.txt",
        false,
        &[
            "service_id",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
            "start_date",
            "end_date",
        ],
    )? {
        let id = insert_id(&mut services, &r.service_id)?;
        d.service_ids.push(r.service_id);
        let weekdays = [
            r.monday,
            r.tuesday,
            r.wednesday,
            r.thursday,
            r.friday,
            r.saturday,
            r.sunday,
        ];
        if weekdays.iter().any(|v| *v > 1) {
            bail!("calendar weekday must be 0 or 1");
        }
        d.calendar.push(ServiceCalendar {
            service_id: id,
            start: date(&r.start_date)?,
            end: date(&r.end_date)?,
            weekdays: weekdays.map(|v| v == 1),
        });
    }
    for r in load::<ExRow>(
        &mut z,
        "calendar_dates.txt",
        false,
        &["service_id", "date", "exception_type"],
    )? {
        let id = if let Some(id) = services.get(&r.service_id) {
            *id
        } else {
            let id = insert_id(&mut services, &r.service_id)?;
            d.service_ids.push(r.service_id);
            id
        };
        if !matches!(r.exception_type, 1 | 2) {
            bail!("invalid exception_type {}", r.exception_type);
        }
        d.exceptions.push(ServiceException {
            service_id: id,
            date: date(&r.date)?,
            added: r.exception_type == 1,
        });
    }
    let mut tim = HashMap::new();
    for r in load::<TripRow>(
        &mut z,
        "trips.txt",
        true,
        &["route_id", "service_id", "trip_id"],
    )? {
        let idx = insert_id(&mut tim, &r.trip_id)?;
        if let Some(shape) = r.shape_id.filter(|s| !s.is_empty()) {
            d.trip_shapes.insert(idx, shape);
        }
        d.trips.push(Trip {
            gtfs_id: r.trip_id,
            route: reference(&rm, &r.route_id, "route")?,
            service_id: reference(&services, &r.service_id, "service")?,
            direction_id: r.direction_id,
            headsign: r.trip_headsign,
            block_id: r.block_id,
        });
    }
    let mut times: Vec<Vec<ParsedStopTime>> = (0..d.trips.len()).map(|_| vec![]).collect();
    for r in load::<TimeRow>(
        &mut z,
        "stop_times.txt",
        true,
        &[
            "trip_id",
            "arrival_time",
            "departure_time",
            "stop_id",
            "stop_sequence",
        ],
    )? {
        let trip = reference(&tim, &r.trip_id, "trip")?;
        let stop = reference(&sm, &r.stop_id, "stop")?;
        if r.timepoint.is_some_and(|v| v > 1) {
            bail!("invalid timepoint");
        }
        if r.arrival_time.is_empty() != r.departure_time.is_empty() {
            bail!(
                "trip {} stop {} needs both arrival and departure times",
                r.trip_id,
                r.stop_id
            );
        }
        if r.arrival_time.is_empty() && r.timepoint == Some(1) {
            bail!(
                "trip {} stop {} explicitly exact timepoint has no times",
                r.trip_id,
                r.stop_id
            );
        }
        let arrival = (!r.arrival_time.is_empty())
            .then(|| parse_service_time(&r.arrival_time).map(|v| v.0))
            .transpose()
            .with_context(|| format!("trip {} stop {} arrival_time", r.trip_id, r.stop_id))?;
        let departure = (!r.departure_time.is_empty())
            .then(|| parse_service_time(&r.departure_time).map(|v| v.0))
            .transpose()?;
        if departure < arrival {
            bail!("trip {} departure before arrival", r.trip_id);
        }
        if r.pickup_type.is_some_and(|v| v > 3) || r.drop_off_type.is_some_and(|v| v > 3) {
            bail!("invalid pickup_type/drop_off_type");
        }
        times[trip as usize].push((r, stop, arrival, departure));
    }
    for (trip, rows) in times.iter_mut().enumerate() {
        if rows.len() < 2 {
            bail!(
                "trip {} needs at least two stop_times",
                d.trips[trip].gtfs_id
            );
        }
        rows.sort_by_key(|r| r.0.stop_sequence);
        interpolate_stop_times(rows, &mut d, trip as u32)?;
        for w in rows.windows(2) {
            if w[0].0.stop_sequence == w[1].0.stop_sequence {
                bail!("duplicate stop_sequence");
            }
            if w[1].2 < w[0].3 {
                bail!("trip {} moves backward in time", d.trips[trip].gtfs_id);
            }
            d.connections.push(Connection {
                from: w[0].1,
                to: w[1].1,
                departure: w[0].3.expect("times validated or interpolated"),
                arrival: w[1].2.expect("times validated or interpolated"),
                trip: trip as u32,
                stop_sequence: w[0].0.stop_sequence,
                pickup_allowed: w[0].0.pickup_type.unwrap_or(0) == 0,
                dropoff_allowed: w[1].0.drop_off_type.unwrap_or(0) == 0,
            });
        }
    }
    d.connections
        .sort_by_key(|c| (c.departure, c.trip, c.stop_sequence));
    for r in load::<TransferRow>(
        &mut z,
        "transfers.txt",
        false,
        &["from_stop_id", "to_stop_id", "transfer_type"],
    )? {
        let rule = TransferRule {
            from: reference(&sm, &r.from_stop_id, "transfer stop")?,
            to: reference(&sm, &r.to_stop_id, "transfer stop")?,
            transfer_type: r.transfer_type.unwrap_or(0),
            min_transfer_time: r.min_transfer_time,
            from_route: optional_reference(&rm, r.from_route_id, "transfer route")?,
            to_route: optional_reference(&rm, r.to_route_id, "transfer route")?,
            from_trip: optional_reference(&tim, r.from_trip_id, "transfer trip")?,
            to_trip: optional_reference(&tim, r.to_trip_id, "transfer trip")?,
        };
        d.transfers.push(rule);
    }
    for r in load::<ShapeRow>(
        &mut z,
        "shapes.txt",
        false,
        &[
            "shape_id",
            "shape_pt_lat",
            "shape_pt_lon",
            "shape_pt_sequence",
        ],
    )? {
        d.shapes.push(ShapePoint {
            shape_id: r.shape_id,
            latitude: r.shape_pt_lat,
            longitude: r.shape_pt_lon,
            sequence: r.shape_pt_sequence,
            distance_traveled: r.shape_dist_traveled,
        });
    }
    d.shapes
        .sort_by(|a, b| (&a.shape_id, a.sequence).cmp(&(&b.shape_id, b.sequence)));
    for r in load::<FeedRow>(
        &mut z,
        "feed_info.txt",
        false,
        &["feed_publisher_name", "feed_publisher_url", "feed_lang"],
    )? {
        d.feed_info.push(FeedInfo {
            publisher_name: r.feed_publisher_name,
            publisher_url: r.feed_publisher_url,
            language: r.feed_lang,
            version: r.feed_version,
            start_date: r.feed_start_date.as_deref().map(date).transpose()?,
            end_date: r.feed_end_date.as_deref().map(date).transpose()?,
        });
    }
    d.footpaths = vec![vec![]; d.stops.len()];
    d.validate().map_err(anyhow::Error::msg)?;
    map_historical_stops(&mut d.stops, opt)?;
    d.footpaths = transfer_closure(&d)?;
    d.validate().map_err(anyhow::Error::msg)?;
    let mapped = d
        .stops
        .iter()
        .filter(|s| s.historical_vgn_id.is_some())
        .count();
    tracing::info!(
        gtfs_stops = d.stops.len(),
        mapped_historical = mapped,
        unmapped = d.stops.len() - mapped,
        trips = d.trips.len(),
        connections = d.connections.len(),
        transfers = d.transfers.len(),
        interpolated_stop_times = d.interpolated_stop_times.len(),
        "GTFS import complete"
    );
    Ok(d)
}
fn interpolate_stop_times(
    rows: &mut [ParsedStopTime],
    data: &mut StaticData,
    trip: u32,
) -> Result<()> {
    let name = &data.trips[trip as usize].gtfs_id;
    if rows.first().is_none_or(|r| r.2.is_none()) || rows.last().is_none_or(|r| r.2.is_none()) {
        bail!("trip {name} missing required first/last stop time");
    }
    for r in rows.iter() {
        if r.0
            .shape_dist_traveled
            .is_some_and(|v| !v.is_finite() || v < 0.)
        {
            bail!("trip {name} invalid shape_dist_traveled");
        }
    }
    let mut start = 0;
    while start + 1 < rows.len() {
        if rows[start + 1].2.is_some() {
            start += 1;
            continue;
        }
        let end = (start + 1..rows.len())
            .find(|&i| rows[i].2.is_some())
            .expect("last stop is timed");
        let lower = rows[start].3.expect("starting bound has departure");
        let upper = rows[end].2.expect("ending bound has arrival");
        if upper < lower {
            bail!("trip {name} interpolation bounds move backward in time");
        }
        let mut cumulative = vec![0.];
        let shape_distances = rows[start..=end]
            .iter()
            .all(|r| r.0.shape_dist_traveled.is_some());
        for i in start + 1..=end {
            let length = if shape_distances {
                let delta = rows[i].0.shape_dist_traveled.unwrap()
                    - rows[i - 1].0.shape_dist_traveled.unwrap();
                if delta < 0. {
                    bail!("trip {name} shape distances decrease");
                }
                delta
            } else {
                let a = &data.stops[rows[i - 1].1 as usize];
                let b = &data.stops[rows[i].1 as usize];
                distance_meters(a.latitude, a.longitude, b.latitude, b.longitude)
            };
            cumulative.push(cumulative.last().unwrap() + length);
        }
        let total = *cumulative.last().unwrap();
        for i in start + 1..end {
            let fraction = if total > 0. {
                cumulative[i - start] / total
            } else {
                (i - start) as f64 / (end - start) as f64
            };
            let time = lower + ((upper - lower) as f64 * fraction).round() as u32;
            rows[i].2 = Some(time);
            rows[i].3 = Some(time);
            data.interpolated_stop_times
                .push((trip, rows[i].0.stop_sequence));
        }
        start = end;
    }
    Ok(())
}

/// NFKC, case and punctuation normalization shared by name-based mapping.
pub fn normalize_stop_name(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn distance_meters(a: f64, b: f64, c: f64, d: f64) -> f64 {
    let lat = (c - a).to_radians();
    let lon = (d - b).to_radians();
    let h = (lat / 2.).sin().powi(2)
        + a.to_radians().cos() * c.to_radians().cos() * (lon / 2.).sin().powi(2);
    2. * 6_371_000. * h.sqrt().min(1.).asin()
}
fn similar_name(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let ac: Vec<_> = a.chars().collect();
    let bc: Vec<_> = b.chars().collect();
    // Bound edit distance; the geographic requirement always applies to fuzzy matches.
    let allowed = (ac.len().max(bc.len()) / 5).max(1);
    if ac.len().abs_diff(bc.len()) > allowed {
        return false;
    }
    let mut row: Vec<usize> = (0..=bc.len()).collect();
    for (i, c) in ac.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, d) in bc.iter().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (row[j] + 1)
                .min(old + 1)
                .min(previous + usize::from(c != d));
            previous = old;
        }
    }
    row[bc.len()] <= allowed
}

fn vgn_id_from_gtfs_stop_id(stop_id: &str) -> Option<i32> {
    let stop_id = stop_id.strip_prefix("Parent").unwrap_or(stop_id);
    let mut parts = stop_id.split(':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("de"), Some(area), Some(vgn_id))
            if !area.is_empty() && area.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            vgn_id.parse().ok()
        }
        _ => None,
    }
}

pub fn map_historical_stops(stops: &mut [Stop], opt: &ImportOptions) -> Result<()> {
    let mut catalog = HashMap::new();
    let mut by_name: HashMap<String, Vec<i32>> = HashMap::new();
    for h in &opt.historical_stops {
        if !valid_coordinates(h.latitude, h.longitude) || catalog.insert(h.id, h).is_some() {
            bail!("invalid or duplicate historical stop {}", h.id);
        }
        by_name
            .entry(normalize_stop_name(&h.name))
            .or_default()
            .push(h.id);
    }
    let existing: HashSet<_> = stops.iter().map(|s| s.gtfs_id.as_str()).collect();
    for key in opt.stop_overrides.keys() {
        if !existing.contains(key.as_str()) {
            bail!("override references unknown GTFS stop {key}");
        }
    }
    for s in stops.iter_mut() {
        s.historical_vgn_id = opt.stop_overrides.get(&s.gtfs_id).copied().or_else(|| {
            s.gtfs_id
                .parse::<i32>()
                .ok()
                .or_else(|| vgn_id_from_gtfs_stop_id(&s.gtfs_id))
                .filter(|id| catalog.contains_key(id))
        });
    }
    // Resolve parents first, including parents appearing after children in stops.txt.
    fn resolve(
        i: usize,
        stops: &mut [Stop],
        state: &mut [u8],
        by_name: &HashMap<String, Vec<i32>>,
        catalog: &HashMap<i32, &HistoricalStop>,
    ) -> Result<Option<i32>> {
        if state[i] == 2 {
            return Ok(stops[i].historical_vgn_id);
        }
        if state[i] == 1 {
            bail!("cyclic stop parent");
        }
        state[i] = 1;
        if stops[i].historical_vgn_id.is_none() {
            if let Some(p) = stops[i].parent_station {
                if p as usize >= stops.len() {
                    bail!("unknown stop parent");
                }
                stops[i].historical_vgn_id = resolve(p as usize, stops, state, by_name, catalog)?;
            }
        }
        if stops[i].historical_vgn_id.is_none() {
            let s = &stops[i];
            let name = normalize_stop_name(&s.name);
            // Multiple exact normalized matches remain unresolved, including at identical coordinates.
            let candidate = match by_name.get(&name) {
                Some(ids) if ids.len() == 1 && !name.is_empty() => Some(ids[0]),
                Some(_) => None,
                None => {
                    let mut ids = catalog
                        .values()
                        .filter(|h| {
                            distance_meters(s.latitude, s.longitude, h.latitude, h.longitude) < 150.
                                && similar_name(&name, &normalize_stop_name(&h.name))
                        })
                        .map(|h| h.id);
                    let first = ids.next();
                    if ids.next().is_none() {
                        first
                    } else {
                        None
                    }
                }
            };
            stops[i].historical_vgn_id = candidate;
        }
        state[i] = 2;
        Ok(stops[i].historical_vgn_id)
    }
    let mut state = vec![0; stops.len()];
    for i in 0..stops.len() {
        resolve(i, stops, &mut state, &by_name, &catalog)?;
    }
    Ok(())
}

/// Expand station rules to platforms and close the directed walking graph offline.
/// Scoped trip/route rules stay in `transfers` for the request-time CSA matcher.
pub fn transfer_closure(data: &StaticData) -> Result<Vec<Vec<Footpath>>> {
    let n = data.stops.len();
    let mut roots = vec![0; n];
    for (i, root) in roots.iter_mut().enumerate() {
        let mut cursor = i;
        let mut seen = HashSet::new();
        while let Some(p) = data.stops[cursor].parent_station {
            if p as usize >= n || !seen.insert(cursor) {
                bail!("invalid station hierarchy");
            }
            cursor = p as usize;
        }
        *root = cursor;
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, root) in roots.iter().enumerate() {
        groups.entry(*root).or_default().push(i);
    }
    let mut edges: Vec<HashMap<usize, u32>> = vec![HashMap::new(); n];
    for members in groups.values() {
        for &a in members {
            for &b in members {
                if a != b {
                    edges[a].insert(b, data.default_transfer_seconds);
                }
            }
        }
    }
    let mut descendants = vec![vec![]; n];
    for i in 0..n {
        let mut cursor = i;
        loop {
            descendants[cursor].push(i);
            match data.stops[cursor].parent_station {
                Some(p) => cursor = p as usize,
                None => break,
            }
        }
    }
    let mut banned = HashSet::new();
    let mut minimum = HashMap::new();
    let mut explicit = HashMap::new();
    for r in &data.transfers {
        if !r.is_generic() {
            continue;
        }
        if r.from as usize >= n || r.to as usize >= n {
            bail!("invalid transfer index");
        }
        for &from in &descendants[r.from as usize] {
            for &to in &descendants[r.to as usize] {
                if r.transfer_type == 3 {
                    banned.insert((from, to));
                    continue;
                }
                let duration = match r.transfer_type {
                    0 => data.default_transfer_seconds,
                    1 => r.min_transfer_time.unwrap_or(0),
                    2 => r
                        .min_transfer_time
                        .ok_or_else(|| anyhow!("minimum transfer missing min_transfer_time"))?,
                    _ => bail!("unsupported transfer type"),
                };
                if let Some(old) = explicit.insert((from, to), duration) {
                    if old != duration {
                        bail!("conflicting generic transfer rules");
                    }
                }
                edges[from].insert(to, duration);
                if r.transfer_type == 2 {
                    minimum.insert((from, to), duration);
                }
            }
        }
    }
    for &(a, b) in &banned {
        edges[a].remove(&b);
    }
    let mut closure = vec![vec![]; n];
    // Reuse sparse labels so disconnected station groups do not induce O(stops²) clearing.
    for (source, source_paths) in closure.iter_mut().enumerate() {
        let mut distances = HashMap::from([(source, 0u32)]);
        let mut queue = BinaryHeap::from([Reverse((0u32, source))]);
        while let Some(Reverse((cost, node))) = queue.pop() {
            if distances.get(&node) != Some(&cost) {
                continue;
            }
            for (&next, &weight) in &edges[node] {
                if banned.contains(&(source, next)) {
                    continue;
                }
                let next_cost = cost
                    .checked_add(weight)
                    .ok_or_else(|| anyhow!("transfer duration overflow"))?
                    .max(*minimum.get(&(source, next)).unwrap_or(&0));
                if distances.get(&next).is_none_or(|&v| next_cost < v) {
                    distances.insert(next, next_cost);
                    queue.push(Reverse((next_cost, next)));
                }
            }
        }
        for (to, duration) in distances {
            if to != source && !banned.contains(&(source, to)) {
                source_paths.push(Footpath {
                    to: to as u32,
                    duration: u16::try_from(duration)
                        .context("transfer closure exceeds 65535 seconds")?,
                });
            }
        }
        source_paths.sort_by_key(|p| p.to);
    }
    Ok(closure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture(replacements: &[(&str, &str)]) -> Vec<u8> {
        let defaults=[
   ("agency.txt","agency_id,agency_name,agency_url,agency_timezone\na,VGN,https://vgn.de,Europe/Berlin\n"),
   ("stops.txt","stop_id,stop_name,stop_lat,stop_lon,parent_station\nA,Alpha,49,11,\nB,Beta,49.001,11,\nC,Gamma,49.002,11,\n"),
   ("routes.txt","route_id,route_short_name,route_type\nr,U1,1\n"),
   ("trips.txt","route_id,service_id,trip_id,direction_id\nr,weekday:2026,t,0\n"),
   ("stop_times.txt","trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt,23:59:59,24:00:00,A,1,1,0\nt,25:30:12,25:30:12,B,2,0,1\nt,48:00:00,48:00:00,C,3,0,0\n"),
   ("calendar.txt","service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday:2026,1,1,1,1,1,0,0,20260101,20261231\n"),
  ];
        let mut files: HashMap<&str, &str> = defaults.into_iter().collect();
        for &(name, value) in replacements {
            if value == "REMOVE" {
                files.remove(name);
            } else {
                files.insert(name, value);
            }
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let mut names: Vec<_> = files.keys().copied().collect();
        names.sort();
        for name in names {
            zip.start_file(name, zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(files[name].as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn extended_service_times() {
        for (s, v) in [
            ("23:59:59", 86399),
            ("24:00:00", 86400),
            ("25:30:12", 91812),
            ("48:00:00", 172800),
        ] {
            assert_eq!(parse_service_time(s).unwrap().0, v);
        }
        for s in [
            "12:60:00",
            "12:00:60",
            "-1:00:00",
            "12:00",
            "4294967295:00:00",
        ] {
            assert!(parse_service_time(s).is_err());
        }
    }
    #[test]
    fn complete_import_and_compact_services() {
        let d = import_zip(&fixture(&[]), &ImportOptions::default()).unwrap();
        assert_eq!(d.service_ids, ["weekday:2026"]);
        assert_eq!(d.trips[0].service_id, 0);
        assert_eq!(d.connections.len(), 2);
        assert!(!d.connections[0].pickup_allowed);
        assert!(!d.connections[0].dropoff_allowed);
        assert_eq!(d.connections[0].stop_sequence, 1);
        assert_eq!(d.connections[1].arrival, 172800);
        assert_eq!(d.timezone, "Europe/Berlin");
    }
    #[test]
    fn calendar_exceptions_override_regular_service() {
        let d=import_zip(&fixture(&[("calendar_dates.txt","service_id,date,exception_type\nweekday:2026,20260918,2\nweekday:2026,20260919,1\nadded-only,20260920,1\n")]),&ImportOptions::default()).unwrap();
        assert_eq!(d.active_services(date("20260918").unwrap()), [false, false]);
        assert_eq!(d.active_services(date("20260919").unwrap()), [true, false]);
        assert_eq!(d.active_services(date("20260920").unwrap()), [false, true]);
    }
    #[test]
    fn exception_only_feed() {
        let d = import_zip(
            &fixture(&[
                ("calendar.txt", "REMOVE"),
                (
                    "calendar_dates.txt",
                    "service_id,date,exception_type\nweekday:2026,20260918,1\n",
                ),
            ]),
            &ImportOptions::default(),
        )
        .unwrap();
        assert_eq!(d.active_services(date("20260918").unwrap()), [true]);
        assert_eq!(d.active_services(date("20260919").unwrap()), [false]);
    }
    #[test]
    fn rejects_malformed_optional_files() {
        for (name, content) in [
            (
                "calendar_dates.txt",
                "service_id,date,exception_type\ns,garbage,1\n",
            ),
            (
                "transfers.txt",
                "from_stop_id,to_stop_id,transfer_type\nA,B,nope\n",
            ),
            (
                "shapes.txt",
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nx,bad,11,1\n",
            ),
            ("feed_info.txt", "bad_header\nx\n"),
            ("frequencies.txt", ""),
        ] {
            assert!(
                import_zip(&fixture(&[(name, content)]), &ImportOptions::default()).is_err(),
                "accepted {name}"
            );
        }
    }
    #[test]
    fn rejects_invalid_references_and_rows() {
        for (name,content) in [
  ("trips.txt","route_id,service_id,trip_id\nmissing,weekday:2026,t\n"),
  ("trips.txt","route_id,service_id,trip_id\nr,missing,t\n"),
  ("stop_times.txt","trip_id,arrival_time,departure_time,stop_id,stop_sequence\nmissing,01:00:00,01:00:00,A,1\n"),
  ("stop_times.txt","trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,01:00:00,01:00:00,missing,1\n"),
  ("transfers.txt","from_stop_id,to_stop_id,transfer_type,to_trip_id\nA,B,0,missing\n"),
  ("transfers.txt","from_stop_id,to_stop_id,transfer_type\nA,B,2\n"),
  ("calendar_dates.txt","service_id,date,exception_type\nweekday:2026,20260918,3\n"),
  ("agency.txt","agency_timezone\nNot/AZone\n"),
  ("stops.txt","stop_id,stop_name,stop_lat,stop_lon\nA,A,49,11\nA,A,49,11\n"),
 ] {assert!(import_zip(&fixture(&[(name,content)]),&ImportOptions::default()).is_err(),"accepted invalid {name}");}
    }
    #[test]
    fn rejects_backward_time_and_duplicate_sequence() {
        for content in [
  "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,01:00:00,00:59:00,A,1\nt,02:00:00,02:00:00,B,2\n",
  "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,02:00:00,02:00:00,A,1\nt,01:00:00,01:00:00,B,2\n",
  "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,01:00:00,01:00:00,A,1\nt,02:00:00,02:00:00,B,1\n",
 ] {assert!(import_zip(&fixture(&[("stop_times.txt",content)]),&ImportOptions::default()).is_err());}
    }
    fn stop(id: &str, name: &str, parent: Option<u32>) -> Stop {
        Stop {
            gtfs_id: id.into(),
            name: name.into(),
            latitude: 49.,
            longitude: 11.,
            parent_station: parent,
            historical_vgn_id: None,
        }
    }
    fn transfer(from: u32, to: u32, kind: u8, min: Option<u32>) -> TransferRule {
        TransferRule {
            from,
            to,
            transfer_type: kind,
            min_transfer_time: min,
            from_trip: None,
            to_trip: None,
            from_route: None,
            to_route: None,
        }
    }
    #[test]
    fn station_closure_minimum_and_indirect_ban() {
        let mut d = StaticData {
            stops: vec![
                stop("P", "Station", None),
                stop("A", "Platform A", Some(0)),
                stop("B", "Platform B", Some(0)),
                stop("C", "Platform C", Some(0)),
            ],
            ..Default::default()
        };
        d.transfers = vec![transfer(1, 2, 2, Some(300)), transfer(1, 3, 3, None)];
        let paths = transfer_closure(&d).unwrap();
        assert_eq!(paths[1].iter().find(|p| p.to == 2).unwrap().duration, 300);
        assert!(!paths[1].iter().any(|p| p.to == 3));
        assert!(paths[3].iter().any(|p| p.to == 1));
    }
    #[test]
    fn cross_station_closure_and_scoped_rules() {
        let mut d = StaticData {
            stops: vec![
                stop("A", "A", None),
                stop("B", "B", None),
                stop("C", "C", None),
            ],
            ..Default::default()
        };
        d.transfers = vec![transfer(0, 1, 2, Some(100)), transfer(1, 2, 2, Some(200))];
        let mut scoped = transfer(0, 2, 3, None);
        scoped.from_trip = Some(0);
        d.transfers.push(scoped);
        let paths = transfer_closure(&d).unwrap();
        assert_eq!(paths[0].iter().find(|p| p.to == 2).unwrap().duration, 300);
    }
    #[test]
    fn preserve_optional_shapes_and_feed_info() {
        let d=import_zip(&fixture(&[("shapes.txt","shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshape,49,11,1\n"),("trips.txt","route_id,service_id,trip_id,shape_id\nr,weekday:2026,t,shape\n"),("feed_info.txt","feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\nVGN,https://vgn.de,de,20260101,20261231,v1\n")]),&ImportOptions::default()).unwrap();
        assert_eq!(d.shapes.len(), 1);
        assert_eq!(d.trip_shapes[&0], "shape");
        assert_eq!(d.feed_info[0].version.as_deref(), Some("v1"));
    }
    #[test]
    fn mapping_priority_and_ambiguity() {
        let catalog = vec![
            HistoricalStop {
                id: 12,
                name: "Nürnberg Hbf".into(),
                latitude: 49.,
                longitude: 11.,
            },
            HistoricalStop {
                id: 13,
                name: "Duplicate".into(),
                latitude: 49.,
                longitude: 11.,
            },
            HistoricalStop {
                id: 14,
                name: "Duplicate".into(),
                latitude: 49.,
                longitude: 11.,
            },
        ];
        let options = ImportOptions {
            historical_stops: catalog,
            stop_overrides: HashMap::from([("forced".into(), 99)]),
            ..Default::default()
        };
        let mut stops = vec![
            stop("forced", "anything", None),
            stop("12", "anything", None),
            stop("de:09564:12:3:7", "different GTFS name", None),
            stop("Parentde:09564:12", "different parent name", None),
            stop("child", "unrelated", Some(1)),
            stop("named", "NÜRNBERG---HBF", None),
            stop("typo", "Nürnberg HbfX", None),
            stop("ambiguous", "Duplicate", None),
            stop("888", "Unknown", None),
        ];
        map_historical_stops(&mut stops, &options).unwrap();
        assert_eq!(
            stops
                .iter()
                .map(|s| s.historical_vgn_id)
                .collect::<Vec<_>>(),
            [
                Some(99),
                Some(12),
                Some(12),
                Some(12),
                Some(12),
                Some(12),
                Some(12),
                None,
                None
            ]
        );
    }
    #[test]
    fn fuzzy_mapping_requires_geo_and_unique_candidate() {
        let mut s = vec![stop("x", "Abcdefg", None)];
        let opt = ImportOptions {
            historical_stops: vec![HistoricalStop {
                id: 1,
                name: "Abcdefgh".into(),
                latitude: 50.,
                longitude: 11.,
            }],
            ..Default::default()
        };
        map_historical_stops(&mut s, &opt).unwrap();
        assert_eq!(s[0].historical_vgn_id, None);
    }
    #[test]
    fn product_and_override_config() {
        let mut opt = ImportOptions::default();
        ProductMapConfig::from_toml(
            "[route_types]\n\"1\"=2\n[line_overrides]\nU1=7\n[history_product]\n\"1\"=\"bus\"\n",
        )
        .unwrap()
        .apply(&mut opt)
        .unwrap();
        let d = import_zip(&fixture(&[]), &opt).unwrap();
        assert_eq!(d.routes[0].product, 7);
        assert_eq!(
            load_stop_overrides("stop_id,vgn_id\nA,123\n").unwrap()["A"],
            123
        );
    }
    #[test]
    fn named_product_config_and_rejected_names() {
        let mut opt = ImportOptions::default();
        ProductMapConfig::from_toml("[route_type]\n\"1\" = \"ubahn\"\n[line_override.\"U1\"]\nproduct = \"sbahn\"\n[history_product]\n\"2\" = \"ubahn\"\n").unwrap().apply(&mut opt).unwrap();
        assert_eq!(opt.product_map[&1], 2);
        assert_eq!(
            import_zip(&fixture(&[]), &opt).unwrap().routes[0].product,
            4
        );
        assert!(ProductMapConfig::from_toml("[route_type]\n\"1\" = \"typo\"").is_err());
        assert!(ProductMapConfig::from_toml("[line_override.\"S1\"]\nbad = \"sbahn\"").is_err());
    }
    #[test]
    fn parent_station_transfer_ban_covers_descendants() {
        let mut d = StaticData {
            stops: vec![
                stop("P", "Station", None),
                stop("A", "A", Some(0)),
                stop("B", "B", Some(0)),
                stop("Q", "Q", None),
            ],
            ..Default::default()
        };
        d.transfers = vec![transfer(0, 3, 3, None), transfer(1, 3, 2, Some(100))];
        let paths = transfer_closure(&d).unwrap();
        assert!(paths[0].iter().all(|p| p.to != 3));
        assert!(paths[1].iter().all(|p| p.to != 3));
        assert!(paths[2].iter().all(|p| p.to != 3));
    }
    #[test]
    fn multiple_nearby_fuzzy_names_are_unresolved() {
        let mut s = vec![stop("x", "Abcdefg", None)];
        let opt = ImportOptions {
            historical_stops: vec![
                HistoricalStop {
                    id: 1,
                    name: "Abcdefgh".into(),
                    latitude: 49.,
                    longitude: 11.,
                },
                HistoricalStop {
                    id: 2,
                    name: "Abcdefgi".into(),
                    latitude: 49.,
                    longitude: 11.,
                },
            ],
            ..Default::default()
        };
        map_historical_stops(&mut s, &opt).unwrap();
        assert_eq!(s[0].historical_vgn_id, None);
    }
    #[test]
    fn intermediate_times_are_interpolated_with_provenance() {
        let bytes = fixture(&[("stop_times.txt", "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,01:00:00,01:00:00,A,1\nt,,,B,2\nt,02:00:00,02:00:00,C,3\n")]);
        let d = import_zip(&bytes, &ImportOptions::default()).unwrap();
        assert_eq!(d.connections[0].arrival, 5400);
        assert_eq!(d.connections[1].departure, 5400);
        assert_eq!(d.interpolated_stop_times, vec![(0, 2)]);
    }
    #[test]
    fn missing_endpoints_or_exact_times_are_errors() {
        for rows in [
            "t,,,A,1,0\nt,02:00:00,02:00:00,B,2,1\n",
            "t,01:00:00,01:00:00,A,1,1\nt,,,B,2,0\n",
            "t,01:00:00,01:00:00,A,1,1\nt,,,B,2,1\nt,02:00:00,02:00:00,C,3,1\n",
        ] {
            let content = format!(
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint\n{rows}"
            );
            assert!(import_zip(
                &fixture(&[("stop_times.txt", &content)]),
                &ImportOptions::default()
            )
            .is_err());
        }
    }
    #[test]
    fn repeated_stop_interpolation_keeps_same_location_time() {
        let bytes=fixture(&[("stop_times.txt","trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,20:16:00,20:16:00,A,5\nt,,,A,6\nt,20:18:00,20:18:00,B,7\n")]);
        let d = import_zip(&bytes, &ImportOptions::default()).unwrap();
        assert_eq!(d.connections[0].departure, d.connections[0].arrival);
    }
}
