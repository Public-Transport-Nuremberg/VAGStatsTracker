//! Component boundaries are persisted independently but activated as one version.
use crate::Bundle;
use anyhow::Result;
use history::StatsSnapshot;
use router_model::StaticData;
use std::collections::HashMap;

pub fn pack_gtfs(data: StaticData, source_sha: &str) -> Result<Bundle> {
    pack_gtfs_with_station_names(data, source_sha, HashMap::new())
}

/// Packs the GTFS snapshot with the canonical WebService names indexed by VGN
/// station ID. The part is optional so existing callers can keep using
/// `pack_gtfs`, and older bundles remain readable.
pub fn pack_gtfs_with_station_names(
    mut data: StaticData,
    source_sha: &str,
    station_names: HashMap<i32, String>,
) -> Result<Bundle> {
    data.validate().map_err(anyhow::Error::msg)?;
    let mut bundle = Bundle::new(
        "gtfs",
        serde_json::json!({
            "gtfs_sha256":source_sha,
            "valid_from":data.calendar.iter().map(|c|c.start).chain(data.exceptions.iter().filter(|e|e.added).map(|e|e.date)).min(),
            "valid_until":data.calendar.iter().map(|c|c.end).chain(data.exceptions.iter().filter(|e|e.added).map(|e|e.date)).max(),
            "stop_count":data.stops.len(), "trip_count":data.trips.len(),
            "connection_template_count":data.connections.len(),"transfer_count":data.transfers.len()
        }),
    )?;
    bundle.insert("stops", &std::mem::take(&mut data.stops))?;
    bundle.insert("routes", &std::mem::take(&mut data.routes))?;
    bundle.insert("trips", &std::mem::take(&mut data.trips))?;
    bundle.insert("stop_times", &std::mem::take(&mut data.connections))?;
    bundle.insert(
        "transfers",
        &(
            std::mem::take(&mut data.transfers),
            std::mem::take(&mut data.footpaths),
        ),
    )?;
    bundle.insert(
        "calendar",
        &(
            std::mem::take(&mut data.calendar),
            std::mem::take(&mut data.exceptions),
        ),
    )?;
    bundle.insert("data", &data)?;
    if !station_names.is_empty() {
        bundle.insert("station_names", &station_names)?;
    }
    Ok(bundle)
}

pub fn unpack_gtfs(bundle: &Bundle) -> Result<StaticData> {
    bundle.validate()?;
    anyhow::ensure!(bundle.manifest.kind == "gtfs", "expected GTFS snapshot");
    let mut data: StaticData = bundle.get("data")?;
    data.stops = bundle.get("stops")?;
    data.routes = bundle.get("routes")?;
    data.trips = bundle.get("trips")?;
    data.connections = bundle.get("stop_times")?;
    (data.transfers, data.footpaths) = bundle.get("transfers")?;
    (data.calendar, data.exceptions) = bundle.get("calendar")?;
    data.validate().map_err(anyhow::Error::msg)?;
    Ok(data)
}

pub fn unpack_gtfs_with_station_names(
    bundle: &Bundle,
) -> Result<(StaticData, HashMap<i32, String>)> {
    let data = unpack_gtfs(bundle)?;
    let station_names = if bundle.blobs.contains_key("station_names") {
        bundle.get("station_names")?
    } else {
        HashMap::new()
    };
    Ok((data, station_names))
}

pub fn pack_stats(mut stats: StatsSnapshot) -> Result<Bundle> {
    stats.validate()?;
    anyhow::ensure!(
        !stats.arrivals.is_empty()
            || !stats.departures.is_empty()
            || !stats.cancellations.is_empty(),
        "refusing empty statistics publication"
    );
    let mut bundle = Bundle::new(
        "stats",
        serde_json::json!({
            "history_from":stats.history_from,"history_until":stats.history_until,
            "delay_keys":stats.arrivals.len()+stats.departures.len(),
            "cancellation_keys":stats.cancellations.len(),"transfer_keys":stats.transfers.len()
        }),
    )?;
    bundle.manifest.generated_at = stats.generated_at.to_rfc3339();
    bundle.insert("cancellation", &std::mem::take(&mut stats.cancellations))?;
    bundle.insert("transfer", &std::mem::take(&mut stats.transfers))?;
    bundle.insert("delay", &stats)?;
    Ok(bundle)
}

pub fn unpack_stats(bundle: &Bundle) -> Result<StatsSnapshot> {
    bundle.validate()?;
    anyhow::ensure!(
        bundle.manifest.kind == "stats",
        "expected statistics snapshot"
    );
    let mut stats: StatsSnapshot = bundle.get("delay")?;
    stats.cancellations = bundle.get("cancellation")?;
    stats.transfers = bundle.get("transfer")?;
    anyhow::ensure!(
        !stats.arrivals.is_empty()
            || !stats.departures.is_empty()
            || !stats.cancellations.is_empty(),
        "empty statistics snapshot"
    );
    stats.validate()?;
    Ok(stats)
}
