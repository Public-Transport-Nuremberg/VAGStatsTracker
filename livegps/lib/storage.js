const { createHash } = require('node:crypto');

// This order and encoding are a persistent storage contract. Migration 005 uses
// the same UTF-8 byte lengths and null markers to backfill identical IDs.
const FAHRT_FIELDS = [
    'source', 'entity_key', 'object_id', 'operator', 'journey_id', 'day_of_operation',
    'vehicle_id', 'mot_code', 'product', 'line', 'direction', 'avm_line_id', 'anonymous',
];
const OBSERVATION_FIELDS = [
    'observation_id', 'source', 'entity_key', 'timestamp', 'timestamp_previous', 'fetched_at',
    'latitude', 'longitude', 'latitude_previous', 'longitude_previous', 'delay_seconds',
    'current_stop', 'next_stop', 'is_at_stop', 'realtime_available', 'distance', 'payload_hash', 'raw_json',
];

function canonicalField(value) {
    if (value === null || value === undefined) return 'N;';
    const text = String(value);
    return `S${Buffer.byteLength(text, 'utf8')}:${text};`;
}

function toStorageRows(row) {
    const metadata = Object.fromEntries(FAHRT_FIELDS.map((field) => [field, row[field] ?? null]));
    const gpsFahrtId = createHash('sha256').update(FAHRT_FIELDS.map((field) => canonicalField(metadata[field])).join('')).digest('hex');
    const fahrt = { gps_fahrt_id: gpsFahrtId, ...metadata };
    const observation = { gps_fahrt_id: gpsFahrtId,
        ...Object.fromEntries(OBSERVATION_FIELDS.map((field) => [field, row[field] ?? null])) };
    // Legacy backfills have a version already; queued rows use ClickHouse's
    // default ingestion version while preserving all observation identity keys.
    if (row.ingested_at !== undefined) {
        fahrt.ingested_at = row.ingested_at;
        observation.ingested_at = row.ingested_at;
    }
    return { fahrt, observation };
}

module.exports = { FAHRT_FIELDS, OBSERVATION_FIELDS, canonicalField, toStorageRows };
