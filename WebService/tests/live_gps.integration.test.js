const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedis, ObservationStore, KEYS } = require('../../livegps/lib/redis');
const { createClickHouse, archiveBatch } = require('../../livegps/lib/clickhouse');
const { normalizeObservation } = require('../../livegps/lib/observations');
const { loadConfig } = require('../../livegps/envSchema');
const { vehicle } = require('../../livegps/test/fixtures');
const migration = require('../../migration/migrations/004_create_livegps_observations');
const { readGpsVehicleValues, queryGpsHistory, historyUrl } = require('../lib/live_gps');

// Fixed disposable localhost services; never use application .env or production data.
const config = loadConfig({ CH_HOST: '127.0.0.1', CH_PORT: 18123, CH_DATABASE: 'default',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: 16379, REDIS_DB: 14 });

async function keys(redis) {
    let cursor = '0';
    const found = [];
    do {
        const page = await redis.scan(cursor, 'MATCH', 'LIVEGPS:VMI:*', 'COUNT', 1000);
        cursor = page[0]; found.push(...page[1]);
    } while (cursor !== '0');
    return found;
}

test('GPS map and history read real worker snapshots and archived observations', {
    skip: process.env.LIVEGPS_MAP_INTEGRATION !== '1', timeout: 60000,
}, async () => {
    const redis = createRedis(config);
    redis.on('error', () => {});
    const admin = createClickHouse(config);
    const database = `gps_map_test_${process.pid}_${Date.now()}`;
    let owned = false, created = false, ch;
    try {
        await redis.connect();
        assert.deepEqual(await keys(redis), [], 'local test DB 14 must have no livegps namespace');
        owned = true;
        await admin.command({ query: `CREATE DATABASE ${database}` });
        created = true;
        ch = createClickHouse({ ...config, CH_DATABASE: database });
        await migration.up(ch);
        const store = new ObservationStore(redis);
        await store.initialize();
        const now = Date.now();
        const day = '2026-10-11';
        const observations = [
            normalizeObservation(vehicle({ Timestamp: new Date(now - 5000).toISOString() }), now),
            normalizeObservation(vehicle({ ID: 'journey-two', JourneyIdentifier: 'second',
                Timestamp: new Date(now - 1000).toISOString() }), now),
            normalizeObservation(vehicle({ Operator: 'OVF', Timestamp: new Date(now - 1000).toISOString() }), now),
            normalizeObservation(vehicle({ ID: 'alpha', VehicleIdentifier: 'BUS-A/01', Operator: 'A&B',
                Timestamp: new Date(now - 1000).toISOString() }), now),
            normalizeObservation(vehicle({ ID: 'no-vehicle', VehicleIdentifier: null,
                Timestamp: new Date(now - 1000).toISOString() }), now),
            normalizeObservation(vehicle({ ID: 'invalid', VehicleIdentifier: 'INVALID', Latitude: null,
                Timestamp: new Date(now - 1000).toISOString() }), now),
            normalizeObservation(vehicle({ ID: 'expired', VehicleIdentifier: 'EXPIRED',
                Timestamp: new Date(now - 181000).toISOString() }), now),
        ];
        await store.publish(observations);
        const map = await readGpsVehicleValues(redis, {}, now);
        assert.equal(Object.keys(map).length, 4, 'one position per operator/vehicle plus identified object');
        const van = Object.values(map).find((entry) => entry.Operator === 'VAN' && entry.Fahrzeugnummer === '00625');
        assert.equal(van.JourneyIdentifier, 'second');
        assert.equal(van.PositionSource, 'gps');
        assert.equal(van.HistoryUrl, `/vehicleHistoryGPS/${day}/00625?operator=VAN`);
        assert.equal(Object.values(map).filter((entry) => entry.Fahrzeugnummer === '00625').length, 2);
        assert.equal(Object.keys(await readGpsVehicleValues(redis, { Linie: 'E5', boundingBox: {
            minLongitude: 11, maxLongitude: 11.2, minLatitude: 49.4, maxLatitude: 49.5,
        } }, now)).length, 4);
        assert.deepEqual(await readGpsVehicleValues(redis, { Linie: 'U1' }, now), {});
        // The web API must exclude expired positions even before the worker prunes GEO.
        await redis.zadd(KEYS.expiry, now - 1, observations[1].vehicleKey);
        assert.equal(Object.keys(await readGpsVehicleValues(redis, {}, now)).length, 3);
        await archiveBatch(store, ch);
        const history = await queryGpsHistory(ch, { at: day, id: '00625', operator: 'VAN', identity: 'vehicle' });
        assert.equal(history.points.length, 2, 'both journeys are retained in history');
        assert.equal((await queryGpsHistory(ch, { at: day, id: 'EXPIRED', operator: 'VAN', identity: 'vehicle' })).points.length, 1, 'stale positions remain in history');
        assert.deepEqual(history.points.slice(-2).map((point) => point.journeyId), [vehicle().JourneyIdentifier, 'second']);
        assert.ok(history.points.every((point) => point.timestamp.endsWith('Z')));
        assert.equal((await queryGpsHistory(ch, { at: day, id: '00625', operator: 'OVF', identity: 'vehicle' })).points.length, 1);
        assert.equal((await queryGpsHistory(ch, { at: day, id: 'INVALID', operator: 'VAN', identity: 'vehicle' })).points.length, 0);
        assert.equal((await queryGpsHistory(ch, { at: day, id: 'BUS-A/01', operator: 'A&B', identity: 'vehicle' })).points.length, 1);
        assert.equal((await queryGpsHistory(ch, { at: day, id: observations[4].entityKey, operator: '', identity: 'object' })).points.length, 1);

        // Missing/invalid operating dates fall back to the source time's Berlin calendar day.
        const fallback = ['', null, 'garbage', '32.13.2026', '2026-02-30'].map((DayOfOperation, index) =>
            normalizeObservation(vehicle({ ID: `fallback-${index}`, VehicleIdentifier: 'FALLBACK', DayOfOperation,
                Timestamp: '2026-10-10T22:30:00Z' }), now));
        const received = normalizeObservation(vehicle({ ID: 'reception', VehicleIdentifier: 'RECEPTION',
            DayOfOperation: null, Timestamp: null }), Date.parse('2026-10-10T22:31:00Z'));
        await ch.insert({ table: 'livegps_observations', values: [...fallback, received].map((item) => item.row), format: 'JSONEachRow' });
        assert.equal(historyUrl(fallback[3].payload), `/vehicleHistoryGPS/${day}/FALLBACK?operator=VAN`);
        assert.equal((await queryGpsHistory(ch, { at: day, id: 'FALLBACK', operator: 'VAN', identity: 'vehicle' })).points.length, 5);
        const reception = await queryGpsHistory(ch, { at: day, id: 'RECEPTION', operator: 'VAN', identity: 'vehicle' });
        assert.equal(reception.points[0].timestamp, null);
        assert.equal(reception.points[0].fetchedAt, '2026-10-10T22:31:00.000Z');
        await ch.insert({ table: 'livegps_observations', values: fallback.map((item) => item.row), format: 'JSONEachRow' });
        assert.equal((await queryGpsHistory(ch, { at: day, id: 'FALLBACK', operator: 'VAN', identity: 'vehicle' })).points.length, 5, 'FINAL deduplicates retries');
    } finally {
        if (owned && redis.status === 'ready') {
            const ownedKeys = await keys(redis);
            if (ownedKeys.length) await redis.del(...ownedKeys);
        }
        redis.disconnect();
        await ch?.close();
        if (created) await admin.command({ query: `DROP DATABASE ${database} SYNC` });
        await admin.close();
    }
});
