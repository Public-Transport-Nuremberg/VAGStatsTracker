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

Set `PORT` and the Redis and ClickHouse credentials in `.env`. `PORT` overrides the port in `config/default.toml` for `router-api`; the bind address still comes from `listen` there. If the file is missing, the router uses compatible Redis values from `../WebService/.env`.

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

### Routing flags

In the `POST /v1/journeys` JSON response, flags appear at these paths:

| JSON path | Contents |
| --- | --- |
| `journeys[i].flags` | All flags for journey `i`, collected from its transit legs and transfers. |
| `journeys[i].legs[j].flags` | Flags for transit leg `j`; walking legs have no `flags` field. |
| `journeys[i].transfer_reliability[k].flags` | Flags for transfer `k`. Its `incoming_leg` and `outgoing_leg` fields identify the corresponding indices in `legs`. |

Each flag contains `type`, `severity`, `message_key`, and a `data` object with the values behind the warning. A journey can have multiple flags of the same type. For example, a tight transfer appears in both `journeys[i].transfer_reliability[k].flags` and the collected `journeys[i].flags`.

| `type` | Severity | `message_key` | When it appears | `data` fields |
| --- | --- | --- | --- | --- |
| `TIGHT_TRANSFER` | `warning` | `transfer.tight` | The scheduled transfer has no usable buffer beyond the required transfer or walking time. | `usable_buffer_seconds` |
| `UNRELIABLE_TRANSFER` | `warning` or `critical` | `transfer.low_probability` | The estimated transfer success probability is below `transfer_warning_probability` (default 0.85); it is `critical` below `transfer_critical_probability` (default 0.65). | `probability`, `samples`, `scheduled_transfer_seconds` |
| `FREQUENT_DELAY` | `warning` | `delay.frequent` | The probability of an arrival or departure delay of at least `delay_warning_seconds` (default 300) meets `delay_warning_probability` (default 0.50). | `probability`, `seconds`, `samples` |
| `HIGH_DELAY_RISK` | `warning` | `delay.high_risk` | The 90th-percentile arrival or departure delay reaches `delay_warning_seconds` (default 300). | `p90_seconds`, `samples` |
| `HIGH_CANCELLATION_RATE` | `warning` | `cancellation.high_rate` | The cancellation probability meets `cancellation_warning_probability` (default 0.03). | `probability`, `samples` |
| `NO_STATISTICS` | `info` | `statistics.unavailable` (leg), `transfer.probability_unavailable` (transfer) | A transit leg has no usable statistics, or a transfer success probability cannot be calculated. | Leg: `history_rejected`; transfer: `samples` |
| `LOW_STATISTICAL_SAMPLE` | `info` | `statistics.low_sample` | A leg has insufficient or low-quality statistics, or a transfer has 1–49 samples. | `samples` |

Thresholds are configured in `config/default.toml` under `[reliability]`.

Request option `allow_tight_transfers` defaults to `false`. When false, the router adds a ranking penalty for transfers and additional penalties for `TIGHT_TRANSFER` and `UNRELIABLE_TRANSFER` flags; when true, it removes those ranking penalties. It does not suppress flags or change the transfer feasibility rules.

## Operations

Example systemd services and timers are available in `deploy/`. Adjust their paths and user before installation.

The statistics builder streams aggregated ClickHouse data and writes resumable checkpoints to `data/`. Configure the chunk size with `HISTORY_CHUNK_DAYS`.

Useful checks:

```sh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
