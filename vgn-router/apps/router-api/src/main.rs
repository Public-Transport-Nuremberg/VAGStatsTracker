use anyhow::{Context, Result};
use router_api::{AppState, Loaded};
use snapshot::{Bundle, Config, Store};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

fn load_environment() {
    // A router-local .env is authoritative. The existing WebService file is only  a fallback for its split Redis variables.
    load_env_file(".env", |_| true);
    clear_example_placeholders(&["REDIS_USER", "REDIS_PASSWORD"]);
    for path in ["../WebService/.env", "WebService/.env"] {
        if !std::path::Path::new(path).exists() {
            continue;
        }
        load_env_file(path, |key| key.starts_with("REDIS_"));
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
        std::env::set_var(key, value);
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
    let mut args = std::env::args().skip(1);
    let config_path = match args.next().as_deref() {
        None => PathBuf::from("config/default.toml"),
        Some("--config") => PathBuf::from(args.next().context("--config needs a path")?),
        Some("--help" | "-h") => {
            println!("router-api [--config config/default.toml]");
            return Ok(());
        }
        Some(arg) => anyhow::bail!("unknown argument {arg}"),
    };
    anyhow::ensure!(args.next().is_none(), "unexpected argument");
    let config = Config::load(&config_path)?;
    let document: toml::Value = toml::from_str(&std::fs::read_to_string(&config_path)?)?;
    let reliability_config: reliability::ReliabilityConfig = document
        .get("reliability")
        .cloned()
        .map(toml::Value::try_into)
        .transpose()?
        .unwrap_or_default();
    reliability_config.validate().map_err(anyhow::Error::msg)?;
    let products: HashMap<String, u8> = ["bus", "ubahn", "tram", "sbahn", "rbahn"]
        .into_iter()
        .map(|name| (name.into(), history::product_id(name).unwrap()))
        .collect();
    let mut state = AppState::new(config.clone(), products)?;
    Arc::get_mut(&mut state)
        .context("state unexpectedly shared")?
        .reliability_config = reliability_config;
    if let Some(path) = &config.local_gtfs {
        let gtfs = Bundle::read_file(std::path::Path::new(path))?;
        let stats = config
            .local_stats
            .as_ref()
            .map(|p| Bundle::read_file(std::path::Path::new(p)))
            .transpose()?;
        state.install(Loaded::new(gtfs, stats, &config)?);
    } else {
        let store = Store::new(&config.redis_url)?;
        state.set_history_store(store.clone())?;
        tokio::spawn(router_api::run_reload(state.clone(), store));
    }
    let listener = tokio::net::TcpListener::bind(&config.listen).await?;
    tracing::info!(listen=%config.listen,"router API listening");
    axum::serve(listener, router_api::app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
