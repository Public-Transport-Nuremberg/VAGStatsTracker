const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeObservation, canonicalJson, geoExpiry } = require('../lib/observations');
const { NOW, vehicle } = require('./fixtures');

test('normalizes all source fields, preserves string identifiers and UTC timestamps', () => {
    const { payload, row, sourceMs } = normalizeObservation(vehicle({ NewField: { z: 1, a: 'unknown' } }), NOW);
    assert.equal(payload.vehicleId, '00625');
    assert.equal(payload.journeyId, 'van:02051:_:H:j26:461');
    assert.equal(row.timestamp, '2026-10-11 11:59:40.000');
    assert.equal(sourceMs, NOW - 20000);
    assert.equal(row.timestamp_previous, '2026-10-11 11:59:00.000');
    assert.equal(row.fetched_at, '2026-10-11 12:00:00.000');
    assert.equal(row.delay_seconds, -82);
    assert.equal(row.is_at_stop, 1);
    assert.equal(row.realtime_available, 1);
    assert.equal(row.distance, 0);
    assert.equal(row.line, 'E5');
    assert.equal(row.avm_line_id, '705');
    assert.equal(row.latitude_previous, 49.45);
    assert.equal(row.source, 'vmi');
    assert.equal('Latitude' in payload.raw, false);
    assert.equal(JSON.parse(row.raw_json).X, '1233659.294895');
    assert.deepEqual(JSON.parse(row.raw_json).NewField, { a: 'unknown', z: 1 });
});

test('stable canonical hashes ignore fetch time, key ordering and derived wrapper coordinates', () => {
    const input = vehicle({ extra: { b: 2, a: 1 } });
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    reordered.extra = { a: 1, b: 2 };
    reordered.Latitude = 48;
    const first = normalizeObservation(input, NOW);
    const second = normalizeObservation(reordered, NOW + 10000);
    assert.equal(first.payloadHash, second.payloadHash);
    assert.equal(first.entityKey, second.entityKey);
    assert.notEqual(first.row.observation_id, second.row.observation_id);
    assert.notEqual(first.row.fetched_at, second.row.fetched_at);
    assert.equal(canonicalJson([2, 1]), '[2,1]');
});

test('new timestamp, metadata changes and raw coordinate changes each produce a new hash', () => {
    const original = normalizeObservation(vehicle(), NOW);
    for (const change of [{ Timestamp: '2026-10-11T12:00:00Z' }, { Delay: 0 }, { X: '1233660' }, { Unexpected: true }]) {
        const next = normalizeObservation(vehicle(change), NOW);
        assert.notEqual(next.payloadHash, original.payloadHash);
        assert.equal(next.entityKey, original.entityKey);
    }
});

test('operators and vehicles have separate identities; journeys of one vehicle remain separate objects', () => {
    const first = normalizeObservation(vehicle(), NOW);
    const otherJourney = normalizeObservation(vehicle({ ID: 'different-id', JourneyIdentifier: 'next-journey' }), NOW);
    const otherOperator = normalizeObservation(vehicle({ Operator: 'OVF' }), NOW);
    const alpha = normalizeObservation(vehicle({ VehicleIdentifier: 'BUS-A' }), NOW);
    assert.notEqual(first.entityKey, otherJourney.entityKey);
    assert.equal(first.vehicleKey, otherJourney.vehicleKey);
    assert.notEqual(first.vehicleKey, otherOperator.vehicleKey);
    assert.notEqual(first.entityKey, otherOperator.entityKey);
    assert.equal(alpha.row.vehicle_id, 'BUS-A');
});

test('journey fallback includes operator and operating day; anonymous entries use raw contents', () => {
    const first = normalizeObservation(vehicle({ ID: null }), NOW);
    const otherDay = normalizeObservation(vehicle({ ID: null, DayOfOperation: '12.10.2026' }), NOW);
    assert.notEqual(first.entityKey, otherDay.entityKey);
    const anonymous = normalizeObservation({ LineText: '51' }, NOW);
    assert.equal(anonymous.payload.anonymous, true);
    assert.equal(anonymous.row.anonymous, 1);
    assert.equal(anonymous.entityKey, normalizeObservation({ LineText: '51' }, NOW + 1).entityKey);
    assert.notEqual(anonymous.entityKey, normalizeObservation({ LineText: '52' }, NOW).entityKey);
    assert.equal(anonymous.vehicleKey, `object-${anonymous.entityKey}`);
});

test('missing optional values stay null rather than zero/false', () => {
    const { row, payload } = normalizeObservation({}, NOW);
    for (const field of ['vehicle_id', 'operator', 'timestamp', 'timestamp_previous', 'latitude', 'longitude',
        'delay_seconds', 'mot_code', 'is_at_stop', 'realtime_available', 'distance']) assert.equal(row[field], null, field);
    assert.equal(payload.realtime, null);
    assert.equal(payload.isAtStop, null);
    assert.equal(payload.dayOfOperation, null);
});

test('invalid numbers, positions and timestamps stay nullable, while legitimate zero survives', () => {
    const invalid = normalizeObservation(vehicle({ Latitude: '', Longitude: 11, Delay: false, MOTCode: 1.5,
        Timestamp: '2026-02-30T12:00:00Z', TimestampPrevious: '2026-10-11 12:00:00', Distance: Infinity }), NOW);
    assert.equal(invalid.row.latitude, null);
    assert.equal(invalid.row.longitude, null);
    assert.equal(invalid.row.delay_seconds, null);
    assert.equal(invalid.row.mot_code, null);
    assert.equal(invalid.row.timestamp, null);
    assert.equal(invalid.row.timestamp_previous, null);
    assert.equal(invalid.row.distance, null);
    for (const latitude of [null, false, 'NaN', 91]) assert.equal(normalizeObservation(vehicle({ Latitude: latitude }), NOW).row.latitude, null);
    assert.equal(normalizeObservation(vehicle({ Longitude: 181 }), NOW).row.longitude, null);
    const zero = normalizeObservation(vehicle({ Latitude: 0, Longitude: 0, Delay: 0, MOTCode: 0, IsAtStop: false, RealtimeAvailable: 0 }), NOW);
    assert.equal(zero.row.latitude, 0);
    assert.equal(zero.row.longitude, 0);
    assert.equal(zero.row.delay_seconds, 0);
    assert.equal(zero.row.is_at_stop, 0);
    assert.equal(zero.payload.realtime, false);
});

test('GEO lifetime follows source time; repeated fetching cannot extend it', () => {
    const observation = normalizeObservation(vehicle(), NOW);
    assert.equal(geoExpiry(observation, 180), NOW + 160000);
    assert.equal(geoExpiry(normalizeObservation(vehicle(), NOW + 170000), 180), 0);
    for (const change of [{ Timestamp: null }, { Timestamp: '2026-10-11T12:01:00Z' }, { Latitude: null }, { Latitude: 86 }]) {
        assert.equal(geoExpiry(normalizeObservation(vehicle(change), NOW), 180), 0);
    }
});

test('non-object response entries are rejected', () => {
    for (const input of [null, [], 'vehicle', 5]) assert.throws(() => normalizeObservation(input, NOW), /must be an object/);
});
