# VGN CSA Router

Fast timetable routing for VGN with historical delay, cancellation, and transfer reliability data.

## Requirements

- Rust and Cargo
- Redis for snapshot distribution
- ClickHouse for building statistics

The routing API never queries ClickHouse directly.

## Configuration

```sh
cp .env.example .env
```

Set the Redis and ClickHouse credentials in `.env`. If this file is missing, the router uses compatible values from `../WebService/.env`.

Main settings are stored in:

- `config/default.toml`
- `config/product-map.toml`
- `config/stop-overrides.csv`

## Build and start

```sh
cargo build --release --workspace
cargo test --workspace

# Build and publish the GTFS snapshot.
cargo run --release -p router-builder -- gtfs

# Build and publish the current statistics snapshot.
cargo run --release -p router-builder -- stats

# Start the API on http://127.0.0.1:8088.
cargo run --release -p router-api
```

The default GTFS source is `https://www.vgn.de/opendata/GTFS.zip`.

Run the statistics builder once per day after the previous service day is complete. The provided systemd timer runs at 04:15 Europe/Berlin. The API automatically reloads published snapshots from Redis.

Statistics use the last 30 days where possible and fall back to 90 days for small samples. The most recent 7 days have a higher weight. Models are specific to weekday, time, line, direction, and stop, so one current snapshot can score future travel dates.

## Historical statistics

Create point-in-time snapshots for older travel dates:

```sh
cargo run --release -p router-builder -- stats-backfill --from 2026-09-01 --until 2026-09-19
```

The dates are inclusive. Historical routing only uses observations from before the requested travel date.

## Local snapshots

Build GTFS without Redis or ClickHouse station history:

```sh
cargo run --release -p router-builder -- gtfs \
  --source data/vgn.zip \
  --without-history \
  --output data/gtfs.snapshot
```

Set `local_gtfs = "data/gtfs.snapshot"` in a local config file. `local_stats` can be configured in the same way. Local snapshot files are loaded at startup and require an API restart after updates.

## HTTP API

| Endpoint | Description |
| --- | --- |
| `GET /health` | Loaded versions, date range, statistics age, and Redis state |
| `GET /ready` | Returns 200 when a valid GTFS snapshot is loaded |
| `GET /metrics` | Prometheus metrics |
| `GET /v1/stops/search` | Search stops by name |
| `GET /v1/stops/near` | Search stops by coordinates |
| `POST /v1/journeys` | Find and score connections |

Example request:

```json
{
  "from": { "station_id": 1664 },
  "to": { "station_id": 1701 },
  "departure": "2026-09-22T05:00:00+02:00",
  "profile": "fastest",
  "options": {
    "max_walk_seconds": 900,
    "max_transfers": 3,
    "max_results": 5,
    "allow_tight_transfers": false,
    "products": ["bus", "tram", "ubahn", "sbahn", "rbahn"]
  }
}
```

`station_id` accepts the VGN station IDs returned by the WebService stop endpoint. `station_name` is also supported when it identifies one station group. The router searches all matching platforms and applies the product filter before routing.

Departure times must include a UTC offset. A date outside the loaded GTFS range returns HTTP 422 with `DATE_OUTSIDE_GTFS_RANGE`. No matching connection returns HTTP 200 with an empty `journeys` array.

## Operations

Example systemd services and timers are available in `deploy/`. Adjust their paths and user before installation.

The statistics builder streams aggregated ClickHouse data and writes resumable checkpoints to `data/`. Configure the chunk size with `HISTORY_CHUNK_DAYS`.

Useful checks:

```sh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
