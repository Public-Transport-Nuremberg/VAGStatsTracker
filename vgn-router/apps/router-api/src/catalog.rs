use router_model::{StaticData, Stop};
use rstar::{PointDistance, RTree, RTreeObject, AABB};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const EARTH_METERS: f64 = 6_371_000.0;

fn point(lat: f64, lon: f64) -> [f64; 3] {
    let (lat, lon) = (lat.to_radians(), lon.to_radians());
    [lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()]
}

#[derive(Clone)]
struct IndexedStop {
    index: u32,
    point: [f64; 3],
}
impl RTreeObject for IndexedStop {
    type Envelope = AABB<[f64; 3]>;
    fn envelope(&self) -> Self::Envelope {
        AABB::from_point(self.point)
    }
}
impl PointDistance for IndexedStop {
    fn distance_2(&self, point: &[f64; 3]) -> f64 {
        self.point
            .iter()
            .zip(point)
            .map(|(a, b)| (a - b).powi(2))
            .sum()
    }
}

pub struct Catalog {
    pub ids: HashMap<String, u32>,
    names: Vec<String>,
    station_ids: HashMap<i32, Vec<u32>>,
    station_names: HashMap<String, Vec<Vec<u32>>>,
    boarding_products: Vec<HashSet<u8>>,
    alighting_products: Vec<HashSet<u8>>,
    tree: RTree<IndexedStop>,
}

#[derive(Serialize)]
pub struct StopInfo<'a> {
    pub stop_id: &'a str,
    pub name: &'a str,
    pub latitude: f64,
    pub longitude: f64,
    pub historical_vgn_id: Option<i32>,
    pub statistics_available: bool,
}
impl<'a> From<&'a Stop> for StopInfo<'a> {
    fn from(stop: &'a Stop) -> Self {
        Self {
            stop_id: &stop.gtfs_id,
            name: &stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            historical_vgn_id: stop.historical_vgn_id,
            statistics_available: false,
        }
    }
}

impl Catalog {
    pub fn new(data: &StaticData) -> Self {
        Self::with_station_names(data, &HashMap::new())
    }

    pub fn with_station_names(data: &StaticData, canonical_names: &HashMap<i32, String>) -> Self {
        let ids = data
            .stops
            .iter()
            .enumerate()
            .map(|(i, s)| (s.gtfs_id.clone(), i as u32))
            .collect();
        let names: Vec<String> = data.stops.iter().map(|s| search_name(&s.name)).collect();
        let mut station_ids: HashMap<i32, Vec<u32>> = HashMap::new();
        for (i, stop) in data.stops.iter().enumerate() {
            if let Some(id) = stop.historical_vgn_id {
                station_ids.entry(id).or_default().push(i as u32);
            }
        }
        // Parent/child nodes may not all have an override. Include a station's
        // GTFS parent and its immediate children when one of its mapped stops
        // identifies that parent.
        for stops in station_ids.values_mut() {
            let parents: HashSet<_> = stops
                .iter()
                .filter_map(|i| data.stops[*i as usize].parent_station)
                .collect();
            for (i, stop) in data.stops.iter().enumerate() {
                if parents.contains(&(i as u32))
                    || stop.parent_station.is_some_and(|p| parents.contains(&p))
                {
                    stops.push(i as u32);
                }
            }
            stops.sort_unstable();
            stops.dedup();
        }
        // A name resolves to a station group: historical ID first, then a
        // GTFS parent station, and finally a standalone stop.
        let mut station_names: HashMap<String, Vec<Vec<u32>>> = HashMap::new();
        for (i, stop) in data.stops.iter().enumerate() {
            if names[i].is_empty() {
                continue;
            }
            let mut group = if let Some(id) = stop.historical_vgn_id {
                station_ids.get(&id).cloned().unwrap_or_default()
            } else if let Some(parent) = stop.parent_station {
                data.stops
                    .iter()
                    .enumerate()
                    .filter(|(j, s)| *j as u32 == parent || s.parent_station == Some(parent))
                    .map(|(j, _)| j as u32)
                    .collect()
            } else {
                vec![i as u32]
            };
            if group.is_empty() {
                group.push(i as u32);
            }
            group.sort_unstable();
            group.dedup();
            let groups = station_names.entry(names[i].clone()).or_default();
            if !groups.contains(&group) {
                groups.push(group);
            }
        }
        for (id, canonical_name) in canonical_names {
            let Some(group) = station_ids.get(id) else {
                continue;
            };
            let normalized = search_name(canonical_name);
            if normalized.is_empty() {
                continue;
            }
            let groups = station_names.entry(normalized).or_default();
            if !groups.contains(group) {
                groups.push(group.clone());
            }
        }
        let mut boarding_products = vec![HashSet::new(); data.stops.len()];
        let mut alighting_products = vec![HashSet::new(); data.stops.len()];
        for connection in &data.connections {
            let route = &data.routes[data.trips[connection.trip as usize].route as usize];
            if connection.pickup_allowed {
                boarding_products[connection.from as usize].insert(route.product);
            }
            if connection.dropoff_allowed {
                alighting_products[connection.to as usize].insert(route.product);
            }
        }
        let tree = RTree::bulk_load(
            data.stops
                .iter()
                .enumerate()
                .map(|(i, s)| IndexedStop {
                    index: i as u32,
                    point: point(s.latitude, s.longitude),
                })
                .collect(),
        );
        Self {
            ids,
            names,
            station_ids,
            station_names,
            boarding_products,
            alighting_products,
            tree,
        }
    }

    pub fn by_station_id(&self, id: i32) -> Option<Vec<u32>> {
        self.station_ids.get(&id).cloned()
    }

    pub fn by_exact_name(&self, name: &str) -> Vec<Vec<u32>> {
        let query = search_name(name);
        if query.is_empty() {
            return Vec::new();
        }
        self.station_names.get(&query).cloned().unwrap_or_default()
    }

    pub fn filter_products(
        &self,
        stops: Vec<u32>,
        allowed: Option<&[u8]>,
        origin: bool,
    ) -> Vec<u32> {
        let Some(allowed) = allowed else {
            return stops;
        };
        stops
            .into_iter()
            .filter(|i| {
                let products = if origin {
                    &self.boarding_products[*i as usize]
                } else {
                    &self.alighting_products[*i as usize]
                };
                products.iter().any(|p| allowed.contains(p))
            })
            .collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<u32> {
        let query = search_name(query);
        if query.is_empty() {
            return Vec::new();
        }
        self.names
            .iter()
            .enumerate()
            .filter(|(_, name)| name.contains(&query))
            .take(limit)
            .map(|(i, _)| i as u32)
            .collect()
    }

    pub fn near(
        &self,
        latitude: f64,
        longitude: f64,
        radius: f64,
        limit: usize,
    ) -> Vec<(u32, f64)> {
        let here = point(latitude, longitude);
        let chord = 2.0 * (radius / (2.0 * EARTH_METERS)).sin();
        let mut matches: Vec<_> = self
            .tree
            .locate_within_distance(here, chord * chord)
            .map(|s| {
                (
                    s.index,
                    2.0 * EARTH_METERS * (s.distance_2(&here).sqrt() / 2.0).min(1.0).asin(),
                )
            })
            .collect();
        matches.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        matches.truncate(limit);
        matches
    }
}

// Manual Override for specific station name normalization
fn search_name(value: &str) -> String {
    history::normalize(value)
        .split_whitespace()
        .map(|word| if word == "hauptbahnhof" { "hbf" } else { word })
        .collect::<Vec<_>>()
        .join(" ")
}
