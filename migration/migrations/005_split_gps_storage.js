const id = '005_split_gps_storage';

// Keep in sync with livegps/lib/storage.js. length() measures UTF-8 bytes;
// lengthUTF8() counts code points and would produce different hashes.
const FAHRT_FIELDS = [
    'source', 'entity_key', 'object_id', 'operator', 'journey_id', 'day_of_operation',
    'vehicle_id', 'mot_code', 'product', 'line', 'direction', 'avm_line_id', 'anonymous',
];
const OBSERVATION_FIELDS = [
    'observation_id', 'source', 'entity_key', 'timestamp', 'timestamp_previous', 'fetched_at',
    'latitude', 'longitude', 'latitude_previous', 'longitude_previous', 'delay_seconds',
    'current_stop', 'next_stop', 'is_at_stop', 'realtime_available', 'distance', 'payload_hash', 'raw_json',
];
const canonicalFieldSql = (field) => `if(isNull(${field}), 'N;', concat('S', toString(length(ifNull(toString(${field}), ''))), ':', ifNull(toString(${field}), ''), ';'))`;
const fahrtIdSql = `lower(hex(SHA256(concat(${FAHRT_FIELDS.map(canonicalFieldSql).join(', ')}))))`;

const up = async (ch) => {
    await ch.command({ query: `
        CREATE TABLE IF NOT EXISTS gps_fahrten (
            gps_fahrt_id          String,
            source                LowCardinality(String),
            entity_key            String,
            object_id             Nullable(String),
            operator              Nullable(String),
            journey_id            Nullable(String),
            day_of_operation      Nullable(String),
            vehicle_id            Nullable(String),
            mot_code              Nullable(Int32),
            product               Nullable(String),
            line                  Nullable(String),
            direction             Nullable(String),
            avm_line_id           Nullable(String),
            anonymous             UInt8,
            ingested_at           DateTime64(3, 'UTC') DEFAULT now64(3),
            INDEX entity_key_bloom entity_key TYPE bloom_filter GRANULARITY 1
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (source, ifNull(operator, ''), ifNull(vehicle_id, ''), ifNull(day_of_operation, ''), gps_fahrt_id)
    ` });
    await ch.command({ query: `
        CREATE TABLE IF NOT EXISTS gps_observations (
            gps_fahrt_id          String,
            observation_id        String,
            source                LowCardinality(String),
            entity_key            String,
            timestamp             Nullable(DateTime64(3, 'UTC')),
            timestamp_previous    Nullable(DateTime64(3, 'UTC')),
            fetched_at            DateTime64(3, 'UTC'),
            latitude              Nullable(Float64),
            longitude             Nullable(Float64),
            latitude_previous     Nullable(Float64),
            longitude_previous    Nullable(Float64),
            delay_seconds         Nullable(Float64),
            current_stop          Nullable(String),
            next_stop             Nullable(String),
            is_at_stop            Nullable(UInt8),
            realtime_available    Nullable(Float64),
            distance              Nullable(Float64),
            payload_hash          String,
            raw_json              String,
            ingested_at           DateTime64(3, 'UTC') DEFAULT now64(3),
            INDEX entity_key_bloom entity_key TYPE bloom_filter GRANULARITY 1
        ) ENGINE = ReplacingMergeTree(ingested_at)
        PARTITION BY toYYYYMM(fetched_at)
        ORDER BY (source, gps_fahrt_id, fetched_at, observation_id)
    ` });
    // Additive and safely repeatable after a partial failure: leave the legacy
    // archive untouched and preserve its versions, IDs and null/source values.
    await ch.command({ query: `
        INSERT INTO gps_fahrten (gps_fahrt_id, ${FAHRT_FIELDS.join(', ')}, ingested_at)
        SELECT ${fahrtIdSql} AS gps_fahrt_id, ${FAHRT_FIELDS.join(', ')}, max(ingested_at)
        FROM livegps_observations FINAL
        GROUP BY ${FAHRT_FIELDS.join(', ')}
    ` });
    await ch.command({ query: `
        INSERT INTO gps_observations (gps_fahrt_id, ${OBSERVATION_FIELDS.join(', ')}, ingested_at)
        SELECT ${fahrtIdSql}, ${OBSERVATION_FIELDS.join(', ')}, ingested_at
        FROM livegps_observations FINAL
    ` });
};

module.exports = { id, up, FAHRT_FIELDS, OBSERVATION_FIELDS, fahrtIdSql };
