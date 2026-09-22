use anyhow::{bail, Context, Result};
use chrono::NaiveDate;
use futures_util::StreamExt;
use snapshot::{
    packaging::{pack_gtfs_with_station_names, pack_stats},
    Bundle, Config, Store,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

fn load_environment() {
    // A router-local .env is authoritative. Reuse connection defaults from the
    // sibling WebService without inheriting its vag_stats_dev database selection.
    load_env_file(".env", |_| true);
    clear_example_placeholders(&["REDIS_USER", "REDIS_PASSWORD", "CH_USER", "CH_PASSWORD"]);
    for path in ["../WebService/.env", "WebService/.env"] {
        if !std::path::Path::new(path).exists() {
            continue;
        }
        load_env_file(path, |key| {
            key.starts_with("REDIS_")
                || matches!(key, "CH_HOST" | "CH_PORT" | "CH_USER" | "CH_PASSWORD")
        });
        break;
    }
}

fn clear_example_placeholders(keys: &[&str]) {
    for key in keys {
        if matches!(
            std::env::var(key).as_deref(),
            Ok("username" | "password" | "change-me")
        ) {
            std::env::remove_var(key);
        }
    }
}

fn load_env_file(path: &str, include: impl Fn(&str) -> bool) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !include(key) || std::env::var_os(key).is_some() {
            continue;
        }
        let raw = raw.trim();
        let value = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            &raw[1..raw.len() - 1]
        } else {
            raw
        };
        // Values are intentionally literal: credentials containing '$' must not be expanded.
        std::env::set_var(key, value);
    }
}

struct Args {
    command: String,
    config: PathBuf,
    output: Option<PathBuf>,
    source: Option<String>,
    without_history: bool,
    force: bool,
    from: Option<NaiveDate>,
    until: Option<NaiveDate>,
}
impl Args {
    fn parse() -> Result<Self> {
        let mut args = std::env::args().skip(1);
        let command = args.next().unwrap_or_else(|| "help".into());
        let mut value = Self {
            command,
            config: "config/default.toml".into(),
            output: None,
            source: None,
            without_history: false,
            force: false,
            from: None,
            until: None,
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--config" => value.config = args.next().context("--config needs a path")?.into(),
                "--output" => {
                    value.output = Some(
                        args.next()
                            .context("--output needs a new file path")?
                            .into(),
                    )
                }
                "--source" => {
                    value.source = Some(args.next().context("--source needs a URL or ZIP path")?)
                }
                "--without-history" => value.without_history = true,
                "--force" => value.force = true,
                "--from" => {
                    value.from = Some(NaiveDate::parse_from_str(
                        &args.next().context("--from needs YYYY-MM-DD")?,
                        "%Y-%m-%d",
                    )?)
                }
                "--until" => {
                    value.until = Some(NaiveDate::parse_from_str(
                        &args.next().context("--until needs YYYY-MM-DD")?,
                        "%Y-%m-%d",
                    )?)
                }
                _ => bail!("unknown argument: {arg}"),
            }
        }
        Ok(value)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    load_environment();
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();
    let args = Args::parse()?;
    if matches!(args.command.as_str(), "help" | "--help" | "-h") {
        println!("router-builder gtfs|stats|stats-backfill [--config config/default.toml] [--output NEW_FILE]\n  gtfs: [--source URL_OR_ZIP] [--without-history] [--force]\n  stats: [--until ROUTE_DATE] (dated builds are archived without changing the active snapshot)\n  stats-backfill: --from ROUTE_DATE --until ROUTE_DATE\nWithout --output, publish a checked immutable snapshot to Redis.");
        return Ok(());
    }
    let config = Config::load(&args.config)?;
    let result = match args.command.as_str() {
        "gtfs" => build_gtfs(&args, &config).await,
        "stats" => build_stats(&args, &config).await,
        "stats-backfill" => build_stats_backfill(&args, &config).await,
        _ => bail!("expected gtfs, stats or stats-backfill command"),
    };
    if args.command.starts_with("stats") {
        if let Err(error) = write_metrics(result.is_err()) {
            tracing::warn!(%error,"could not write builder metrics");
        }
    }
    result
}

fn history_config(path: &Path) -> Result<history::HistoryConfig> {
    let document: toml::Value = toml::from_str(&std::fs::read_to_string(path)?)?;
    Ok(document
        .get("history")
        .context("missing [history] config")?
        .clone()
        .try_into()?)
}

async fn download(source: &str) -> Result<Vec<u8>> {
    const LIMIT: usize = 1024 * 1024 * 1024;
    if source.starts_with("https://") || source.starts_with("http://") {
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?
            .get(source)
            .send()
            .await?
            .error_for_status()?;
        anyhow::ensure!(
            response.content_length().unwrap_or(0) <= LIMIT as u64,
            "GTFS archive exceeds 1 GiB"
        );
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            anyhow::ensure!(
                bytes.len() + chunk.len() <= LIMIT,
                "GTFS archive exceeds 1 GiB"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    } else {
        anyhow::ensure!(
            std::fs::metadata(source)?.len() <= LIMIT as u64,
            "GTFS archive exceeds 1 GiB"
        );
        Ok(tokio::fs::read(source).await?)
    }
}

async fn build_gtfs(args: &Args, config: &Config) -> Result<()> {
    let bytes = download(args.source.as_deref().unwrap_or(&config.gtfs_path)).await?;
    let sha = snapshot::sha256(&bytes);
    let store = Store::new(&config.redis_url)?;
    let previous = if args.output.is_none() {
        if let Some(id) = store.active_id("gtfs").await? {
            store.manifest("gtfs", &id).await?
        } else {
            None
        }
    } else {
        None
    };
    if !args.force
        && previous
            .as_ref()
            .is_some_and(|m| m.metadata.get("gtfs_sha256").and_then(|v| v.as_str()) == Some(&sha))
    {
        tracing::info!(gtfs_sha256=%sha,"GTFS unchanged; keeping active snapshot");
        return Ok(());
    }
    let mut options = gtfs::ImportOptions {
        default_transfer_seconds: config.default_transfer_seconds,
        ..Default::default()
    };
    let product_text = std::fs::read_to_string(&config.product_map).context("read product map")?;
    let products = gtfs::ProductMapConfig::from_toml(&product_text)?;
    products.apply(&mut options)?;
    options.stop_overrides =
        gtfs::load_stop_overrides(&std::fs::read_to_string(&config.stop_overrides)?)?;
    let station_names = if !args.without_history {
        let stops = history::fetch_stops(&history_config(&args.config)?).await?;
        let names = stops
            .iter()
            .map(|stop| (stop.vgn_id, stop.name.clone()))
            .collect::<HashMap<_, _>>();
        options.historical_stops = stops
            .into_iter()
            .map(|s| gtfs::HistoricalStop {
                id: s.vgn_id,
                name: s.name,
                latitude: s.latitude,
                longitude: s.longitude,
            })
            .collect();
        names
    } else {
        HashMap::new()
    };
    let data = tokio::task::spawn_blocking(move || gtfs::import_zip(&bytes, &options)).await??;
    let mapped = data
        .stops
        .iter()
        .filter(|s| s.historical_vgn_id.is_some())
        .count();
    tracing::info!(
        gtfs_stops = data.stops.len(),
        mapped_historical = mapped,
        unmapped = data.stops.len() - mapped,
        trips = data.trips.len(),
        connections = data.connections.len(),
        "GTFS validated"
    );
    let bundle = pack_gtfs_with_station_names(data, &sha, station_names)?;
    if let Some(previous) = previous {
        for name in [
            "stop_count",
            "trip_count",
            "connection_template_count",
            "transfer_count",
        ] {
            let before = previous.metadata[name].as_u64().unwrap_or(0);
            let after = bundle.manifest.metadata[name].as_u64().unwrap_or(0);
            if before > 0 && (after < before / 2 || after > before.saturating_mul(2)) {
                tracing::warn!(field = name, before, after, "large GTFS count change");
            }
        }
    }
    publish(bundle, args.output.as_deref(), &store).await
}

async fn build_stats(args: &Args, config: &Config) -> Result<()> {
    let mut history_config = history_config(&args.config)?;
    history_config.apply_env()?;
    history_config.set_product_map_toml(&std::fs::read_to_string(&config.product_map)?)?;
    let stats_until = match args.until {
        Some(until) => until,
        None => {
            let timezone: chrono_tz::Tz = history_config
                .timezone
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid history timezone"))?;
            chrono::Utc::now().with_timezone(&timezone).date_naive()
        }
    };
    let checkpoint = stats_checkpoint_path(stats_until);
    let chunk_days = stats_chunk_days()?;
    let stats =
        history::build_until_resumable(history_config, stats_until, &checkpoint, chunk_days)
            .await?;
    let bundle = pack_stats(stats)?;
    let store = Store::new(&config.redis_url)?;
    if let Some(path) = args.output.as_deref() {
        publish(bundle, Some(path), &store).await?;
        history::remove_checkpoint(&checkpoint)?;
        return Ok(());
    }
    if args.until.is_some() {
        store.archive(&bundle).await?;
        tracing::info!(snapshot=%bundle.manifest.snapshot_id,history_until=%bundle.manifest.metadata["history_until"],"historical statistics snapshot archived");
        history::remove_checkpoint(&checkpoint)?;
        Ok(())
    } else {
        publish(bundle, None, &store).await?;
        history::remove_checkpoint(&checkpoint)?;
        Ok(())
    }
}

async fn build_stats_backfill(args: &Args, config: &Config) -> Result<()> {
    anyhow::ensure!(
        args.output.is_none(),
        "stats-backfill does not support --output"
    );
    let from = args.from.context("stats-backfill requires --from")?;
    let until = args.until.context("stats-backfill requires --until")?;
    anyhow::ensure!(from <= until, "--from must not be after --until");
    let mut history_config = history_config(&args.config)?;
    history_config.apply_env()?;
    history_config.set_product_map_toml(&std::fs::read_to_string(&config.product_map)?)?;
    let store = Store::new(&config.redis_url)?;
    let mut route_date = from;
    loop {
        let checkpoint = stats_checkpoint_path(route_date);
        let stats = history::build_until_resumable(
            history_config.clone(),
            route_date,
            &checkpoint,
            stats_chunk_days()?,
        )
        .await?;
        let bundle = pack_stats(stats)?;
        store.archive(&bundle).await?;
        history::remove_checkpoint(&checkpoint)?;
        tracing::info!(snapshot=%bundle.manifest.snapshot_id,route_date=%route_date,"historical statistics snapshot archived");
        if route_date == until {
            break;
        }
        route_date = route_date.succ_opt().context("backfill date overflow")?;
    }
    Ok(())
}

fn stats_chunk_days() -> Result<u32> {
    let days = std::env::var("HISTORY_CHUNK_DAYS")
        .unwrap_or_else(|_| "30".into())
        .parse::<u32>()
        .context("HISTORY_CHUNK_DAYS must be a positive integer")?;
    anyhow::ensure!(
        (1..=366).contains(&days),
        "HISTORY_CHUNK_DAYS must be between 1 and 366"
    );
    Ok(days)
}

fn stats_checkpoint_path(until: NaiveDate) -> PathBuf {
    std::env::var("HISTORY_CHECKPOINT_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(format!("data/stats-builder-{until}.checkpoint.zst")))
}

async fn publish(bundle: Bundle, output: Option<&Path>, store: &Store) -> Result<()> {
    if let Some(path) = output {
        bundle.write_file(path)?;
        tracing::info!(path=%path.display(),"snapshot file written");
    } else {
        store.publish(&bundle).await?;
        tracing::info!(snapshot=%bundle.manifest.snapshot_id,kind=%bundle.manifest.kind,"snapshot activated");
    }
    Ok(())
}

fn write_metrics(failed: bool) -> Result<()> {
    let path = PathBuf::from(
        std::env::var("BUILDER_METRICS_FILE").unwrap_or_else(|_| "data/router-builder.prom".into()),
    );
    let previous = std::fs::read_to_string(&path).unwrap_or_default();
    let values: HashMap<_, _> = previous
        .lines()
        .filter_map(|line| line.split_once(' '))
        .collect();
    let count = values
        .get("router_clickhouse_build_failures_total")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        + u64::from(failed);
    let last = if failed {
        values
            .get("router_clickhouse_last_success_timestamp")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
    } else {
        chrono::Utc::now().timestamp()
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary,format!("# TYPE router_clickhouse_build_failures_total counter\nrouter_clickhouse_build_failures_total {count}\n# TYPE router_clickhouse_last_success_timestamp gauge\nrouter_clickhouse_last_success_timestamp {last}\n"))?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
