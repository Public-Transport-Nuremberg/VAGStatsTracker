use prometheus::{
    Encoder, Histogram, HistogramOpts, IntCounter, IntGauge, Opts, Registry, TextEncoder,
};

pub struct Metrics {
    registry: Registry,
    pub requests: IntCounter,
    pub duration: Histogram,
    pub not_found: IntCounter,
    pub lookup: IntCounter,
    pub lookup_miss: IntCounter,
    pub reload_failures: IntCounter,
    pub gtfs_timestamp: IntGauge,
    pub stats_timestamp: IntGauge,
}

impl Metrics {
    pub fn new() -> anyhow::Result<Self> {
        let registry = Registry::new();
        let counter = |name: &str, help: &str| -> anyhow::Result<IntCounter> {
            let c = IntCounter::with_opts(Opts::new(name, help))?;
            registry.register(Box::new(c.clone()))?;
            Ok(c)
        };
        let gauge = |name: &str, help: &str| -> anyhow::Result<IntGauge> {
            let c = IntGauge::with_opts(Opts::new(name, help))?;
            registry.register(Box::new(c.clone()))?;
            Ok(c)
        };
        let requests = counter("router_requests_total", "Journey requests")?;
        let not_found = counter(
            "router_journeys_not_found_total",
            "No scheduled journey found",
        )?;
        let lookup = counter("router_stats_lookup_total", "Reliability lookups")?;
        let lookup_miss = counter(
            "router_stats_lookup_miss_total",
            "Unavailable reliability lookups",
        )?;
        let reload_failures = counter(
            "router_redis_reload_failures_total",
            "Failed snapshot reloads; previous state retained",
        )?;
        let gtfs_timestamp = gauge(
            "router_gtfs_snapshot_timestamp",
            "Active GTFS publication time",
        )?;
        let stats_timestamp = gauge(
            "router_stats_snapshot_timestamp",
            "Active statistics generation time",
        )?;
        let duration = Histogram::with_opts(
            HistogramOpts::new(
                "router_request_duration_seconds",
                "Journey request duration",
            )
            .buckets(vec![
                0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5, 1.0, 5.0,
            ]),
        )?;
        registry.register(Box::new(duration.clone()))?;
        Ok(Self {
            registry,
            requests,
            duration,
            not_found,
            lookup,
            lookup_miss,
            reload_failures,
            gtfs_timestamp,
            stats_timestamp,
        })
    }
    pub fn render(&self) -> anyhow::Result<String> {
        let mut out = Vec::new();
        TextEncoder::new().encode(&self.registry.gather(), &mut out)?;
        Ok(String::from_utf8(out)?)
    }
}
