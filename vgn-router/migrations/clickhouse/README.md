# ClickHouse source contract

The router reads the existing `haltestellen`, `fahrten`, and `fahrten_halte`
ReplacingMergeTree tables from `migration/migrations/001_create_base_tables.js`.
No additional table, destructive migration, or materialized view is required.

Production query implementations live in `crates/history/src/clickhouse_source.rs`.
They use FINAL on each source, join on (Betriebstag, Fahrtnummer, Produkt), and
bind date, timezone, holiday, and delay-unit query parameters through HTTP.
The configured database and HTTP Basic authentication use CH_URL, CH_DATABASE,
CH_USER and CH_PASSWORD environment overrides. HISTORY_DELAY_UNIT accepts
seconds (default) or minutes. Numeric products must be mapped explicitly in
config/product-map.toml.

Arrival and departure queries group their own local scheduled event times.
Each result is a count and sum per 30-second bin and statistical dimension;
individual observations are never downloaded. Quantiles are estimates at the
bin's lower endpoint. Underflow/overflow quantiles retain the aggregate extrema
as i32 rather than wrapping at i16. Means use exact sums. Delay tail probabilities
at 60/180/300/600 seconds align exactly with bins.

Cancellation first reduces stop records to one row per dated product/trip,
using the first planned departure and its direction text. It then joins that
row to fahrten, so the number of stops cannot multiply cancellation counts.
Missing planned times use only day-type and line-level fallbacks.

A build checks max(Betriebstag) against the expected previous day and rejects
empty, malformed or failed aggregates. This availability check cannot establish
that an upstream ingestion batch is complete; schedule the builder after the
source ingestion has finished. Existing active snapshots remain the publisher's
responsibility on failure.

The default primary window is 30 days. For each key with fewer than the configured
minimum (at least 20), the builder may use up to 90 days. Observations from the
most recent 7 days have a default weight of four, while minimum-sample selection
continues to use the unweighted observation count. History dates describe
the complete candidate window. Requests reject snapshots with history_until on
or after the requested local date.
