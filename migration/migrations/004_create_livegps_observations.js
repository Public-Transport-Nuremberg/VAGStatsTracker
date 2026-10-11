const id = '004_create_livegps_observations';

const up = async (ch) => {
    await ch.command({
        query: `
            CREATE TABLE IF NOT EXISTS livegps_observations (
                observation_id       String,
                source               LowCardinality(String),
                entity_key           String,
                anonymous            UInt8,
                object_id            Nullable(String),
                operator             Nullable(String),
                journey_id           Nullable(String),
                day_of_operation     Nullable(String),
                vehicle_id           Nullable(String),
                timestamp            Nullable(DateTime64(3, 'UTC')),
                timestamp_previous   Nullable(DateTime64(3, 'UTC')),
                fetched_at           DateTime64(3, 'UTC'),
                latitude             Nullable(Float64),
                longitude            Nullable(Float64),
                latitude_previous    Nullable(Float64),
                longitude_previous   Nullable(Float64),
                delay_seconds        Nullable(Float64),
                mot_code             Nullable(Int32),
                product              Nullable(String),
                line                 Nullable(String),
                direction            Nullable(String),
                current_stop         Nullable(String),
                next_stop            Nullable(String),
                is_at_stop           Nullable(UInt8),
                realtime_available   Nullable(Float64),
                avm_line_id          Nullable(String),
                distance             Nullable(Float64),
                payload_hash         String,
                raw_json             String,
                ingested_at          DateTime64(3, 'UTC') DEFAULT now64(3)
            ) ENGINE = ReplacingMergeTree(ingested_at)
            PARTITION BY toYYYYMM(fetched_at)
            ORDER BY (source, entity_key, fetched_at, observation_id)
        `,
    });
}

module.exports = {
    id,
    up,
}
