use anyhow::{anyhow, Result};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, TimeZone};
use chrono_tz::Tz;
use parking_lot::Mutex;
use router_model::{Connection, StaticData};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Leg {
    pub from: u32,
    pub to: u32,
    pub departure: i64,
    pub arrival: i64,
    pub trip: Option<u32>,
    pub route: Option<u32>,
    /// Distinguishes repeated instances of the same GTFS trip across midnight.
    pub service_date: Option<NaiveDate>,
    /// Required time from the previous transit arrival (walking or transfer minimum).
    pub transfer_seconds: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Journey {
    pub departure: i64,
    pub arrival: i64,
    pub legs: Vec<Leg>,
}
#[derive(Clone, Debug)]
pub struct RouteOptions {
    pub max_walk_seconds: u32,
    pub max_transfers: u16,
    pub allowed_products: Option<Vec<u8>>,
}
impl Default for RouteOptions {
    fn default() -> Self {
        Self {
            max_walk_seconds: u32::MAX,
            max_transfers: u16::MAX,
            allowed_products: None,
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Metrics {
    pub connections_scanned: u64,
    pub daygraph_builds: u64,
    pub daygraph_hits: u64,
    pub daygraph_misses: u64,
    pub daygraph_build_seconds: f64,
}
#[derive(Clone)]
struct TimedConnection {
    c: Connection,
    departure: i64,
    arrival: i64,
    instance: usize,
    date: NaiveDate,
    previous_sequence: Option<u16>,
}
struct DayGraph {
    connections: Vec<TimedConnection>,
    instances: usize,
}
struct Cache {
    cap: usize,
    map: HashMap<NaiveDate, Arc<DayGraph>>,
    lru: VecDeque<NaiveDate>,
}
pub struct Router {
    data: Arc<StaticData>,
    cache: Mutex<Cache>,
    horizon_seconds: u32,
    tz: Tz,
    scanned: AtomicU64,
    builds: AtomicU64,
    hits: AtomicU64,
    build_nanos: AtomicU64,
    previous_sequences: Vec<Option<u16>>,
    max_service_seconds: u32,
    // Numeric rule index includes parent-station rules at every descendant.
    rules_from: Vec<Vec<usize>>,
    // Trips with identical incoming rule applicability can share off-vehicle labels.
    incoming_classes: Vec<u32>,
}
#[derive(Clone)]
struct Path {
    previous: Option<usize>,
    leg: Leg,
}
#[derive(Clone)]
struct Label {
    arrival: i64,
    path: Option<usize>,
    walk: u32,
    boardings: u32,
    incoming: Option<u32>,
    incoming_trip: Option<u32>,
    alight_stop: u32,
    alight_time: i64,
    transfer_walk: u32,
}
#[derive(Clone)]
struct Onboard {
    path: usize,
    walk: u32,
    boardings: u32,
    sequence: u16,
    stop: u32,
    arrival: i64,
}
impl Router {
    pub fn new(data: Arc<StaticData>, cache_capacity: usize, horizon_seconds: u32) -> Result<Self> {
        data.validate().map_err(|e| anyhow!(e))?;
        let tz = data
            .timezone
            .parse()
            .map_err(|_| anyhow!("invalid timezone"))?;
        let mut by_trip = vec![Vec::new(); data.trips.len()];
        for (i, c) in data.connections.iter().enumerate() {
            by_trip[c.trip as usize].push((c.stop_sequence, i));
        }
        let mut previous_sequences = vec![None; data.connections.len()];
        for list in &mut by_trip {
            list.sort_unstable();
            for w in list.windows(2) {
                previous_sequences[w[1].1] = Some(w[0].0);
            }
        }
        let max_service_seconds = data
            .connections
            .iter()
            .map(|c| c.arrival.max(c.departure))
            .max()
            .unwrap_or(0);
        let mut direct_rules = vec![Vec::new(); data.stops.len()];
        for (i, rule) in data.transfers.iter().enumerate() {
            direct_rules[rule.from as usize].push(i);
        }
        let mut rules_from = vec![Vec::new(); data.stops.len()];
        for (stop, ids) in rules_from.iter_mut().enumerate() {
            let mut ancestor = Some(stop as u32);
            while let Some(index) = ancestor {
                ids.extend_from_slice(&direct_rules[index as usize]);
                ancestor = data.stops[index as usize].parent_station;
            }
        }
        let mut trip_rules = vec![Vec::new(); data.trips.len()];
        let mut route_rules = vec![Vec::new(); data.routes.len()];
        for (i, rule) in data.transfers.iter().enumerate() {
            if let Some(trip) = rule.from_trip {
                if rule
                    .from_route
                    .is_none_or(|route| data.trips[trip as usize].route == route)
                {
                    trip_rules[trip as usize].push(i);
                }
            } else if let Some(route) = rule.from_route {
                route_rules[route as usize].push(i);
            }
        }
        let mut classes = HashMap::new();
        let mut incoming_classes = Vec::with_capacity(data.trips.len());
        for (i, trip) in data.trips.iter().enumerate() {
            let mut signature = trip_rules[i].clone();
            signature.extend_from_slice(&route_rules[trip.route as usize]);
            signature.sort_unstable();
            let next = classes.len() as u32;
            incoming_classes.push(*classes.entry(signature).or_insert(next));
        }
        Ok(Self {
            data,
            cache: Mutex::new(Cache {
                cap: cache_capacity.max(1),
                map: HashMap::new(),
                lru: VecDeque::new(),
            }),
            horizon_seconds,
            tz,
            scanned: AtomicU64::new(0),
            builds: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            build_nanos: AtomicU64::new(0),
            previous_sequences,
            max_service_seconds,
            rules_from,
            incoming_classes,
        })
    }
    pub fn metrics(&self) -> Metrics {
        Metrics {
            connections_scanned: self.scanned.load(Ordering::Relaxed),
            daygraph_builds: self.builds.load(Ordering::Relaxed),
            daygraph_hits: self.hits.load(Ordering::Relaxed),
            daygraph_misses: self.builds.load(Ordering::Relaxed),
            daygraph_build_seconds: self.build_nanos.load(Ordering::Relaxed) as f64 / 1e9,
        }
    }
    fn base(&self, date: NaiveDate) -> Result<i64> {
        // GTFS explicitly defines service zero as local noon minus twelve elapsed hours.
        let noon = self
            .tz
            .from_local_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
            .single()
            .ok_or_else(|| anyhow!("ambiguous service noon"))?;
        Ok(noon.timestamp() - 43_200)
    }
    fn day(&self, date: NaiveDate) -> Result<Arc<DayGraph>> {
        let mut cache = self.cache.lock();
        if let Some(g) = cache.map.get(&date).cloned() {
            self.hits.fetch_add(1, Ordering::Relaxed);
            cache.lru.retain(|d| *d != date);
            cache.lru.push_back(date);
            return Ok(g);
        }
        let timer = Instant::now();
        // Include arbitrarily extended GTFS times and the FULL horizon of a query at 23:59.
        // Two extra days cover UTC offset transitions, including non-hour DST transitions.
        let previous_days = i64::from(self.max_service_seconds / 86_400) + 2;
        let future_days = i64::from(self.horizon_seconds / 86_400) + 3;
        let next_date = date
            .succ_opt()
            .ok_or_else(|| anyhow!("date out of range"))?;
        // Materialize only departures usable by a query on this calendar date.
        // A conservative fallback handles zones where local midnight does not exist.
        let first = self
            .tz
            .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .map(|t| t.timestamp())
            .unwrap_or(self.base(date)? - 86_400);
        let last = self
            .tz
            .from_local_datetime(&next_date.and_hms_opt(0, 0, 0).unwrap())
            .latest()
            .map(|t| t.timestamp())
            .unwrap_or(self.base(next_date)? + 86_400)
            + i64::from(self.horizon_seconds);
        let mut connections = Vec::new();
        let mut instances = 0;
        for offset in -previous_days..=future_days {
            let service_date = date
                .checked_add_signed(Duration::days(offset))
                .ok_or_else(|| anyhow!("date out of range"))?;
            let active = self.data.active_services(service_date);
            let base = self.base(service_date)?;
            let mut ids = vec![None; self.data.trips.len()];
            for (i, c) in self.data.connections.iter().enumerate() {
                let departure = base + i64::from(c.departure);
                let service = self.data.trips[c.trip as usize].service_id as usize;
                if departure >= first
                    && departure <= last
                    && active.get(service).copied().unwrap_or(false)
                {
                    let instance = *ids[c.trip as usize].get_or_insert_with(|| {
                        let id = instances;
                        instances += 1;
                        id
                    });
                    connections.push(TimedConnection {
                        c: c.clone(),
                        departure,
                        arrival: base + i64::from(c.arrival),
                        instance,
                        date: service_date,
                        previous_sequence: self.previous_sequences[i],
                    });
                }
            }
        }
        connections.sort_by_key(|x| (x.departure, x.arrival, x.instance, x.c.stop_sequence));
        let graph = Arc::new(DayGraph {
            connections,
            instances,
        });
        cache.map.insert(date, graph.clone());
        cache.lru.push_back(date);
        while cache.map.len() > cache.cap {
            if let Some(old) = cache.lru.pop_front() {
                cache.map.remove(&old);
            }
        }
        self.builds.fetch_add(1, Ordering::Relaxed);
        self.build_nanos.fetch_add(
            timer.elapsed().as_nanos().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        Ok(graph)
    }
    pub fn route(
        &self,
        from: u32,
        to: u32,
        departure: DateTime<FixedOffset>,
    ) -> Result<Option<Journey>> {
        self.route_with_options(from, to, departure, &RouteOptions::default())
    }
    pub fn route_with_options(
        &self,
        from: u32,
        to: u32,
        departure: DateTime<FixedOffset>,
        options: &RouteOptions,
    ) -> Result<Option<Journey>> {
        self.route_many_with_options(&[from], &[to], departure, options)
    }
    /// Route between sets of platform stops in one connection scan.
    /// The earliest arrival is selected, with boarding count and walking as tie breakers.
    pub fn route_many_with_options(
        &self,
        from: &[u32],
        to: &[u32],
        departure: DateTime<FixedOffset>,
        options: &RouteOptions,
    ) -> Result<Option<Journey>> {
        if from.is_empty() || to.is_empty() {
            return Err(anyhow!("source and target stop sets must not be empty"));
        }
        if from
            .iter()
            .chain(to)
            .any(|&s| s as usize >= self.data.stops.len())
        {
            return Err(anyhow!("stop index out of bounds"));
        }
        let start = departure.timestamp();
        let end = start + i64::from(self.horizon_seconds);
        let mut targets = vec![false; self.data.stops.len()];
        for &stop in to {
            targets[stop as usize] = true;
        }
        if from.iter().any(|s| targets[*s as usize]) {
            return Ok(Some(Journey {
                departure: start,
                arrival: start,
                legs: vec![],
            }));
        }
        let graph = self.day(departure.with_timezone(&self.tz).date_naive())?;
        let mut stops = vec![Vec::<Label>::new(); self.data.stops.len()];
        let mut onboard = vec![Vec::<Onboard>::new(); graph.instances];
        let mut paths = Vec::new();
        let initial = Label {
            arrival: start,
            path: None,
            walk: 0,
            boardings: 0,
            incoming: None,
            incoming_trip: None,
            alight_stop: from[0],
            alight_time: start,
            transfer_walk: 0,
        };
        for &source in from {
            let mut initial = initial.clone();
            initial.alight_stop = source;
            self.relax(source, initial, &mut stops, &mut paths, options, end);
        }
        let mut scanned = 0;
        let mut index = graph.connections.partition_point(|c| c.departure < start);
        while index < graph.connections.len() {
            let time = graph.connections[index].departure;
            let best = targets
                .iter()
                .enumerate()
                .filter(|(_, target)| **target)
                .flat_map(|(stop, _)| stops[stop].iter())
                .map(|l| l.arrival)
                .min()
                .unwrap_or(i64::MAX);
            if time > end || time >= best {
                break;
            }
            let batch_end =
                index + graph.connections[index..].partition_point(|c| c.departure == time);
            // A fixed point only within equal-time departures also handles zero-duration
            // connections and transfers independently of GTFS row/trip ordering.
            loop {
                let mut changed = false;
                for c in &graph.connections[index..batch_end] {
                    scanned += 1;
                    if c.arrival > end {
                        continue;
                    }
                    let route = self.data.trips[c.c.trip as usize].route;
                    if options
                        .allowed_products
                        .as_ref()
                        .is_some_and(|p| !p.contains(&self.data.routes[route as usize].product))
                    {
                        continue;
                    }
                    let mut candidates = Vec::new();
                    for state in &onboard[c.instance] {
                        if Some(state.sequence) == c.previous_sequence
                            && state.stop == c.c.from
                            && state.arrival <= c.departure
                        {
                            candidates.push((Some(state.path), state.walk, state.boardings, 0));
                        }
                    }
                    if c.c.pickup_allowed {
                        for label in &stops[c.c.from as usize] {
                            if label.arrival > c.departure
                                || label.boardings > u32::from(options.max_transfers)
                            {
                                continue;
                            }
                            let required = if let Some(old) = label.incoming_trip {
                                match self.transfer_requirement(
                                    label.alight_stop,
                                    c.c.from,
                                    old,
                                    c.c.trip,
                                    label.transfer_walk,
                                ) {
                                    Some(x) => x,
                                    None => continue,
                                }
                            } else {
                                0
                            };
                            if label.incoming.is_some()
                                && label.alight_time + i64::from(required) > c.departure
                            {
                                continue;
                            }
                            candidates.push((
                                label.path,
                                label.walk,
                                label.boardings + 1,
                                required,
                            ));
                        }
                    }
                    for (previous, walk, boardings, required) in candidates {
                        // On a vehicle, only resource consumption matters for this exact segment.
                        if onboard[c.instance].iter().any(|s| {
                            s.sequence == c.c.stop_sequence
                                && s.walk <= walk
                                && s.boardings <= boardings
                        }) {
                            continue;
                        }
                        let path = paths.len();
                        paths.push(Path {
                            previous,
                            leg: Leg {
                                from: c.c.from,
                                to: c.c.to,
                                departure: c.departure,
                                arrival: c.arrival,
                                trip: Some(c.c.trip),
                                route: Some(route),
                                service_date: Some(c.date),
                                transfer_seconds: required,
                            },
                        });
                        onboard[c.instance].retain(|s| {
                            s.sequence != c.c.stop_sequence
                                || !(walk <= s.walk && boardings <= s.boardings)
                        });
                        onboard[c.instance].push(Onboard {
                            path,
                            walk,
                            boardings,
                            sequence: c.c.stop_sequence,
                            stop: c.c.to,
                            arrival: c.arrival,
                        });
                        changed |= c.arrival == time;
                        if c.c.dropoff_allowed {
                            let label = Label {
                                arrival: c.arrival,
                                path: Some(path),
                                walk,
                                boardings,
                                incoming: Some(self.incoming_classes[c.c.trip as usize]),
                                incoming_trip: Some(c.c.trip),
                                alight_stop: c.c.to,
                                alight_time: c.arrival,
                                transfer_walk: 0,
                            };
                            self.relax(c.c.to, label, &mut stops, &mut paths, options, end);
                        }
                    }
                }
                if !changed {
                    break;
                }
            }
            index = batch_end;
        }
        self.scanned.fetch_add(scanned, Ordering::Relaxed);
        let Some(best) = targets
            .iter()
            .enumerate()
            .filter(|(_, target)| **target)
            .flat_map(|(stop, _)| stops[stop].iter())
            .min_by_key(|l| (l.arrival, l.boardings, l.walk))
        else {
            return Ok(None);
        };
        let mut legs = Vec::new();
        let mut p = best.path;
        while let Some(i) = p {
            let node = &paths[i];
            legs.push(node.leg.clone());
            p = node.previous;
        }
        legs.reverse();
        let mut merged: Vec<Leg> = Vec::new();
        for leg in legs {
            if let Some(last) = merged.last_mut() {
                if leg.trip.is_some()
                    && last.trip == leg.trip
                    && last.service_date == leg.service_date
                    && last.to == leg.from
                    && leg.transfer_seconds == 0
                {
                    last.to = leg.to;
                    last.arrival = leg.arrival;
                    continue;
                }
            }
            merged.push(leg);
        }
        Ok(Some(Journey {
            departure: merged.first().map_or(start, |l| l.departure),
            arrival: best.arrival,
            legs: merged,
        }))
    }
    fn relax(
        &self,
        stop: u32,
        label: Label,
        stops: &mut [Vec<Label>],
        paths: &mut Vec<Path>,
        options: &RouteOptions,
        end: i64,
    ) {
        if label.arrival > end || !insert_label(&mut stops[stop as usize], label.clone()) {
            return;
        }
        // Snapshot footpaths are the precomputed transitive closure: never recursively
        // walk the network, which could also evade an origin-to-destination prohibition.
        for f in &self.data.footpaths[stop as usize] {
            let Some(walk) = label.walk.checked_add(u32::from(f.duration)) else {
                continue;
            };
            if walk > options.max_walk_seconds || self.generic_walk_banned(stop, f.to) {
                continue;
            }
            let arrival = label.arrival + i64::from(f.duration);
            if arrival > end {
                continue;
            }
            let mut next = label.clone();
            next.arrival = arrival;
            next.walk = walk;
            next.transfer_walk += u32::from(f.duration);
            let path = paths.len();
            next.path = Some(path);
            if insert_label(&mut stops[f.to as usize], next) {
                paths.push(Path {
                    previous: label.path,
                    leg: Leg {
                        from: stop,
                        to: f.to,
                        departure: label.arrival,
                        arrival,
                        trip: None,
                        route: None,
                        service_date: None,
                        transfer_seconds: 0,
                    },
                });
            }
        }
    }
    fn generic_walk_banned(&self, from: u32, to: u32) -> bool {
        self.rules_from[from as usize].iter().any(|&i| {
            let r = &self.data.transfers[i];
            r.transfer_type == 3
                && r.from_trip.is_none()
                && r.to_trip.is_none()
                && r.from_route.is_none()
                && r.to_route.is_none()
                && matches_stop(&self.data, r.to, to)
        })
    }
    /// Minimum elapsed seconds since incoming arrival; None means forbidden.
    /// Walking is included, rather than added a second time to GTFS minimum time.
    pub fn transfer_requirement(
        &self,
        from: u32,
        to: u32,
        incoming: u32,
        outgoing: u32,
        walking: u32,
    ) -> Option<u32> {
        if from as usize >= self.data.stops.len()
            || to as usize >= self.data.stops.len()
            || incoming as usize >= self.data.trips.len()
            || outgoing as usize >= self.data.trips.len()
        {
            return None;
        }
        let old_route = self.data.trips[incoming as usize].route;
        let new_route = self.data.trips[outgoing as usize].route;
        let mut selected: Option<(u8, Option<u32>)> = None;
        for &i in &self.rules_from[from as usize] {
            let r = &self.data.transfers[i];
            if !matches_stop(&self.data, r.to, to)
                || r.from_trip.is_some_and(|x| x != incoming)
                || r.to_trip.is_some_and(|x| x != outgoing)
                || r.from_route.is_some_and(|x| x != old_route)
                || r.to_route.is_some_and(|x| x != new_route)
            {
                continue;
            }
            let specificity = (r.from_trip.is_some() as u8 + r.to_trip.is_some() as u8) * 16
                + (r.from_route.is_some() as u8 + r.to_route.is_some() as u8) * 4
                + (r.from == from) as u8
                + (r.to == to) as u8;
            let requirement = match r.transfer_type {
                3 => None,
                1 => Some(r.min_transfer_time.unwrap_or(0)),
                _ => Some(
                    r.min_transfer_time
                        .unwrap_or(self.data.default_transfer_seconds),
                ),
            };
            match &mut selected {
                None => selected = Some((specificity, requirement)),
                Some((rank, value)) if specificity > *rank => {
                    *rank = specificity;
                    *value = requirement;
                }
                Some((rank, value)) if specificity == *rank => {
                    *value = match (*value, requirement) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        _ => None,
                    };
                }
                _ => {}
            }
        }
        selected
            .map_or(Some(self.data.default_transfer_seconds), |(_, v)| v)
            .map(|minimum| minimum.max(walking))
    }
}
fn matches_stop(data: &StaticData, rule: u32, mut actual: u32) -> bool {
    for _ in 0..=data.stops.len() {
        if rule == actual {
            return true;
        }
        match data
            .stops
            .get(actual as usize)
            .and_then(|s| s.parent_station)
        {
            Some(p) => actual = p,
            None => return false,
        }
    }
    false
}
fn insert_label(labels: &mut Vec<Label>, new: Label) -> bool {
    let same = |a: &Label, b: &Label| a.incoming == b.incoming && a.alight_stop == b.alight_stop;
    let dominates = |a: &Label, b: &Label| {
        a.arrival <= b.arrival
            && a.alight_time <= b.alight_time
            && a.walk <= b.walk
            && a.boardings <= b.boardings
            && a.transfer_walk <= b.transfer_walk
    };
    if labels.iter().any(|l| same(l, &new) && dominates(l, &new)) {
        return false;
    }
    labels.retain(|l| !same(l, &new) || !dominates(&new, l));
    labels.push(new);
    true
}

#[cfg(test)]
mod tests;
