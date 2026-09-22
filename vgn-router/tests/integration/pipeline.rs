use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{DateTime, NaiveDate};
use history::{CancellationKey, CancellationStats, DataQuality, StatKey, StatsSnapshot};
use http_body_util::BodyExt;
use router_api::{AppState, Loaded};
use serde_json::{json, Value};
use snapshot::{
    packaging::{pack_gtfs, pack_gtfs_with_station_names, pack_stats},
    Bundle, Config, Store,
};
use std::{
    collections::HashMap,
    io::{Cursor, Write},
    sync::Arc,
};
use tower::ServiceExt;

fn fixture() -> router_model::StaticData {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/tiny");
    for name in [
        "agency.txt",
        "stops.txt",
        "routes.txt",
        "trips.txt",
        "stop_times.txt",
        "calendar.txt",
        "transfers.txt",
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&std::fs::read(directory.join(name)).unwrap())
            .unwrap();
    }
    let options = gtfs::ImportOptions {
        product_map: HashMap::from([(3, 1), (1, 2)]),
        stop_overrides: HashMap::from([
            ("A".into(), 101),
            ("B".into(), 102),
            ("C".into(), 103),
            ("D".into(), 104),
        ]),
        ..Default::default()
    };
    gtfs::import_zip(&zip.finish().unwrap().into_inner(), &options).unwrap()
}
fn stats() -> StatsSnapshot {
    let keys = [
        (1, "36", 101, 50),
        (1, "36", 102, 50),
        (2, "U1", 103, 51),
        (2, "U1", 104, 52),
    ];
    let mut rows = Vec::new();
    for (product, line, stop, bucket) in keys {
        for i in 0..200 {
            rows.push((
                StatKey {
                    product,
                    line: line.into(),
                    stop,
                    direction: "Ziel".into(),
                    weekday: 5,
                    bucket,
                    level: 0,
                },
                Some(if stop == 102 && i < 100 { 300 } else { 0 }),
                Some(0),
                false,
            ));
        }
    }
    let mut s = history::snapshot_from_rows(rows, 20);
    s.generated_at = "2026-09-18T00:15:00Z".parse().unwrap();
    s.history_from = NaiveDate::from_ymd_opt(2024, 9, 18).unwrap();
    s.history_until = NaiveDate::from_ymd_opt(2026, 9, 17).unwrap();
    for (product, line, n) in [(1, "36", 20), (2, "u1", 40)] {
        s.cancellations.insert(
            CancellationKey {
                product,
                line: line.into(),
                direction: String::new(),
                weekday: 0,
                bucket: 0,
                level: 4,
            },
            CancellationStats {
                samples: 200,
                cancellations: n,
                probability: n as f32 / 200.0,
                data_quality: DataQuality::High,
            },
        );
    }
    s.validate().unwrap();
    s
}
fn state(with_stats: bool) -> Arc<AppState> {
    let config = Config::default();
    let state = AppState::new(
        config.clone(),
        HashMap::from([("bus".into(), 1), ("ubahn".into(), 2)]),
    )
    .unwrap();
    let gtfs = pack_gtfs(fixture(), "fixture").unwrap();
    let stats = with_stats.then(|| pack_stats(stats()).unwrap());
    state.install(Loaded::new(gtfs, stats, &config).unwrap());
    state
}
async fn query(state: Arc<AppState>, method: &str, url: &str, body: Value) -> (StatusCode, Value) {
    let response = router_api::app(state)
        .oneshot(
            Request::builder()
                .method(method)
                .uri(url)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn request() -> Value {
    json!({"from":{"stop_id":"A"},"to":{"stop_id":"D"},"departure":"2026-09-18T12:20:00+02:00"})
}

#[tokio::test]
async fn gtfs_binary_snapshot_api_and_scoring_pipeline() {
    let state = state(true);
    let mut fastest_request = request();
    fastest_request["options"] = json!({"allow_tight_transfers":true});
    let (status, response) = query(state, "POST", "/v1/journeys", fastest_request).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["journeys"].as_array().unwrap().len(), 2);
    assert_eq!(
        response["journeys"][1]["scheduled_arrival"],
        "2026-09-18T13:15:00+02:00"
    );
    assert_eq!(
        response["snapshot"]["statistics_history_until"],
        "2026-09-17"
    );
    let j = &response["journeys"][0];
    assert_eq!(j["scheduled_arrival"], "2026-09-18T13:00:00+02:00");
    assert_eq!(j["legs"].as_array().unwrap().len(), 3);
    assert_eq!(j["transfers"], 1);
    assert_eq!(j["transfer_reliability"][0]["success_probability"], 0.5);
    assert!(
        (j["reliability"]["estimated_journey_success_probability"]
            .as_f64()
            .unwrap()
            - 0.36)
            .abs()
            < 0.0001
    );
    assert_eq!(j["reliability"]["model"], "independent_events");
}

#[tokio::test]
async fn safe_default_keeps_a_materially_faster_route_available() {
    let state = state(true);
    let (status, response) = query(state, "POST", "/v1/journeys", request()).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        response["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:00:00+02:00"
    );
    assert_eq!(response["journeys"][0]["transfers"], 1);
    assert_eq!(response["metadata"]["allow_tight_transfers"], false);
}

#[tokio::test]
async fn constraints_and_missing_statistics_do_not_change_fastest_objective() {
    let state = state(false);
    let (_, response) = query(state.clone(), "POST", "/v1/journeys", request()).await;
    assert_eq!(
        response["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:00:00+02:00"
    );
    assert!(response["journeys"][0]["reliability"]["minimum_transfer_probability"].is_null());
    let mut r = request();
    r["options"] = json!({"max_transfers":0});
    let (_, response) = query(state.clone(), "POST", "/v1/journeys", r).await;
    assert_eq!(
        response["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:15:00+02:00"
    );
    let mut r = request();
    r["options"] = json!({"products":["ubahn"]});
    let (_, response) = query(state, "POST", "/v1/journeys", r).await;
    assert_eq!(response["journeys"], json!([]));
}

#[tokio::test]
async fn station_id_routes_from_all_mapped_platforms_and_filters_products() {
    let mut data = fixture();
    // A and C are distinct platforms belonging to one WebService station.
    data.stops[2].historical_vgn_id = Some(101);
    let config = Config::default();
    let state = AppState::new(
        config.clone(),
        HashMap::from([("bus".into(), 1), ("ubahn".into(), 2)]),
    )
    .unwrap();
    state.install(
        Loaded::new(pack_gtfs(data, "station-platforms").unwrap(), None, &config).unwrap(),
    );

    // The station has a bus platform at A and a rail/U-Bahn platform at C.
    // The latter gives the earliest arrival when all products are allowed.
    let r = json!({"from":{"VGNKennung":101},"to":{"station_id":104},"departure":"2026-09-18T12:20:00+02:00"});
    let (status, result) = query(state.clone(), "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:00:00+02:00"
    );
    assert_eq!(result["journeys"][0]["legs"][0]["from"]["stop_id"], "C");

    let r = json!({"from":{"station_id":101},"to":{"station_id":"104"},"departure":"2026-09-18T12:20:00+02:00","options":{"products":["bus"]}});
    let (status, result) = query(state.clone(), "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:15:00+02:00"
    );

    // A WebService station name resolves to the same complete platform group.
    let r = json!({"from":{"Haltestellenname":"Nurnberg Hbf"},"to":{"VGNKennung":104},"departure":"2026-09-18T12:20:00+02:00"});
    let (status, result) = query(state, "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:00:00+02:00"
    );
    assert_eq!(result["journeys"][0]["legs"][0]["from"]["stop_id"], "C");
}

#[tokio::test]
async fn station_name_resolution_reports_ambiguous_and_unknown_names() {
    let mut data = fixture();
    data.stops[3].name = "Nürnberg Hauptbahnhof".into();
    let config = Config::default();
    let state = AppState::new(config.clone(), HashMap::new()).unwrap();
    state.install(
        Loaded::new(
            pack_gtfs(data, "station-name-resolution").unwrap(),
            None,
            &config,
        )
        .unwrap(),
    );
    let r = json!({"from":{"Haltestellenname":"Nurnberg Hbf"},"to":{"stop_id":"D"},"departure":"2026-09-18T12:20:00+02:00"});
    let (status, result) = query(state.clone(), "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(result["error"], "AMBIGUOUS_STATION_NAME");

    let r = json!({"from":{"station_name":"not a station"},"to":{"stop_id":"D"},"departure":"2026-09-18T12:20:00+02:00"});
    let (status, result) = query(state, "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(result["error"], "UNKNOWN_FROM_STATION");
}

#[tokio::test]
async fn canonical_historical_station_name_resolves_without_gtfs_name_match() {
    let mut data = fixture();
    data.stops[0].name = "Platform Alpha".into();
    data.stops[2].historical_vgn_id = Some(101);
    let config = Config::default();
    let state = AppState::new(
        config.clone(),
        HashMap::from([("bus".into(), 1), ("ubahn".into(), 2)]),
    )
    .unwrap();
    let names = HashMap::from([(101, "WebService Nürnberg Hauptbahnhof".to_string())]);
    let gtfs = pack_gtfs_with_station_names(data, "canonical-name", names).unwrap();
    state.install(Loaded::new(gtfs, None, &config).unwrap());

    let request = json!({
        "from":{"Haltestellenname":"WebService Nurnberg Hauptbahnhof"},
        "to":{"VGNKennung":104},
        "departure":"2026-09-18T12:20:00+02:00"
    });
    let (status, result) = query(state, "POST", "/v1/journeys", request).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["journeys"][0]["scheduled_arrival"],
        "2026-09-18T13:00:00+02:00"
    );
    assert_eq!(result["journeys"][0]["legs"][0]["from"]["stop_id"], "C");
}

#[tokio::test]
async fn leakage_invalid_dates_and_search() {
    let state = state(true);
    let mut r = request();
    r["departure"] = json!("2026-09-17T12:20:00+02:00");
    let (_, response) = query(state.clone(), "POST", "/v1/journeys", r).await;
    assert_eq!(
        response["journeys"][0]["legs"][0]["reliability"]["history_rejected"],
        true
    );
    assert!(
        response["journeys"][0]["reliability"]["estimated_journey_success_probability"].is_null()
    );
    let mut r = request();
    r["departure"] = json!("2030-01-01T12:20:00+01:00");
    let (status, response) = query(state.clone(), "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response["error"], "DATE_OUTSIDE_GTFS_RANGE");
    let (_, response) = query(
        state.clone(),
        "GET",
        "/v1/stops/search?q=nurnberg%20hbf",
        Value::Null,
    )
    .await;
    assert_eq!(response["stops"][0]["stop_id"], "A");
    let (_, response) = query(
        state,
        "GET",
        "/v1/stops/near?latitude=49.445&longitude=11.083&radius_meters=100",
        Value::Null,
    )
    .await;
    assert_eq!(response["stops"][0]["stop"]["stop_id"], "A");
}

#[tokio::test]
#[ignore = "requires TEST_REDIS_URL pointing at an isolated Redis instance"]
async fn past_route_uses_latest_statistics_snapshot_before_that_day() {
    let config = Config {
        redis_url: std::env::var("TEST_REDIS_URL").unwrap(),
        ..Default::default()
    };
    let store = Store::new(&config.redis_url).unwrap();

    let active = pack_stats(stats()).unwrap();
    store.publish(&active).await.unwrap();
    let mut historical = stats();
    historical.generated_at = "2026-09-17T04:15:00Z".parse().unwrap();
    historical.history_until = NaiveDate::from_ymd_opt(2026, 9, 16).unwrap();
    let historical = pack_stats(historical).unwrap();
    store.archive(&historical).await.unwrap();

    let state = AppState::new(
        config.clone(),
        HashMap::from([("bus".into(), 1), ("ubahn".into(), 2)]),
    )
    .unwrap();
    state.set_history_store(store).unwrap();
    state.install(
        Loaded::new(
            pack_gtfs(fixture(), "historical-selection").unwrap(),
            Some(active),
            &config,
        )
        .unwrap(),
    );

    let mut request = request();
    request["departure"] = json!("2026-09-17T12:20:00+02:00");
    let (status, response) = query(state, "POST", "/v1/journeys", request).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        response["snapshot"]["statistics"],
        historical.manifest.snapshot_id
    );
    assert_eq!(
        response["snapshot"]["statistics_history_until"],
        "2026-09-16"
    );
    assert_eq!(
        response["journeys"][0]["legs"][0]["reliability"]["history_rejected"],
        false
    );
}

#[tokio::test]
async fn atomic_reload_keeps_old_arc_and_failed_redis_keeps_routing() {
    let state = state(false);
    let old = state.active.load_full().unwrap();
    let old_version = old.gtfs_manifest.snapshot_id.clone();
    let next = Loaded::new(
        pack_gtfs(fixture(), "second").unwrap(),
        Some(pack_stats(stats()).unwrap()),
        &state.config,
    )
    .unwrap();
    state.install(next);
    assert_ne!(
        state.active.load_full().unwrap().gtfs_manifest.snapshot_id,
        old_version
    );
    assert_eq!(old.gtfs_manifest.snapshot_id, old_version);
    assert!(old.stats.is_none());
    assert!(state.active.load_full().unwrap().stats.is_some());
    let dt = DateTime::parse_from_rfc3339("2026-09-18T12:20:00+02:00").unwrap();
    assert!(old.router.route(0, 3, dt).unwrap().is_some());
    let store = snapshot::Store::new("redis://127.0.0.1:1/").unwrap();
    assert!(router_api::reload(&state, &store).await.is_err());
    let (status, response) = query(state.clone(), "POST", "/v1/journeys", request()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["journeys"].as_array().unwrap().len(), 2);
    let (_, health) = query(state, "GET", "/health", Value::Null).await;
    assert_eq!(health["status"], "degraded");
}

#[test]
fn portable_snapshot_roundtrip_and_corruption() {
    let bundle = pack_gtfs(fixture(), "portable").unwrap();
    let path = std::env::temp_dir().join(format!(
        "vgn-router-{}.snapshot",
        bundle.manifest.snapshot_id
    ));
    bundle.write_file(&path).unwrap();
    let loaded = Bundle::read_file(&path).unwrap();
    assert_eq!(loaded.manifest.sha256, bundle.manifest.sha256);
    let mut bytes = std::fs::read(&path).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(Bundle::read_file(&path).is_err());
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn api_accepts_final_service_day_spillover() {
    let mut data = fixture();
    let last = NaiveDate::from_ymd_opt(2026, 9, 18).unwrap();
    data.calendar[0].start = last;
    data.calendar[0].end = last;
    for c in &mut data.connections {
        c.departure += 12 * 3600;
        c.arrival += 12 * 3600;
    }
    let config = Config::default();
    let state = AppState::new(config.clone(), HashMap::new()).unwrap();
    state.install(Loaded::new(pack_gtfs(data, "spillover").unwrap(), None, &config).unwrap());
    let mut r = request();
    r["departure"] = json!("2026-09-19T00:20:00+02:00");
    let (status, result) = query(state, "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["journeys"][0]["scheduled_arrival"],
        "2026-09-19T01:00:00+02:00"
    );
}

#[tokio::test]
async fn cancellation_uses_trip_origin_bucket_when_boarding_later() {
    let mut data = fixture();
    data.connections.push(router_model::Connection {
        from: 1,
        to: 3,
        departure: 12 * 3600 + 50 * 60,
        arrival: 13 * 3600 + 2 * 60,
        trip: 0,
        stop_sequence: 2,
        pickup_allowed: true,
        dropoff_allowed: true,
    });
    let mut statistics = stats();
    statistics.cancellations.clear();
    statistics.cancellations.insert(
        CancellationKey {
            product: 1,
            line: "36".into(),
            direction: "ziel".into(),
            weekday: 5,
            bucket: 50,
            level: 0,
        },
        CancellationStats {
            samples: 200,
            cancellations: 20,
            probability: 0.1,
            data_quality: DataQuality::High,
        },
    );
    let config = Config::default();
    let state = AppState::new(config.clone(), HashMap::from([("bus".into(), 1)])).unwrap();
    state.install(
        Loaded::new(
            pack_gtfs(data, "origin-bucket").unwrap(),
            Some(pack_stats(statistics).unwrap()),
            &config,
        )
        .unwrap(),
    );
    let r = json!({"from":{"stop_id":"B"},"to":{"stop_id":"D"},"departure":"2026-09-18T12:41:00+02:00","options":{"products":["bus"]}});
    let (status, result) = query(state, "POST", "/v1/journeys", r).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let p = result["journeys"][0]["legs"][0]["reliability"]["cancellation_probability"]
        .as_f64()
        .unwrap();
    assert!((p - 0.1).abs() < 0.000001);
}

type RedisValues = Arc<tokio::sync::Mutex<HashMap<String, Vec<u8>>>>;
async fn fake_redis(values: RedisValues) -> (snapshot::Store, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let values = values.clone();
            tokio::spawn(async move {
                let mut stream = BufReader::new(stream);
                loop {
                    let mut header = String::new();
                    if stream.read_line(&mut header).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let Some(count) = header
                        .strip_prefix('*')
                        .and_then(|s| s.trim().parse::<usize>().ok())
                    else {
                        break;
                    };
                    let mut args = Vec::new();
                    for _ in 0..count {
                        let mut length = String::new();
                        stream.read_line(&mut length).await.unwrap();
                        let len = length
                            .trim()
                            .strip_prefix('$')
                            .unwrap()
                            .parse::<usize>()
                            .unwrap();
                        let mut bytes = vec![0; len + 2];
                        stream.read_exact(&mut bytes).await.unwrap();
                        bytes.truncate(len);
                        args.push(bytes);
                    }
                    if args[0] == b"GET" {
                        let key = String::from_utf8(args[1].clone()).unwrap();
                        let value = values.lock().await.get(&key).cloned();
                        match value {
                            Some(value) => {
                                stream
                                    .write_all(format!("${}\r\n", value.len()).as_bytes())
                                    .await
                                    .unwrap();
                                stream.write_all(&value).await.unwrap();
                                stream.write_all(b"\r\n").await.unwrap();
                            }
                            None => stream.write_all(b"$-1\r\n").await.unwrap(),
                        }
                    } else {
                        stream.write_all(b"+OK\r\n").await.unwrap();
                    }
                    stream.flush().await.unwrap();
                }
            });
        }
    });
    (
        snapshot::Store::new(&format!("redis://{address}/")).unwrap(),
        task,
    )
}
async fn add_bundle(values: &RedisValues, bundle: &Bundle) {
    let m = &bundle.manifest;
    let base = format!("{}:{}:{}", snapshot::PREFIX, m.kind, m.snapshot_id);
    let mut values = values.lock().await;
    values.insert(
        format!("{}:{}:active", snapshot::PREFIX, m.kind),
        m.snapshot_id.as_bytes().to_vec(),
    );
    values.insert(format!("{base}:manifest"), serde_json::to_vec(m).unwrap());
    for part in &m.parts {
        for (i, chunk) in bundle.blobs[&part.name]
            .chunks(snapshot::CHUNK_BYTES)
            .enumerate()
        {
            values.insert(format!("{base}:{}:{i}", part.name), chunk.to_vec());
        }
    }
}

#[tokio::test]
async fn missing_chunk_cold_start_and_pointer_loss_keep_valid_routing() {
    let values = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let gtfs = pack_gtfs(fixture(), "redis-fixture").unwrap();
    let stats = pack_stats(stats()).unwrap();
    add_bundle(&values, &gtfs).await;
    add_bundle(&values, &stats).await;
    let missing = format!(
        "{}:stats:{}:delay:0",
        snapshot::PREFIX,
        stats.manifest.snapshot_id
    );
    let good = values.lock().await.remove(&missing).unwrap();
    let (store, task) = fake_redis(values.clone()).await;
    let config = Config::default();
    let state = AppState::new(config, HashMap::new()).unwrap();
    assert!(router_api::reload(&state, &store).await.is_err());
    assert!(state.active.load_full().unwrap().stats.is_none());
    let (status, result) = query(state.clone(), "POST", "/v1/journeys", request()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["journeys"].as_array().unwrap().len(), 2);
    values.lock().await.insert(missing, good);
    router_api::reload(&state, &store).await.unwrap();
    let active = state.active.load_full().unwrap();
    assert!(active.stats.is_some());
    values
        .lock()
        .await
        .remove(&format!("{}:stats:active", snapshot::PREFIX));
    assert!(router_api::reload(&state, &store).await.is_err());
    assert!(state.active.load_full().unwrap().stats.is_some());
    assert!(Arc::ptr_eq(
        &active.router,
        &state.active.load_full().unwrap().router
    ));
    task.abort();
}
