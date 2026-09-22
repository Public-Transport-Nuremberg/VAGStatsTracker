use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
pub type StopIdx = u32;
pub type TripIdx = u32;
pub type RouteIdx = u32;
pub type ConnectionIdx = u32;
pub type ServiceId = u32;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
pub struct ServiceTime(pub u32);
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stop {
    pub gtfs_id: String,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub parent_station: Option<StopIdx>,
    pub historical_vgn_id: Option<i32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Route {
    pub gtfs_id: String,
    pub short_name: String,
    pub long_name: String,
    pub route_type: i16,
    pub product: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Trip {
    pub gtfs_id: String,
    pub route: RouteIdx,
    pub service_id: u32,
    pub direction_id: Option<u8>,
    pub headsign: Option<String>,
    pub block_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub from: StopIdx,
    pub to: StopIdx,
    pub departure: u32,
    pub arrival: u32,
    pub trip: TripIdx,
    pub stop_sequence: u16,
    pub pickup_allowed: bool,
    pub dropoff_allowed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceCalendar {
    pub service_id: u32,
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub weekdays: [bool; 7],
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceException {
    pub service_id: u32,
    pub date: NaiveDate,
    pub added: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Footpath {
    pub to: StopIdx,
    pub duration: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferRule {
    pub from: StopIdx,
    pub to: StopIdx,
    pub transfer_type: u8,
    pub min_transfer_time: Option<u32>,
    pub from_route: Option<u32>,
    pub to_route: Option<u32>,
    pub from_trip: Option<u32>,
    pub to_trip: Option<u32>,
}
impl TransferRule {
    pub fn is_generic(&self) -> bool {
        self.from_route.is_none()
            && self.to_route.is_none()
            && self.from_trip.is_none()
            && self.to_trip.is_none()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShapePoint {
    pub shape_id: String,
    pub latitude: f64,
    pub longitude: f64,
    pub sequence: u32,
    pub distance_traveled: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeedInfo {
    pub publisher_name: String,
    pub publisher_url: String,
    pub language: String,
    pub version: Option<String>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StaticData {
    pub timezone: String,
    pub stops: Vec<Stop>,
    pub routes: Vec<Route>,
    pub trips: Vec<Trip>,
    pub connections: Vec<Connection>,
    pub calendar: Vec<ServiceCalendar>,
    pub exceptions: Vec<ServiceException>,
    pub footpaths: Vec<Vec<Footpath>>,
    pub transfers: Vec<TransferRule>,
    pub default_transfer_seconds: u32,
    #[serde(default)]
    pub service_ids: Vec<String>,
    #[serde(default)]
    pub shapes: Vec<ShapePoint>,
    #[serde(default)]
    pub trip_shapes: HashMap<TripIdx, String>,
    #[serde(default)]
    pub feed_info: Vec<FeedInfo>,
    /// (trip, stop_sequence) pairs whose times were interpolated during import.
    #[serde(default)]
    pub interpolated_stop_times: Vec<(TripIdx, u16)>,
}
impl Default for StaticData {
    fn default() -> Self {
        Self {
            timezone: "Europe/Berlin".into(),
            stops: vec![],
            routes: vec![],
            trips: vec![],
            connections: vec![],
            calendar: vec![],
            exceptions: vec![],
            footpaths: vec![],
            transfers: vec![],
            default_transfer_seconds: 120,
            service_ids: vec![],
            shapes: vec![],
            trip_shapes: HashMap::new(),
            feed_info: vec![],
            interpolated_stop_times: vec![],
        }
    }
}
impl StaticData {
    pub fn validate(&self) -> Result<(), String> {
        self.timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| "invalid agency timezone")?;
        if self.footpaths.len() != self.stops.len() {
            return Err("footpaths length must equal stops".into());
        }
        fn unique<'a>(mut ids: impl Iterator<Item = &'a str>) -> bool {
            let mut seen = HashSet::new();
            ids.all(|s| !s.is_empty() && seen.insert(s))
        }
        if !unique(self.stops.iter().map(|s| s.gtfs_id.as_str()))
            || !unique(self.routes.iter().map(|s| s.gtfs_id.as_str()))
            || !unique(self.trips.iter().map(|s| s.gtfs_id.as_str()))
            || !unique(self.service_ids.iter().map(String::as_str))
        {
            return Err("duplicate or empty identifier".into());
        }
        let valid_stop = |s: u32| (s as usize) < self.stops.len();
        let valid_route = |r: u32| (r as usize) < self.routes.len();
        let valid_trip = |t: u32| (t as usize) < self.trips.len();
        if self.routes.iter().any(|r| r.route_type < 0) {
            return Err("negative route_type".into());
        }
        for (i, s) in self.stops.iter().enumerate() {
            if !valid_coordinates(s.latitude, s.longitude) {
                return Err("invalid stop coordinates".into());
            }
            let mut seen = HashSet::from([i as u32]);
            let mut parent = s.parent_station;
            while let Some(p) = parent {
                if !valid_stop(p) || !seen.insert(p) {
                    return Err("invalid or cyclic parent_station".into());
                }
                parent = self.stops[p as usize].parent_station;
            }
        }
        let mut services = HashSet::new();
        let mut calendars = HashSet::new();
        let mut exceptions = HashSet::new();
        for c in &self.calendar {
            if c.start > c.end || !calendars.insert(c.service_id) {
                return Err("invalid or duplicate service calendar".into());
            }
            services.insert(c.service_id);
        }
        for e in &self.exceptions {
            if !exceptions.insert((e.service_id, e.date)) {
                return Err("duplicate calendar exception".into());
            }
            services.insert(e.service_id);
        }
        if !self.service_ids.is_empty()
            && services
                .iter()
                .any(|s| *s as usize >= self.service_ids.len())
        {
            return Err("service index out of range".into());
        }
        for t in &self.trips {
            if !valid_route(t.route)
                || !services.contains(&t.service_id)
                || t.direction_id.is_some_and(|d| d > 1)
            {
                return Err("invalid trip route/service/direction".into());
            }
        }
        let mut by_trip: HashMap<u32, Vec<&Connection>> = HashMap::new();
        for c in &self.connections {
            if !valid_stop(c.from) || !valid_stop(c.to) || !valid_trip(c.trip) {
                return Err("connection index out of range".into());
            }
            if c.arrival < c.departure {
                return Err("connection arrival before departure".into());
            }
            by_trip.entry(c.trip).or_default().push(c);
        }
        for cs in by_trip.values_mut() {
            cs.sort_by_key(|c| c.stop_sequence);
            for w in cs.windows(2) {
                if w[0].stop_sequence == w[1].stop_sequence
                    || w[0].to != w[1].from
                    || w[0].arrival > w[1].departure
                {
                    return Err("non-contiguous or non-monotonic trip connections".into());
                }
            }
        }
        for paths in &self.footpaths {
            let mut seen = HashSet::new();
            for p in paths {
                if !valid_stop(p.to) || !seen.insert(p.to) {
                    return Err("invalid or duplicate footpath destination".into());
                }
            }
        }
        for r in &self.transfers {
            if !valid_stop(r.from)
                || !valid_stop(r.to)
                || r.transfer_type > 3
                || (r.transfer_type == 2 && r.min_transfer_time.is_none())
                || r.from_route.is_some_and(|x| !valid_route(x))
                || r.to_route.is_some_and(|x| !valid_route(x))
                || r.from_trip.is_some_and(|x| !valid_trip(x))
                || r.to_trip.is_some_and(|x| !valid_trip(x))
            {
                return Err("invalid transfer rule".into());
            }
            for (trip, route) in [(r.from_trip, r.from_route), (r.to_trip, r.to_route)] {
                if let (Some(t), Some(r)) = (trip, route) {
                    if self.trips[t as usize].route != r {
                        return Err("transfer trip and route disagree".into());
                    }
                }
            }
        }
        let shape_ids: HashSet<_> = self.shapes.iter().map(|p| p.shape_id.as_str()).collect();
        let mut shape_seq = HashSet::new();
        for p in &self.shapes {
            if p.shape_id.is_empty()
                || !valid_coordinates(p.latitude, p.longitude)
                || p.distance_traveled
                    .is_some_and(|d| !d.is_finite() || d < 0.)
                || !shape_seq.insert((&p.shape_id, p.sequence))
            {
                return Err("invalid shape point".into());
            }
        }
        for (t, s) in &self.trip_shapes {
            if !valid_trip(*t) || !shape_ids.contains(s.as_str()) {
                return Err("unknown trip shape reference".into());
            }
        }
        for f in &self.feed_info {
            if matches!((f.start_date,f.end_date),(Some(a),Some(b)) if a>b) {
                return Err("invalid feed date range".into());
            }
        }
        if self
            .interpolated_stop_times
            .iter()
            .any(|(trip, _)| !valid_trip(*trip))
        {
            return Err("interpolated stop time references unknown trip".into());
        }
        Ok(())
    }
    pub fn active_services(&self, date: NaiveDate) -> Vec<bool> {
        let count = self.service_ids.len().max(
            self.calendar
                .iter()
                .map(|x| x.service_id as usize + 1)
                .chain(self.exceptions.iter().map(|x| x.service_id as usize + 1))
                .max()
                .unwrap_or(0),
        );
        let mut out = vec![false; count];
        let wd = date.weekday().num_days_from_monday() as usize;
        for c in &self.calendar {
            if date >= c.start && date <= c.end && c.weekdays[wd] {
                out[c.service_id as usize] = true;
            }
        }
        for e in &self.exceptions {
            if e.date == date {
                out[e.service_id as usize] = e.added;
            }
        }
        out
    }
}
pub fn valid_coordinates(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90. ..=90.).contains(&lat)
        && (-180. ..=180.).contains(&lon)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> StaticData {
        let date = NaiveDate::from_ymd_opt(2026, 9, 18).unwrap();
        StaticData {
            stops: (0..2)
                .map(|i| Stop {
                    gtfs_id: i.to_string(),
                    name: i.to_string(),
                    latitude: 49.,
                    longitude: 11.,
                    parent_station: None,
                    historical_vgn_id: None,
                })
                .collect(),
            routes: vec![Route {
                gtfs_id: "r".into(),
                short_name: "1".into(),
                long_name: "Route".into(),
                route_type: 3,
                product: 1,
            }],
            trips: vec![Trip {
                gtfs_id: "t".into(),
                route: 0,
                service_id: 0,
                direction_id: None,
                headsign: None,
                block_id: None,
            }],
            calendar: vec![ServiceCalendar {
                service_id: 0,
                start: date,
                end: date,
                weekdays: [true; 7],
            }],
            connections: vec![Connection {
                from: 0,
                to: 1,
                departure: 10,
                arrival: 20,
                trip: 0,
                stop_sequence: 1,
                pickup_allowed: true,
                dropoff_allowed: true,
            }],
            footpaths: vec![vec![], vec![]],
            ..Default::default()
        }
    }
    #[test]
    fn validates_numerical_references_and_time() {
        let d = model();
        assert!(d.validate().is_ok());
        let mut x = d.clone();
        x.connections[0].trip = 1;
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.connections[0].from = 2;
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.connections[0].arrival = 0;
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.trips[0].service_id = 1;
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.trips[0].route = 1;
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.footpaths[0].push(Footpath {
            to: 2,
            duration: 10,
        });
        assert!(x.validate().is_err());
    }
    #[test]
    fn validates_parents_calendar_and_coordinates() {
        let d = model();
        let mut x = d.clone();
        x.stops[0].parent_station = Some(1);
        x.stops[1].parent_station = Some(0);
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.stops[0].latitude = f64::NAN;
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.calendar.push(x.calendar[0].clone());
        assert!(x.validate().is_err());
        let mut x = d.clone();
        x.timezone = "Invalid".into();
        assert!(x.validate().is_err());
    }
}
