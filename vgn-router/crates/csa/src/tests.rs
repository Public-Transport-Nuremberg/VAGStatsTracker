use super::*;
use router_model::{Footpath, Route, ServiceCalendar, Stop, TransferRule, Trip};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
fn date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 9, 18).unwrap()
}
fn fixture(n: usize) -> StaticData {
    StaticData {
        timezone: "Europe/Berlin".into(),
        stops: (0..n)
            .map(|i| Stop {
                gtfs_id: i.to_string(),
                name: i.to_string(),
                latitude: 0.,
                longitude: 0.,
                parent_station: None,
                historical_vgn_id: None,
            })
            .collect(),
        routes: vec![Route {
            gtfs_id: "r".into(),
            short_name: "r".into(),
            long_name: "r".into(),
            route_type: 3,
            product: 1,
        }],
        calendar: vec![ServiceCalendar {
            service_id: 0,
            start: date() - Duration::days(400),
            end: date() + Duration::days(400),
            weekdays: [true; 7],
        }],
        footpaths: vec![vec![]; n],
        default_transfer_seconds: 120,
        ..Default::default()
    }
}
fn trip(d: &mut StaticData, edges: &[(u32, u32, u32, u32)]) -> u32 {
    let id = d.trips.len() as u32;
    d.trips.push(Trip {
        gtfs_id: id.to_string(),
        route: 0,
        service_id: 0,
        direction_id: None,
        headsign: None,
        block_id: None,
    });
    for (i, &(from, to, departure, arrival)) in edges.iter().enumerate() {
        d.connections.push(Connection {
            from,
            to,
            departure,
            arrival,
            trip: id,
            stop_sequence: i as u16 + 1,
            pickup_allowed: true,
            dropoff_allowed: true,
        });
    }
    id
}
fn router(d: StaticData) -> Router {
    Router::new(Arc::new(d), 8, 36 * 3600).unwrap()
}
fn time(date: NaiveDate, seconds: i64) -> DateTime<FixedOffset> {
    chrono_tz::Europe::Berlin
        .from_local_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
        .single()
        .unwrap()
        .fixed_offset()
        - Duration::hours(12)
        + Duration::seconds(seconds)
}
fn run(r: &Router, a: u32, b: u32, t: i64) -> Journey {
    r.route(a, b, time(date(), t)).unwrap().unwrap()
}
#[test]
fn multi_platform_routes_from_and_to_all_stops_in_one_search() {
    let mut d = fixture(6);
    trip(&mut d, &[(0, 4, 100, 300)]);
    trip(&mut d, &[(1, 5, 110, 200)]);
    trip(&mut d, &[(3, 4, 90, 150)]);
    let r = router(d);
    let j = r
        .route_many_with_options(&[0, 1], &[4, 5], time(date(), 0), &RouteOptions::default())
        .unwrap()
        .unwrap();
    assert_eq!(j.arrival, time(date(), 200).timestamp());
    assert_eq!(j.legs[0].from, 1);

    // Destination alternatives are considered globally, including one that is also a source.
    let j = r
        .route_many_with_options(&[0, 2], &[2, 5], time(date(), 0), &RouteOptions::default())
        .unwrap()
        .unwrap();
    assert_eq!(j.arrival, time(date(), 0).timestamp());
    assert!(j.legs.is_empty());
}

#[test]
fn multi_platform_rejects_empty_or_out_of_range_stop_sets() {
    let r = router(fixture(2));
    let at = time(date(), 0);
    assert!(r
        .route_many_with_options(&[], &[1], at, &RouteOptions::default())
        .is_err());
    assert!(r
        .route_many_with_options(&[0], &[], at, &RouteOptions::default())
        .is_err());
    assert!(r
        .route_many_with_options(&[2], &[1], at, &RouteOptions::default())
        .is_err());
    assert!(r
        .route_many_with_options(&[0], &[2], at, &RouteOptions::default())
        .is_err());
}

fn rule(from: u32, to: u32, kind: u8, min: Option<u32>) -> TransferRule {
    TransferRule {
        from,
        to,
        transfer_type: kind,
        min_transfer_time: min,
        from_route: None,
        to_route: None,
        from_trip: None,
        to_trip: None,
    }
}
#[test]
fn overtaking_default_transfer_and_destination_time() {
    let mut d = fixture(3);
    trip(&mut d, &[(0, 1, 100, 600)]);
    trip(&mut d, &[(0, 1, 200, 300)]);
    trip(&mut d, &[(1, 2, 419, 450)]);
    trip(&mut d, &[(1, 2, 420, 500)]);
    let r = router(d);
    let j = run(&r, 0, 2, 0);
    assert_eq!(j.arrival, time(date(), 500).timestamp());
    assert_eq!(j.legs[0].trip, Some(1));
    assert_eq!(j.legs[1].transfer_seconds, 120);
    assert_eq!(run(&r, 0, 1, 0).arrival, time(date(), 300).timestamp());
    assert_eq!(r.metrics().daygraph_builds, 1);
    assert_eq!(r.metrics().daygraph_hits, 1);
}
#[test]
fn continuation_pickup_dropoff_and_immutable_path() {
    let mut d = fixture(4);
    trip(
        &mut d,
        &[(0, 1, 100, 200), (1, 2, 210, 300), (2, 3, 310, 400)],
    );
    d.connections[0].dropoff_allowed = false;
    d.connections[1].pickup_allowed = false;
    d.connections[1].dropoff_allowed = false;
    d.connections[2].pickup_allowed = false;
    trip(&mut d, &[(0, 1, 150, 160)]);
    let r = router(d);
    let j = run(&r, 0, 3, 0);
    assert_eq!(j.legs.len(), 1);
    assert_eq!((j.legs[0].from, j.legs[0].to), (0, 3));
    assert_eq!(j.arrival, time(date(), 400).timestamp());
    assert!(r.route(1, 3, time(date(), 201)).unwrap().is_none());
}
#[test]
fn forbidden_pickup_and_dropoff() {
    let mut d = fixture(2);
    trip(&mut d, &[(0, 1, 100, 200)]);
    d.connections[0].pickup_allowed = false;
    assert!(router(d.clone())
        .route(0, 1, time(date(), 0))
        .unwrap()
        .is_none());
    d.connections[0].pickup_allowed = true;
    d.connections[0].dropoff_allowed = false;
    assert!(router(d).route(0, 1, time(date(), 0)).unwrap().is_none());
}
#[test]
fn scoped_ban_preserves_alternate_arrival_and_walk_context() {
    let mut d = fixture(4);
    let bad = trip(&mut d, &[(0, 1, 100, 200)]);
    let good = trip(&mut d, &[(0, 1, 110, 250)]);
    let out = trip(&mut d, &[(2, 3, 500, 600)]);
    d.footpaths[1].push(Footpath {
        to: 2,
        duration: 40,
    });
    let mut ban = rule(1, 2, 3, None);
    ban.from_trip = Some(bad);
    ban.to_trip = Some(out);
    d.transfers.push(ban);
    let r = router(d);
    let j = run(&r, 0, 3, 0);
    assert_eq!(j.legs[0].trip, Some(good));
    assert_eq!(j.legs[1].trip, None);
    assert_eq!(j.legs[2].transfer_seconds, 120);
}
#[test]
fn station_rules_and_minimum_override() {
    let mut d = fixture(5);
    d.stops[1].parent_station = Some(4);
    d.stops[2].parent_station = Some(4);
    let incoming = trip(&mut d, &[(0, 1, 100, 200)]);
    let outgoing = trip(&mut d, &[(2, 3, 350, 400)]);
    d.footpaths[1].push(Footpath {
        to: 2,
        duration: 50,
    });
    d.transfers.push(rule(4, 4, 2, Some(200)));
    assert_ne!(
        run(&router(d.clone()), 0, 3, 0).arrival,
        time(date(), 400).timestamp()
    );
    let mut timed = rule(4, 4, 1, None);
    timed.from_trip = Some(incoming);
    timed.to_trip = Some(outgoing);
    d.transfers.push(timed);
    let j = run(&router(d), 0, 3, 0);
    assert_eq!(j.arrival, time(date(), 400).timestamp());
    assert_eq!(j.legs.last().unwrap().transfer_seconds, 50);
}
#[test]
fn generic_cross_stop_ban_cannot_be_bypassed() {
    let mut d = fixture(4);
    trip(&mut d, &[(0, 1, 100, 200)]);
    trip(&mut d, &[(2, 3, 500, 600)]);
    d.footpaths[1].push(Footpath {
        to: 2,
        duration: 40,
    });
    d.transfers.push(rule(1, 2, 3, None));
    assert!(router(d).route(0, 3, time(date(), 0)).unwrap().is_none());
}
#[test]
fn walking_transfers_products_constraints() {
    let mut d = fixture(4);
    trip(&mut d, &[(0, 1, 100, 200)]);
    trip(&mut d, &[(2, 3, 500, 600)]);
    d.footpaths[1].push(Footpath {
        to: 2,
        duration: 60,
    });
    let r = router(d);
    let mut opts = RouteOptions {
        max_walk_seconds: 59,
        ..Default::default()
    };
    assert!(r
        .route_with_options(0, 3, time(date(), 0), &opts)
        .unwrap()
        .is_none());
    opts.max_walk_seconds = 60;
    opts.max_transfers = 0;
    assert!(r
        .route_with_options(0, 3, time(date(), 0), &opts)
        .unwrap()
        .is_none());
    opts.max_transfers = 1;
    assert_eq!(
        r.route_with_options(0, 3, time(date(), 0), &opts)
            .unwrap()
            .unwrap()
            .legs
            .len(),
        3
    );
    opts.allowed_products = Some(vec![2]);
    assert!(r
        .route_with_options(0, 3, time(date(), 0), &opts)
        .unwrap()
        .is_none());
}
#[test]
fn previous_48h_and_next_next_day_horizon() {
    let mut d = fixture(2);
    trip(&mut d, &[(0, 1, 48 * 3600 + 100, 48 * 3600 + 200)]);
    d.calendar[0].start = date() - Duration::days(2);
    d.calendar[0].end = d.calendar[0].start;
    let j = run(&router(d), 0, 1, 0);
    assert_eq!(j.arrival, time(date(), 200).timestamp());
    assert_eq!(j.legs[0].service_date, Some(date() - Duration::days(2)));
    let mut d = fixture(2);
    trip(&mut d, &[(0, 1, 3600, 3700)]);
    d.calendar[0].start = date() + Duration::days(2);
    d.calendar[0].end = d.calendar[0].start;
    let j = run(&router(d), 0, 1, 23 * 3600 + 59 * 60);
    assert_eq!(
        j.arrival,
        time(date() + Duration::days(2), 3700).timestamp()
    );
}
#[test]
fn service_instances_do_not_teleport() {
    let mut d = fixture(3);
    trip(&mut d, &[(0, 1, 0, 10), (1, 2, 20, 30)]);
    d.connections[1].pickup_allowed = false;
    let r = router(d);
    let j = run(&r, 0, 2, 0);
    assert_eq!(j.legs.len(), 1);
    assert_eq!(j.arrival, time(date(), 30).timestamp());
    assert!(r.route(1, 2, time(date(), 15)).unwrap().is_none());
}
#[test]
fn dst_noon_minus_twelve_and_elapsed_horizon() {
    for day in [
        NaiveDate::from_ymd_opt(2026, 3, 29).unwrap(),
        NaiveDate::from_ymd_opt(2026, 10, 25).unwrap(),
    ] {
        let mut d = fixture(2);
        trip(&mut d, &[(0, 1, 3 * 3600, 4 * 3600)]);
        let r = router(d);
        let j = r.route(0, 1, time(day, 3 * 3600 - 1)).unwrap().unwrap();
        assert_eq!(j.legs[0].departure, time(day, 3 * 3600).timestamp());
        assert_eq!(j.arrival - j.legs[0].departure, 3600);
    }
}
#[test]
fn zero_duration_departure_batch_reaches_fixed_point() {
    let mut d = fixture(4);
    d.default_transfer_seconds = 0;
    trip(&mut d, &[(2, 3, 100, 100)]);
    trip(&mut d, &[(1, 2, 100, 100)]);
    trip(&mut d, &[(0, 1, 100, 100)]);
    assert_eq!(
        run(&router(d), 0, 3, 0).arrival,
        time(date(), 100).timestamp()
    );
}
#[test]
fn lru_evicts_and_binary_search_skips_old_connections() {
    let mut d = fixture(2);
    trip(&mut d, &[(0, 1, 100, 200)]);
    let r = Router::new(Arc::new(d), 2, 3600).unwrap();
    for offset in [0, 1, 0, 2, 1] {
        r.route(0, 1, time(date() + Duration::days(offset), 0))
            .unwrap();
    }
    assert_eq!(r.metrics().daygraph_builds, 4);
    assert_eq!(r.metrics().daygraph_hits, 1);
    assert!(r.metrics().connections_scanned < 20);
}
// Independent time-expanded graph: connection arrival events are vertices;
// explicit waiting/boarding, ride-continuation and walking arcs are enumerated.
// Dijkstra includes walking and boarding resources in each event state.
fn reference(r: &Router, from: u32, to: u32, start: i64, opts: &RouteOptions) -> Option<i64> {
    let graph = r.day(date()).unwrap();
    let events = &graph.connections;
    let source = events.len();
    let mut heap = BinaryHeap::new();
    let mut dist = HashMap::new();
    heap.push(Reverse((start, source, 0u32, 0u32)));
    dist.insert((source, 0u32, 0u32), start);
    let end = start + i64::from(r.horizon_seconds);
    let mut best = None;
    while let Some(Reverse((at, event, walk, boards))) = heap.pop() {
        if dist.get(&(event, walk, boards)) != Some(&at) {
            continue;
        }
        let (stop, dropoff) = if event == source {
            (from, true)
        } else {
            (events[event].c.to, events[event].c.dropoff_allowed)
        };
        let mut accessible = Vec::new();
        if dropoff {
            accessible.push((stop, 0));
            for f in &r.data.footpaths[stop as usize] {
                if !r.generic_walk_banned(stop, f.to) {
                    accessible.push((f.to, u32::from(f.duration)));
                }
            }
        }
        for &(s, w) in &accessible {
            if s == to && walk + w <= opts.max_walk_seconds && at + i64::from(w) <= end {
                let arrival = at + i64::from(w);
                best = Some(best.map_or(arrival, |b: i64| b.min(arrival)));
            }
        }
        for (next, c) in events.iter().enumerate() {
            if c.departure < at || c.arrival > end {
                continue;
            }
            let product = r.data.routes[r.data.trips[c.c.trip as usize].route as usize].product;
            if opts
                .allowed_products
                .as_ref()
                .is_some_and(|p| !p.contains(&product))
            {
                continue;
            }
            let mut edges = Vec::new();
            if event != source
                && c.instance == events[event].instance
                && c.previous_sequence == Some(events[event].c.stop_sequence)
                && c.c.from == stop
            {
                edges.push((walk, boards));
            }
            if c.c.pickup_allowed && boards < u32::from(opts.max_transfers) + 1 {
                for &(s, w) in &accessible {
                    if s != c.c.from || walk + w > opts.max_walk_seconds {
                        continue;
                    }
                    let need = if event == source {
                        Some(w)
                    } else {
                        r.transfer_requirement(stop, s, events[event].c.trip, c.c.trip, w)
                    };
                    if need.is_some_and(|n| at + i64::from(n) <= c.departure) {
                        edges.push((walk + w, boards + 1));
                    }
                }
            }
            for (w, b) in edges {
                let key = (next, w, b);
                if dist.get(&key).is_none_or(|&old| c.arrival < old) {
                    dist.insert(key, c.arrival);
                    heap.push(Reverse((c.arrival, next, w, b)));
                }
            }
        }
    }
    best
}
#[test]
fn randomized_time_expanded_dijkstra_agrees() {
    let mut seed = 0x12345678u64;
    let mut rand = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        (seed >> 32) as u32
    };
    for case in 0..120 {
        let mut d = fixture(5);
        d.default_transfer_seconds = rand() % 90;
        d.calendar[0].start = date();
        d.calendar[0].end = date();
        for _ in 0..9 {
            let a = rand() % 5;
            let b = (a + 1 + rand() % 4) % 5;
            let c = (b + 1 + rand() % 4) % 5;
            let t = rand() % 700;
            let a1 = t + rand() % 100;
            let d1 = a1 + rand() % 50;
            let a2 = d1 + rand() % 100;
            trip(&mut d, &[(a, b, t, a1), (b, c, d1, a2)]);
            let n = d.connections.len();
            for edge in &mut d.connections[n - 2..] {
                edge.pickup_allowed = rand() % 5 != 0;
                edge.dropoff_allowed = rand() % 5 != 0;
            }
        }
        d.footpaths[1].push(Footpath {
            to: 2,
            duration: 30,
        });
        d.footpaths[2].push(Footpath {
            to: 1,
            duration: 30,
        });
        if case % 3 == 0 {
            let mut ban = rule(1, 2, 3, None);
            ban.from_trip = Some(rand() % 9);
            d.transfers.push(ban);
        }
        let r = router(d);
        let opts = RouteOptions {
            max_walk_seconds: if case % 2 == 0 { 30 } else { 120 },
            max_transfers: (case % 3) as u16,
            allowed_products: None,
        };
        for from in 0..5 {
            let to = (from + 2) % 5;
            let start = time(date(), i64::from(rand() % 300));
            let expected = reference(&r, from, to, start.timestamp(), &opts);
            let got = r
                .route_with_options(from, to, start, &opts)
                .unwrap()
                .map(|j| j.arrival);
            assert_eq!(got, expected, "random case {case} from {from} to {to}");
        }
    }
}

#[test]
fn overlapping_extended_service_instances_cannot_mix() {
    let mut d = fixture(3);
    trip(&mut d, &[(0, 1, 0, 10), (1, 2, 90_000, 90_010)]);
    d.connections[1].pickup_allowed = false;
    let j = run(&router(d), 0, 2, 0);
    assert_eq!(j.arrival, time(date(), 90_010).timestamp());
    assert_eq!(j.legs.len(), 1);
    assert_eq!(j.legs[0].service_date, Some(date()));
}
#[test]
fn resource_pareto_keeps_later_low_transfer_arrival() {
    let mut d = fixture(4);
    d.default_transfer_seconds = 0;
    trip(&mut d, &[(0, 1, 10, 20)]);
    trip(&mut d, &[(1, 2, 30, 40)]);
    trip(&mut d, &[(0, 2, 10, 50)]);
    trip(&mut d, &[(2, 3, 60, 70)]);
    let r = router(d);
    let opts = RouteOptions {
        max_transfers: 1,
        ..Default::default()
    };
    let j = r
        .route_with_options(0, 3, time(date(), 0), &opts)
        .unwrap()
        .unwrap();
    assert_eq!(j.legs.len(), 2);
    assert_eq!(j.legs[0].trip, Some(2));
}
#[test]
fn initial_and_final_walk_are_not_transfer_penalties() {
    let mut d = fixture(4);
    d.footpaths[0].push(Footpath {
        to: 1,
        duration: 30,
    });
    d.footpaths[2].push(Footpath {
        to: 3,
        duration: 40,
    });
    trip(&mut d, &[(1, 2, 30, 60)]);
    let j = run(&router(d), 0, 3, 0);
    assert_eq!(j.arrival, time(date(), 100).timestamp());
    assert_eq!(j.legs.len(), 3);
    assert_eq!(j.legs[1].transfer_seconds, 0);
}

#[test]
fn route_scoped_ban_and_equivalent_incoming_label_classes() {
    let mut d = fixture(3);
    d.routes.push(Route {
        gtfs_id: "other".into(),
        short_name: "other".into(),
        long_name: "other".into(),
        route_type: 3,
        product: 1,
    });
    trip(&mut d, &[(0, 1, 100, 200)]);
    let good = trip(&mut d, &[(0, 1, 110, 250)]);
    d.trips[good as usize].route = 1;
    trip(&mut d, &[(1, 2, 400, 500)]);
    let mut ban = rule(1, 1, 3, None);
    ban.from_route = Some(0);
    ban.to_route = Some(0);
    d.transfers.push(ban);
    let r = router(d);
    assert_ne!(r.incoming_classes[0], r.incoming_classes[1]);
    assert_eq!(run(&r, 0, 2, 0).legs[0].trip, Some(good));
}

/// Run explicitly for reproducible local smoke measurements, not a VGN SLA.
#[test]
#[ignore]
fn synthetic_warm_scan_measurement() {
    let mut d = fixture(525);
    for i in 0..2500u32 {
        let corridor = i % 25;
        let t = (i / 25) * 600;
        let edges = (0..20)
            .map(|s| {
                (
                    corridor * 21 + s,
                    corridor * 21 + s + 1,
                    t + s * 60,
                    t + s * 60 + 50,
                )
            })
            .collect::<Vec<_>>();
        trip(&mut d, &edges);
    }
    let r = router(d);
    let start = time(date(), 0);
    r.route(0, 524, start).unwrap();
    let before = r.metrics().connections_scanned;
    let timer = Instant::now();
    for _ in 0..20 {
        assert!(r.route(0, 524, start).unwrap().is_none());
    }
    eprintln!(
        "50,000 templates; warm unreachable mean {:.3} ms; mean scanned {}",
        timer.elapsed().as_secs_f64() * 1000. / 20.,
        (r.metrics().connections_scanned - before) / 20
    );
    assert_eq!(r.metrics().daygraph_builds, 1);
}
