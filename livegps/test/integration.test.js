const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { createRedis, ObservationStore, KEYS, GROUP } = require('../lib/redis');
const { createClickHouse, archiveBatch } = require('../lib/clickhouse');
const { normalizeObservation } = require('../lib/observations');
const { loadConfig } = require('../envSchema');
const { NOW, vehicle } = require('./fixtures');
const migration = require('../../migration/migrations/004_create_livegps_observations');

// These endpoints are deliberately not read from .env or production configuration.
// Use dedicated, disposable local services. Only our prefix and generated DB are deleted.
const enabled = ['1', 'redis'].includes(process.env.LIVEGPS_INTEGRATION);
const config = loadConfig({ CH_HOST: '127.0.0.1', CH_PORT: 18123, CH_DATABASE: 'default',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: 16379, REDIS_DB: 15 });

async function namespaceKeys(redis) {
    const keys = [];
    let cursor = '0';
    do {
        const response = await redis.scan(cursor, 'MATCH', 'LIVEGPS:VMI:*', 'COUNT', 1000);
        cursor = response[0];
        keys.push(...response[1]);
    } while (cursor !== '0');
    return keys;
}

async function withLocalRedis(callback) {
    const redis = createRedis(config);
    redis.on('error', () => {});
    let ownsNamespace = false;
    try {
        await redis.connect();
        assert.deepEqual(await namespaceKeys(redis), [], 'test DB 15 must not already contain LIVEGPS keys');
        ownsNamespace = true;
        const reset = async () => {
            const keys = await namespaceKeys(redis);
            if (keys.length) await redis.del(...keys);
        };
        await callback(redis, reset);
    } finally {
        if (ownsNamespace && redis.status === 'ready') {
            const keys = await namespaceKeys(redis);
            if (keys.length) await redis.del(...keys);
        }
        redis.disconnect();
    }
}

test('real Redis Lua, latest snapshots, GEO expiry and stream recovery', { skip: !enabled, timeout: 60000 }, async (t) => {
    await withLocalRedis(async (redis, reset) => {
        await t.test('unchanged polls refresh snapshots without enqueuing another observation', async () => {
            const store = new ObservationStore(redis);
            await store.initialize();
            const original = normalizeObservation(vehicle(), NOW);
            assert.equal(await store.publish([original, original]), 1);
            assert.equal(await store.publish([normalizeObservation(vehicle(), NOW + 10000)]), 0);
            assert.equal(await store.backlog(), 1);
            const latest = JSON.parse(await redis.get(KEYS.object(original.entityKey)));
            assert.equal(latest.fetchedAt, new Date(NOW + 10000).toISOString());
            assert.equal(await redis.hget(KEYS.state(original.entityKey), 'hash'), original.payloadHash);
            assert.equal(await redis.ttl(KEYS.state(original.entityKey)), -1);
            const updated = normalizeObservation(vehicle({ Timestamp: '2026-10-11T11:59:50Z' }), NOW + 10000);
            assert.equal(await store.publish([updated]), 1);
            assert.equal(await store.backlog(), 2);
        });
        await reset();

        await t.test('journeys archive separately; older source positions cannot regress latest vehicle', async () => {
            const store = new ObservationStore(redis);
            await store.initialize();
            const current = normalizeObservation(vehicle(), NOW);
            const old = normalizeObservation(vehicle({ ID: 'old-object', JourneyIdentifier: 'old-journey',
                Timestamp: '2026-10-11T11:58:00Z', Latitude: 48 }), NOW + 1000);
            assert.equal(await store.publish([current, old]), 2);
            assert.equal(JSON.parse(await redis.get(KEYS.vehicle(current.vehicleKey))).id, current.payload.id);
            assert.equal(JSON.parse(await redis.get(KEYS.object(old.entityKey))).journeyId, 'old-journey');
            const regressive = normalizeObservation(vehicle({ Timestamp: '2026-10-11T11:57:00Z', Latitude: 47 }), NOW + 2000);
            assert.equal(await store.publish([regressive]), 1);
            assert.equal(JSON.parse(await redis.get(KEYS.object(current.entityKey))).latitude, 49.44);
            assert.equal(JSON.parse(await redis.get(KEYS.vehicle(current.vehicleKey))).latitude, 49.44);
            assert.equal(await store.backlog(), 3);
        });
        await reset();

        await t.test('operators with the same alphanumeric vehicle ID remain distinct', async () => {
            const store = new ObservationStore(redis);
            await store.initialize();
            const van = normalizeObservation(vehicle({ VehicleIdentifier: 'BUS-A' }), NOW);
            const ovf = normalizeObservation(vehicle({ VehicleIdentifier: 'BUS-A', Operator: 'OVF' }), NOW);
            await store.publish([van, ovf]);
            assert.equal(JSON.parse(await redis.get(KEYS.vehicle(van.vehicleKey))).operator, 'VAN');
            assert.equal(JSON.parse(await redis.get(KEYS.vehicle(ovf.vehicleKey))).operator, 'OVF');
            assert.equal(await redis.zcard(KEYS.geo), 2);
        });
        await reset();

        await t.test('equal source timestamps consistently select one journey independent of poll order', async () => {
            const store = new ObservationStore(redis);
            await store.initialize();
            const a = normalizeObservation(vehicle(), NOW);
            const b = normalizeObservation(vehicle({ ID: 'other-object', JourneyIdentifier: 'other-journey' }), NOW);
            const sorted = [a, b].sort((one, two) => one.entityKey.localeCompare(two.entityKey));
            await store.publish(sorted);
            assert.equal(JSON.parse(await redis.get(KEYS.vehicle(a.vehicleKey))).entityKey, sorted[0].entityKey);
            await store.publish([...sorted].reverse());
            assert.equal(JSON.parse(await redis.get(KEYS.vehicle(a.vehicleKey))).entityKey, sorted[0].entityKey);
        });
        await reset();

        await t.test('missing or invalid positions/timestamps are archived but kept out of GEO', async () => {
            const store = new ObservationStore(redis);
            await store.initialize();
            const missing = normalizeObservation(vehicle({ ID: 'missing', VehicleIdentifier: 'MISSING', Timestamp: null }), NOW);
            const invalid = normalizeObservation(vehicle({ ID: 'invalid', VehicleIdentifier: 'INVALID', Latitude: null }), NOW);
            const stale = normalizeObservation(vehicle({ ID: 'stale', VehicleIdentifier: 'STALE', Timestamp: '2026-10-11T11:50:00Z' }), NOW);
            await store.publish([missing, invalid, stale]);
            assert.equal(await store.backlog(), 3);
            assert.equal(await redis.zcard(KEYS.geo), 0);
            assert.notEqual(await redis.get(KEYS.vehicle(stale.vehicleKey)), null);
            const fresh = normalizeObservation(vehicle(), NOW);
            await store.publish([fresh]);
            await store.publish([normalizeObservation(vehicle({ Timestamp: '2026-10-11T11:59:50Z', Latitude: null }), NOW)]);
            assert.equal(await redis.zcard(KEYS.geo), 0, 'new invalid position removes previous GEO member');
        });
        await reset();

        await t.test('source freshness expires independently of JSON TTL; hash/queue survive cache expiry', async () => {
            const store = new ObservationStore(redis, { ttlSeconds: 1 });
            await store.initialize();
            const now = Date.now();
            const raw = vehicle({ Timestamp: new Date(now - 100).toISOString() });
            const observation = normalizeObservation(raw, now);
            await store.publish([observation]);
            assert.equal(await redis.zscore(KEYS.expiry, observation.vehicleKey), String(now + 900));
            await store.cleanup(now + 901);
            assert.equal(await redis.zcard(KEYS.geo), 0);
            assert.notEqual(await redis.get(KEYS.vehicle(observation.vehicleKey)), null);
            await sleep(1100);
            assert.equal(await redis.get(KEYS.vehicle(observation.vehicleKey)), null);
            assert.equal(await redis.get(KEYS.object(observation.entityKey)), null);
            assert.equal(await store.backlog(), 1);
            assert.equal(await store.publish([normalizeObservation(raw, Date.now())]), 0);
            assert.equal(await redis.zcard(KEYS.geo), 0, 'repeated old position must not reenter GEO');
        });
        await reset();

        await t.test('restart recovers pending before unread; failures retain fixed observation ID until acknowledgement', async () => {
            const store = new ObservationStore(redis, { batchSize: 1 });
            await store.initialize();
            await store.publish([normalizeObservation(vehicle(), NOW), normalizeObservation(vehicle({ ID: 'next' }), NOW)]);
            const pending = await store.readBatch();
            assert.equal(pending.length, 1);
            const restarted = new ObservationStore(redis, { batchSize: 1 });
            await restarted.initialize();
            assert.deepEqual(await restarted.readBatch(), pending);
            await assert.rejects(archiveBatch(restarted, { insert: async () => { throw new Error('ClickHouse outage'); } }), /outage/);
            assert.equal(await restarted.backlog(), 2);
            let written;
            await archiveBatch(restarted, { insert: async ({ values }) => { written = values; } });
            assert.deepEqual(written, pending.map(({ row }) => row));
            assert.equal(await restarted.backlog(), 1);
            assert.equal((await redis.xpending(KEYS.stream, GROUP))[0], 0);
            const unread = await restarted.readBatch();
            assert.notEqual(unread[0].id, pending[0].id);
            await restarted.acknowledge(unread.map(({ id }) => id));
            assert.equal(await restarted.backlog(), 0);
        });
    });
});

test('real ClickHouse migration and Redis-to-ClickHouse retry deduplication', {
    skip: process.env.LIVEGPS_INTEGRATION !== '1', timeout: 60000,
}, async () => {
    const database = `livegps_test_${process.pid}_${Date.now()}`;
    const admin = createClickHouse(config);
    let created = false;
    let ch;
    try {
        await admin.command({ query: `CREATE DATABASE ${database}` });
        created = true;
        ch = createClickHouse({ ...config, CH_DATABASE: database });
        await migration.up(ch);
        await migration.up(ch); // idempotent migration
        await withLocalRedis(async (redis) => {
            const store = new ObservationStore(redis);
            await store.initialize();
            const rows = [normalizeObservation(vehicle(), NOW), normalizeObservation({}, NOW)];
            await store.publish(rows);
            const pending = await store.readBatch();
            await ch.insert({ table: 'livegps_observations', values: pending.map(({ row }) => row), format: 'JSONEachRow' });
            // Simulate a crash after the ClickHouse insert, before Redis acknowledgement.
            const restarted = new ObservationStore(redis);
            await restarted.initialize();
            assert.equal(await archiveBatch(restarted, ch), 2);
            assert.equal(await restarted.backlog(), 0);
            const result = await ch.query({ query: 'SELECT * FROM livegps_observations FINAL', format: 'JSONEachRow' });
            const stored = await result.json();
            assert.equal(stored.length, 2);
            const original = stored.find((row) => row.object_id === 'vmi-object-a');
            const anonymous = stored.find((row) => row.anonymous === 1);
            assert.equal(original.vehicle_id, '00625');
            assert.equal(original.delay_seconds, -82);
            assert.equal(original.timestamp, '2026-10-11 11:59:40.000');
            assert.equal(original.observation_id, rows[0].row.observation_id);
            assert.equal(JSON.parse(original.raw_json).X, vehicle().X);
            assert.equal(anonymous.latitude, null);
            assert.equal(anonymous.timestamp, null);
            const ddl = await ch.query({ query: 'SHOW CREATE TABLE livegps_observations', format: 'JSONEachRow' });
            assert.ok(!(await ddl.json())[0].statement.includes(' TTL '));
        });
    } finally {
        await ch?.close();
        if (created) await admin.command({ query: `DROP DATABASE ${database} SYNC` });
        await admin.close();
    }
});
