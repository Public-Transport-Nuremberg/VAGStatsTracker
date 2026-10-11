const test = require('node:test');
const assert = require('node:assert/strict');
const { toStorageRows, canonicalField, FAHRT_FIELDS, OBSERVATION_FIELDS } = require('../lib/storage');
const { normalizeObservation } = require('../lib/observations');
const { NOW, vehicle } = require('./fixtures');
const migration = require('../../migration/migrations/005_split_gps_storage');

test('trip metadata is shared across dynamic observations and split from observation columns', () => {
    const first = toStorageRows(normalizeObservation(vehicle(), NOW).row);
    const second = toStorageRows(normalizeObservation(vehicle({ Timestamp: '2026-10-11T12:00:00Z',
        CurrentStop: 'FINK:1', NextStop: 'NEXT:1', IsAtStop: false, Latitude: 49.5, Delay: 12 }), NOW + 20000).row);
    assert.deepEqual(first.fahrt, second.fahrt);
    assert.equal(first.observation.gps_fahrt_id, second.observation.gps_fahrt_id);
    assert.notEqual(first.observation.observation_id, second.observation.observation_id);
    assert.notEqual(first.observation.timestamp, second.observation.timestamp);
    assert.equal(first.observation.is_at_stop, 1);
    assert.equal(second.observation.is_at_stop, 0);
    assert.equal(first.fahrt.line, 'E5');
    assert.equal(Object.hasOwn(first.observation, 'line'), false);
    assert.equal(Object.hasOwn(first.fahrt, 'current_stop'), false);
});

test('static metadata changes produce a new ID without altering historical metadata', () => {
    const original = normalizeObservation(vehicle(), NOW).row;
    const first = toStorageRows(original);
    for (const field of FAHRT_FIELDS) {
        const changed = toStorageRows({ ...original, [field]: typeof original[field] === 'number' ? original[field] + 1 : `${original[field]} other` });
        assert.notEqual(first.fahrt.gps_fahrt_id, changed.fahrt.gps_fahrt_id, field);
    }
    assert.equal(first.fahrt.journey_id, vehicle().JourneyIdentifier);
});

test('nullable and multilingual metadata use distinct length-prefixed canonical bytes', () => {
    assert.equal(canonicalField(null), 'N;');
    assert.equal(canonicalField(''), 'S0:;');
    assert.equal(canonicalField('N;'), 'S2:N;;');
    assert.equal(canonicalField('Nürnberg 🚋'), 'S14:Nürnberg 🚋;');
    const original = normalizeObservation(vehicle(), NOW).row;
    assert.notEqual(toStorageRows({ ...original, direction: null }).fahrt.gps_fahrt_id,
        toStorageRows({ ...original, direction: '' }).fahrt.gps_fahrt_id);
    assert.notEqual(toStorageRows({ ...original, direction: 'a;', line: 'b' }).fahrt.gps_fahrt_id,
        toStorageRows({ ...original, direction: 'a', line: ';b' }).fahrt.gps_fahrt_id);
});

test('source identity protects missing journeys and backfill versions are preserved', () => {
    const a = normalizeObservation(vehicle({ JourneyIdentifier: null }), NOW).row;
    const b = normalizeObservation(vehicle({ JourneyIdentifier: null, ID: 'other-object' }), NOW).row;
    assert.notEqual(toStorageRows(a).fahrt.gps_fahrt_id, toStorageRows(b).fahrt.gps_fahrt_id);
    const legacy = toStorageRows({ ...a, ingested_at: '2026-10-11 12:00:00.000' });
    assert.equal(legacy.fahrt.ingested_at, '2026-10-11 12:00:00.000');
    assert.equal(legacy.observation.ingested_at, legacy.fahrt.ingested_at);
    assert.equal(legacy.observation.raw_json, a.raw_json);
});

test('migration canonical field order matches future writes', () => {
    assert.deepEqual(migration.FAHRT_FIELDS, FAHRT_FIELDS);
    assert.deepEqual(migration.OBSERVATION_FIELDS, OBSERVATION_FIELDS);
    assert.ok(migration.fahrtIdSql.includes('length('));
    assert.ok(!migration.fahrtIdSql.includes('lengthUTF8'));
});
