//! Immutable, checked binary snapshots. Redis is only accessed by loaders/builders.
pub mod packaging;
use anyhow::{ensure, Context, Result};
use bincode::Options;
use chrono::{Datelike, NaiveDate, Utc};
use redis::AsyncCommands;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, path::Path};

pub const PREFIX: &str = "vgnrouter:v1";
pub const RELOAD_CHANNEL: &str = "vgnrouter:v1:reload";
const STATS_HISTORY_DATES: &str = "vgnrouter:v1:stats:history:dates";
const STATS_HISTORY_VERSIONS: &str = "vgnrouter:v1:stats:history:versions";
pub const MAX_BYTES: usize = 2 * 1024 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 16 * 1024 * 1024;
static SNAPSHOT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Part {
    pub name: String,
    pub chunks: usize,
    pub compressed_bytes: usize,
    pub uncompressed_bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub snapshot_id: String,
    pub generated_at: String,
    pub kind: String,
    pub sha256: String,
    pub parts: Vec<Part>,
    pub metadata: serde_json::Value,
}

#[derive(Clone, Debug)]
pub struct Bundle {
    pub manifest: Manifest,
    pub blobs: BTreeMap<String, Vec<u8>>,
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn encode<T: Serialize>(value: &T) -> Result<(Vec<u8>, usize)> {
    let raw = bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_BYTES as u64)
        .serialize(value)?;
    let size = raw.len();
    Ok((zstd::stream::encode_all(raw.as_slice(), 3)?, size))
}

pub fn decode<T: DeserializeOwned>(blob: &[u8], raw_size: usize) -> Result<T> {
    ensure!(
        raw_size <= MAX_BYTES && blob.len() <= MAX_BYTES,
        "snapshot too large"
    );
    let decoder = zstd::stream::read::Decoder::new(blob)?;
    let mut raw = Vec::new();
    decoder.take(raw_size as u64 + 1).read_to_end(&mut raw)?;
    ensure!(raw.len() == raw_size, "uncompressed snapshot size mismatch");
    Ok(bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(raw_size as u64)
        .reject_trailing_bytes()
        .deserialize(&raw)?)
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Bundle {
    pub fn new(kind: &str, metadata: serde_json::Value) -> Result<Self> {
        ensure!(matches!(kind, "gtfs" | "stats"), "invalid snapshot kind");
        Ok(Self {
            manifest: Manifest {
                schema_version: 1,
                snapshot_id: format!(
                    "{}-{}-{}",
                    Utc::now().format("%Y%m%dT%H%M%S%9fZ"),
                    std::process::id(),
                    SNAPSHOT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                ),
                generated_at: Utc::now().to_rfc3339(),
                kind: kind.into(),
                sha256: sha256(&[]),
                parts: Vec::new(),
                metadata,
            },
            blobs: BTreeMap::new(),
        })
    }

    pub fn insert<T: Serialize>(&mut self, name: &str, value: &T) -> Result<()> {
        ensure!(
            valid_name(name) && !self.blobs.contains_key(name),
            "invalid or duplicate part"
        );
        let (blob, uncompressed_bytes) = encode(value)?;
        self.manifest.parts.push(Part {
            name: name.into(),
            chunks: blob.len().div_ceil(CHUNK_BYTES),
            compressed_bytes: blob.len(),
            uncompressed_bytes,
            sha256: sha256(&blob),
        });
        self.blobs.insert(name.into(), blob);
        self.manifest.sha256 = self.digest();
        Ok(())
    }

    fn digest(&self) -> String {
        let mut hash = Sha256::new();
        for (name, blob) in &self.blobs {
            hash.update((name.len() as u64).to_le_bytes());
            hash.update(name.as_bytes());
            hash.update((blob.len() as u64).to_le_bytes());
            hash.update(blob);
        }
        format!("{hash:x}", hash = hash.finalize())
    }

    pub fn validate(&self) -> Result<()> {
        validate_manifest(&self.manifest)?;
        ensure!(
            self.manifest.parts.len() == self.blobs.len(),
            "unexpected/missing parts"
        );
        for part in &self.manifest.parts {
            let blob = self
                .blobs
                .get(&part.name)
                .context("missing snapshot part")?;
            ensure!(
                blob.len() == part.compressed_bytes && sha256(blob) == part.sha256,
                "snapshot checksum mismatch: {}",
                part.name
            );
        }
        ensure!(
            self.digest() == self.manifest.sha256,
            "snapshot aggregate checksum mismatch"
        );
        Ok(())
    }

    pub fn get<T: DeserializeOwned>(&self, name: &str) -> Result<T> {
        let part = self
            .manifest
            .parts
            .iter()
            .find(|p| p.name == name)
            .context("missing part")?;
        let blob = self.blobs.get(name).context("missing blob")?;
        ensure!(sha256(blob) == part.sha256, "checksum mismatch");
        decode(blob, part.uncompressed_bytes)
    }

    /// One portable file; write to a new path, then configure the API to use it.
    pub fn write_file(&self, path: &Path) -> Result<()> {
        use std::io::Write;
        self.validate()?;
        let header = serde_json::to_vec(&self.manifest)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(&(header.len() as u64).to_le_bytes())?;
        file.write_all(&header)?;
        for part in &self.manifest.parts {
            file.write_all(&self.blobs[&part.name])?;
        }
        file.sync_all()?;
        Ok(())
    }

    pub fn read_file(path: &Path) -> Result<Self> {
        let mut file = std::fs::File::open(path)?;
        let mut len = [0; 8];
        file.read_exact(&mut len)?;
        let header_len = u64::from_le_bytes(len);
        ensure!(header_len <= 1024 * 1024, "manifest too large");
        let mut header = vec![0; header_len as usize];
        file.read_exact(&mut header)?;
        let manifest: Manifest = serde_json::from_slice(&header)?;
        validate_manifest(&manifest)?;
        let mut blobs = BTreeMap::new();
        for part in &manifest.parts {
            let mut blob = vec![0; part.compressed_bytes];
            file.read_exact(&mut blob)?;
            blobs.insert(part.name.clone(), blob);
        }
        let mut tail = [0];
        ensure!(file.read(&mut tail)? == 0, "trailing snapshot bytes");
        let result = Self { manifest, blobs };
        result.validate()?;
        Ok(result)
    }
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    ensure!(manifest.schema_version == 1, "unsupported snapshot schema");
    ensure!(
        matches!(manifest.kind.as_str(), "gtfs" | "stats") && valid_name(&manifest.snapshot_id),
        "invalid snapshot identity"
    );
    ensure!(
        !manifest.parts.is_empty() && manifest.parts.len() <= 32,
        "invalid part count"
    );
    let mut names = std::collections::HashSet::new();
    let mut total = 0usize;
    for p in &manifest.parts {
        ensure!(
            valid_name(&p.name) && names.insert(&p.name),
            "invalid/duplicate part name"
        );
        ensure!(
            p.compressed_bytes > 0
                && p.compressed_bytes <= MAX_BYTES
                && p.uncompressed_bytes <= MAX_BYTES,
            "invalid part size"
        );
        ensure!(
            p.chunks == p.compressed_bytes.div_ceil(CHUNK_BYTES),
            "invalid chunk count"
        );
        total = total
            .checked_add(p.compressed_bytes)
            .context("snapshot size overflow")?;
    }
    ensure!(total <= MAX_BYTES, "snapshot too large");
    Ok(())
}

#[derive(Clone)]
pub struct Store {
    client: redis::Client,
}

impl Store {
    pub fn new(url: &str) -> Result<Self> {
        Ok(Self {
            client: redis::Client::open(url)?,
        })
    }
    pub fn client(&self) -> &redis::Client {
        &self.client
    }
    pub async fn active_id(&self, kind: &str) -> Result<Option<String>> {
        ensure!(matches!(kind, "gtfs" | "stats"), "invalid kind");
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        Ok(conn.get(format!("{PREFIX}:{kind}:active")).await?)
    }

    /// Stage immutable chunks, read back and validate, then atomically persist and switch.
    pub async fn publish(&self, bundle: &Bundle) -> Result<()> {
        self.persist(bundle, true).await
    }

    /// Persist a statistics version for point-in-time routing without replacing the active one.
    pub async fn archive(&self, bundle: &Bundle) -> Result<()> {
        ensure!(
            bundle.manifest.kind == "stats",
            "only statistics can be archived"
        );
        self.persist(bundle, false).await
    }

    async fn persist(&self, bundle: &Bundle, activate: bool) -> Result<()> {
        bundle.validate()?;
        let m = &bundle.manifest;
        let history_until = if m.kind == "stats" {
            let value = m
                .metadata
                .get("history_until")
                .and_then(serde_json::Value::as_str)
                .context("statistics manifest missing history_until")?;
            Some(NaiveDate::parse_from_str(value, "%Y-%m-%d")?)
        } else {
            None
        };
        let base = format!("{PREFIX}:{}:{}", m.kind, m.snapshot_id);
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let mut keys = Vec::new();
        for part in &m.parts {
            for (i, chunk) in bundle.blobs[&part.name].chunks(CHUNK_BYTES).enumerate() {
                let key = format!("{base}:{}:{i}", part.name);
                let set: Option<String> = redis::cmd("SET")
                    .arg(&key)
                    .arg(chunk)
                    .arg("NX")
                    .arg("EX")
                    .arg(86400)
                    .query_async(&mut conn)
                    .await?;
                ensure!(set.is_some(), "snapshot version already exists");
                keys.push(key);
            }
        }
        let manifest_key = format!("{base}:manifest");
        let set: Option<String> = redis::cmd("SET")
            .arg(&manifest_key)
            .arg(serde_json::to_vec(m)?)
            .arg("NX")
            .arg("EX")
            .arg(86400)
            .query_async(&mut conn)
            .await?;
        ensure!(set.is_some(), "snapshot manifest already exists");
        keys.push(manifest_key);
        self.load_version(&m.kind, &m.snapshot_id)
            .await?
            .context("staged snapshot disappeared")?
            .validate()?;
        let script = redis::Script::new(
            r#"
            for i = 4, #KEYS do
                if redis.call('EXISTS', KEYS[i]) == 0 then return redis.error_reply('missing snapshot chunk') end
            end
            for i = 4, #KEYS do redis.call('PERSIST', KEYS[i]) end
            if ARGV[5] ~= '' then
                redis.call('ZADD', KEYS[2], ARGV[6], ARGV[5])
                redis.call('HSET', KEYS[3], ARGV[5], ARGV[1])
            end
            if ARGV[4] == '1' then
                redis.call('SET', KEYS[1], ARGV[1])
                redis.call('PUBLISH', ARGV[2], ARGV[3])
            end
            return 1
        "#,
        );
        let mut invoke = script.prepare_invoke();
        invoke.key(format!("{PREFIX}:{}:active", m.kind));
        invoke.key(STATS_HISTORY_DATES);
        invoke.key(STATS_HISTORY_VERSIONS);
        for key in keys {
            invoke.key(key);
        }
        let history_date = history_until
            .map(|date| date.to_string())
            .unwrap_or_default();
        let history_score = history_until
            .map(|date| date.num_days_from_ce())
            .unwrap_or_default();
        let _: i32 = invoke
            .arg(&m.snapshot_id)
            .arg(RELOAD_CHANNEL)
            .arg(&m.kind)
            .arg(if activate { "1" } else { "0" })
            .arg(history_date)
            .arg(history_score)
            .invoke_async(&mut conn)
            .await?;
        Ok(())
    }

    /// Find the newest statistics snapshot whose observations end before `route_date`.
    pub async fn stats_version_before(&self, route_date: NaiveDate) -> Result<Option<String>> {
        let maximum = route_date
            .pred_opt()
            .context("route date has no predecessor")?
            .num_days_from_ce();
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let dates: Vec<String> = redis::cmd("ZREVRANGEBYSCORE")
            .arg(STATS_HISTORY_DATES)
            .arg(maximum)
            .arg("-inf")
            .arg("LIMIT")
            .arg(0)
            .arg(1)
            .query_async(&mut conn)
            .await?;
        let Some(date) = dates.into_iter().next() else {
            return Ok(None);
        };
        Ok(conn.hget(STATS_HISTORY_VERSIONS, date).await?)
    }

    pub async fn load_active(&self, kind: &str) -> Result<Option<Bundle>> {
        match self.active_id(kind).await? {
            Some(id) => self
                .load_version(kind, &id)
                .await?
                .map(Some)
                .context("active snapshot missing"),
            None => Ok(None),
        }
    }

    pub async fn load_version(&self, kind: &str, id: &str) -> Result<Option<Bundle>> {
        ensure!(
            matches!(kind, "gtfs" | "stats") && valid_name(id),
            "invalid snapshot identity"
        );
        let base = format!("{PREFIX}:{kind}:{id}");
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let header: Option<Vec<u8>> = conn.get(format!("{base}:manifest")).await?;
        let Some(header) = header else {
            return Ok(None);
        };
        ensure!(header.len() <= 1024 * 1024, "manifest too large");
        let manifest: Manifest = serde_json::from_slice(&header)?;
        validate_manifest(&manifest)?;
        ensure!(
            manifest.kind == kind && manifest.snapshot_id == id,
            "manifest identity mismatch"
        );
        let mut blobs = BTreeMap::new();
        for part in &manifest.parts {
            let mut blob = Vec::with_capacity(part.compressed_bytes);
            for i in 0..part.chunks {
                let chunk: Option<Vec<u8>> = conn.get(format!("{base}:{}:{i}", part.name)).await?;
                let chunk = chunk.context("missing snapshot chunk")?;
                ensure!(
                    chunk.len() <= CHUNK_BYTES && blob.len() + chunk.len() <= part.compressed_bytes,
                    "invalid chunk size"
                );
                blob.extend(chunk);
            }
            blobs.insert(part.name.clone(), blob);
        }
        let bundle = Bundle { manifest, blobs };
        bundle.validate()?;
        Ok(Some(bundle))
    }

    pub async fn manifest(&self, kind: &str, id: &str) -> Result<Option<Manifest>> {
        ensure!(
            matches!(kind, "gtfs" | "stats") && valid_name(id),
            "invalid snapshot identity"
        );
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let header: Option<Vec<u8>> = conn.get(format!("{PREFIX}:{kind}:{id}:manifest")).await?;
        let Some(header) = header else {
            return Ok(None);
        };
        ensure!(header.len() <= 1024 * 1024, "manifest too large");
        let manifest: Manifest = serde_json::from_slice(&header)?;
        validate_manifest(&manifest)?;
        ensure!(
            manifest.kind == kind && manifest.snapshot_id == id,
            "manifest identity mismatch"
        );
        Ok(Some(manifest))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub redis_url: String,
    pub listen: String,
    pub gtfs_path: String,
    pub local_gtfs: Option<String>,
    pub local_stats: Option<String>,
    pub default_transfer_seconds: u32,
    pub horizon_seconds: u32,
    pub day_cache_capacity: usize,
    pub stats_history_cache_capacity: usize,
    pub reload_seconds: u64,
    pub min_samples: u32,
    pub product_map: String,
    pub stop_overrides: String,
    pub walking_speed_mps: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            redis_url: "redis://127.0.0.1:6379/0".into(),
            listen: "127.0.0.1:8088".into(),
            gtfs_path: "data/vgn.zip".into(),
            local_gtfs: None,
            local_stats: None,
            default_transfer_seconds: 120,
            horizon_seconds: 36 * 3600,
            day_cache_capacity: 8,
            stats_history_cache_capacity: 8,
            reload_seconds: 60,
            min_samples: 20,
            product_map: "config/product-map.toml".into(),
            stop_overrides: "config/stop-overrides.csv".into(),
            walking_speed_mps: 1.3,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let document: toml::Value = toml::from_str(&std::fs::read_to_string(path)?)?;
        let mut value: Self = document
            .get("router")
            .context("missing [router]")?
            .clone()
            .try_into()?;
        if let Ok(url) = std::env::var("REDIS_URL") {
            value.redis_url = url;
        } else if let Ok(host) = std::env::var("REDIS_HOST") {
            let port = std::env::var("REDIS_PORT").unwrap_or_else(|_| "6379".into());
            let db = std::env::var("REDIS_DB").unwrap_or_else(|_| "0".into());
            let mut redis_url = url::Url::parse(&format!("redis://{host}:{port}/"))
                .context("invalid REDIS_HOST or REDIS_PORT")?;
            if let Ok(user) = std::env::var("REDIS_USER") {
                redis_url
                    .set_username(&user)
                    .map_err(|_| anyhow::anyhow!("invalid REDIS_USER"))?;
            }
            if let Ok(password) = std::env::var("REDIS_PASSWORD") {
                redis_url
                    .set_password(Some(&password))
                    .map_err(|_| anyhow::anyhow!("invalid REDIS_PASSWORD"))?;
            }
            redis_url.set_path(&format!("/{db}"));
            value.redis_url = redis_url.into();
        }
        ensure!(
            value.day_cache_capacity > 0 && value.day_cache_capacity <= 64,
            "cache capacity must be 1..64"
        );
        ensure!(
            value.stats_history_cache_capacity > 0 && value.stats_history_cache_capacity <= 64,
            "statistics history cache capacity must be 1..64"
        );
        ensure!(
            value.horizon_seconds > 0 && value.horizon_seconds <= 7 * 86400,
            "horizon must be 1 second..7 days"
        );
        ensure!(
            value.reload_seconds > 0 && value.min_samples >= 1,
            "reload interval and min_samples must be positive"
        );
        ensure!(
            value.walking_speed_mps.is_finite() && value.walking_speed_mps > 0.0,
            "walking speed must be positive"
        );
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corruption_and_schema_rejected() {
        let mut bundle = Bundle::new("gtfs", serde_json::json!({})).unwrap();
        bundle.insert("stops", &vec![1u32, 2, 3]).unwrap();
        bundle.validate().unwrap();
        assert_eq!(bundle.get::<Vec<u32>>("stops").unwrap(), vec![1, 2, 3]);
        let good = bundle.clone();
        bundle.blobs.get_mut("stops").unwrap()[0] ^= 1;
        assert!(bundle.validate().is_err());
        bundle = good;
        bundle.manifest.schema_version = 2;
        assert!(bundle.validate().is_err());
    }
    #[test]
    fn decompress_limit_and_duplicate_parts() {
        let (blob, size) = encode(&vec![0u8; 4096]).unwrap();
        assert!(decode::<Vec<u8>>(&blob, size - 1).is_err());
        let mut bundle = Bundle::new("stats", serde_json::json!({})).unwrap();
        bundle.insert("delay", &42u32).unwrap();
        assert!(bundle.insert("delay", &1u32).is_err());
        assert!(bundle.insert("../bad", &1u32).is_err());
    }
    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL pointing at an isolated Redis instance"]
    async fn redis_roundtrip_and_missing_chunk_retains_pointer() -> Result<()> {
        let store = Store::new(&std::env::var("TEST_REDIS_URL")?)?;
        let history_until = NaiveDate::from_ymd_opt(2026, 9, 18).unwrap();
        let mut bundle = Bundle::new(
            "stats",
            serde_json::json!({"test": true, "history_until": history_until}),
        )?;
        bundle.insert("delay", &vec![1i32, -2, 300])?;
        store.publish(&bundle).await?;
        let loaded = store.load_active("stats").await?.unwrap();
        assert_eq!(loaded.get::<Vec<i32>>("delay")?, vec![1, -2, 300]);
        assert!(store.publish(&bundle).await.is_err());
        assert_eq!(
            store.active_id("stats").await?,
            Some(bundle.manifest.snapshot_id)
        );
        assert_eq!(
            store
                .stats_version_before(NaiveDate::from_ymd_opt(2026, 9, 19).unwrap())
                .await?,
            store.active_id("stats").await?
        );
        Ok(())
    }
}
