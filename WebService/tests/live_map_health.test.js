const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateLiveMapHealth, readLiveMapHealth, sendLiveMapHealth } = require('../lib/live_map/health');

const state = (now, trips = 1) => ({
    scanner: { products: ['UBahn', 'Bus', 'Tram'], intervalMs: 60000 },
    api: [0, 1, 2].map(() => ({ successAt: now - 30000, trips })),
    trackingAt: now - 30000, activePositions: trips,
});
const evaluate = (iso, change = {}) => {
    const now = Date.parse(iso);
    return evaluateLiveMapHealth({ ...state(now), ...change }, now);
};

test('one vehicle is sufficient only with fresh API responses and tracking', () => {
    assert.equal(evaluate('2026-11-21T11:00:00Z').status, 'healthy');
    assert.ok(evaluate('2026-11-21T11:00:00Z', { trackingAt: 1 }).reasons.includes('tracking_stale'));
    assert.ok(evaluate('2026-11-21T11:00:00Z', { activePositions: 0 }).reasons.includes('no_live_positions'));
});

test('night pause accepts empty results but still requires fresh successful API calls', () => {
    for (const iso of ['2026-11-21T00:00:00Z', '2026-11-21T02:59:59Z', '2026-07-21T23:00:00Z']) {
        const now = Date.parse(iso);
        const input = { ...state(now, 0), trackingAt: null };
        assert.equal(evaluateLiveMapHealth(input, now).status, 'healthy');
        input.api[1].successAt = now - 181000;
        assert.ok(evaluateLiveMapHealth(input, now).reasons.includes('api_stale:Bus'));
    }
});

test('service resumes at 04:00 with ten minute grace, including summer time', () => {
    for (const [iso, grace] of [
        ['2026-11-21T03:00:00Z', true], ['2026-11-21T03:09:59Z', true],
        ['2026-11-21T03:10:00Z', false], ['2026-07-21T02:10:00Z', false],
        ['2026-11-20T23:59:59Z', false],
    ]) {
        const now = Date.parse(iso);
        const health = evaluateLiveMapHealth(state(now, 0), now);
        assert.equal(health.startupGrace, grace);
        assert.equal(health.status, grace ? 'healthy' : 'unhealthy');
    }
});

test('missing state, individual product failure, future timestamps and stopped scanner fail', () => {
    const now = Date.parse('2026-11-21T11:00:00Z');
    assert.equal(evaluateLiveMapHealth({}, now).status, 'unhealthy');
    for (const timestamp of [now - 181000, now + 1, null]) {
        const input = state(now);
        input.api[2].successAt = timestamp;
        assert.ok(evaluateLiveMapHealth(input, now).reasons.includes('api_stale:Tram'));
    }
    const input = state(now);
    input.scanner.intervalMs = 300000;
    input.api.forEach((item) => { item.successAt = now - 600000; });
    assert.equal(evaluateLiveMapHealth(input, now).status, 'healthy');
});

test('reader uses shared worker state and non-expired map positions', async () => {
    const now = Date.now();
    const input = state(now);
    const redis = {
        get: async (key) => key.endsWith('SCANNER') ? JSON.stringify(input.scanner) : String(now),
        mget: async (keys) => {
            assert.deepEqual(keys, ['HEALTH:LIVEMAP:API:ubahn', 'HEALTH:LIVEMAP:API:bus', 'HEALTH:LIVEMAP:API:tram']);
            return input.api.map(JSON.stringify);
        },
        zcount: async (key, min, max) => {
            assert.equal(key, 'TRIPS_GEO_EXPIRY');
            assert.match(min, /^\(\d+$/);
            assert.equal(max, '+inf');
            return 1;
        },
    };
    assert.equal((await readLiveMapHealth(redis)).status, 'healthy');
    redis.mget = async () => ['invalid', null, '{}'];
    assert.equal((await readLiveMapHealth(redis)).status, 'unhealthy');
});

test('HTTP health returns 200/503, disables caching and handles Redis failures', async () => {
    const res = {
        header(key, value) { assert.equal(key, 'Cache-Control'); assert.equal(value, 'no-store'); },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
    await sendLiveMapHealth(res, async () => ({ status: 'healthy' }));
    assert.equal(res.statusCode, 200);
    await sendLiveMapHealth(res, async () => ({ status: 'unhealthy' }));
    assert.equal(res.statusCode, 503);
    await sendLiveMapHealth(res, async () => { throw new Error('Redis unavailable'); });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body.reasons, ['health_read_failed']);
});

test('unresponsive Redis produces 503 within a bounded time', { timeout: 5000 }, async () => {
    const res = {
        header() {},
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
    await sendLiveMapHealth(res, () => new Promise(() => {}));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body.reasons, ['health_read_failed']);
});
