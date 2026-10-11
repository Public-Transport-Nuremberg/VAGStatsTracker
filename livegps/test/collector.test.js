const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../envSchema');
const { collectScan, createTiles, withWatchdog, WatchdogError, backoffMs, runLoop } = require('../lib/collector');
const { NOW, vehicle } = require('./fixtures');

const config = (overrides = {}) => loadConfig({ CH_HOST: 'localhost', REDIS_HOST: 'localhost', ...overrides });

test('validates ENV and applies all/unfiltered defaults without leaking credentials', () => {
    const defaults = config();
    assert.equal(defaults.LIVEGPS_FETCH_MODE, 'all');
    assert.equal(defaults.LIVEGPS_SCAN_INTERVAL_MS, 10000);
    assert.equal(defaults.LIVEGPS_CACHE_TTL_SECONDS, 180);
    assert.throws(() => config({ LIVEGPS_TILE_SIZE_DEGREES: 0.6 }), /Invalid ENV/);
    assert.throws(() => config({ LIVEGPS_WEST: 14 }), /west must/);
    assert.throws(() => config({ LIVEGPS_FETCH_MODE: 'tiles', LIVEGPS_TILE_SIZE_DEGREES: 0.000001 }), /10000 tiles/);
    assert.throws(() => config({ CH_DATABASE: 'credentials-secret-value; DROP' }), (error) => !error.message.includes('credentials-secret-value'));
    assert.throws(() => loadConfig({}), /CH_HOST/);
});

test('default scan makes exactly one unfiltered call and accepts empty arrays', async () => {
    let calls = 0;
    const client = { getVehicles: async (parameters) => { calls++; assert.deepEqual(parameters, {}); return { Vehicles: [] }; } };
    const result = await collectScan(client, { publish: async (entries) => { assert.deepEqual(entries, []); return 0; } }, config());
    assert.equal(calls, 1);
    assert.deepEqual(result, { requests: 1, received: 0, unique: 0, queued: 0 });
});

test('tiles cover Bavaria fully without exceeding 0.5 degrees', () => {
    const cfg = config();
    const tiles = [...createTiles(cfg)];
    assert.equal(tiles.length, 70);
    assert.equal(Math.min(...tiles.map((tile) => tile.west)), cfg.LIVEGPS_WEST);
    assert.equal(Math.max(...tiles.map((tile) => tile.east)), cfg.LIVEGPS_EAST);
    assert.equal(Math.min(...tiles.map((tile) => tile.south)), cfg.LIVEGPS_SOUTH);
    assert.equal(Math.max(...tiles.map((tile) => tile.north)), cfg.LIVEGPS_NORTH);
    for (const tile of tiles) {
        assert.ok(tile.east > tile.west && tile.east - tile.west <= 0.5 + 1e-10);
        assert.ok(tile.north > tile.south && tile.north - tile.south <= 0.5 + 1e-10);
    }
});

test('tile requests are sequential with configured delays and boundary duplicates are removed', async () => {
    let active = 0;
    let maximum = 0;
    let requests = 0;
    const waits = [];
    const published = [];
    const cfg = config({ LIVEGPS_FETCH_MODE: 'tiles', LIVEGPS_WEST: 10, LIVEGPS_EAST: 11,
        LIVEGPS_SOUTH: 49, LIVEGPS_NORTH: 49.5 });
    const result = await collectScan({ getVehicles: async () => {
        active++; maximum = Math.max(maximum, active); requests++;
        await Promise.resolve(); active--;
        return { Vehicles: [vehicle()] };
    } }, { publish: async (entries) => { published.push(...entries); return entries.length; } }, cfg,
    { now: () => NOW, sleep: async (delay) => waits.push(delay) });
    assert.equal(maximum, 1);
    assert.equal(requests, 2);
    assert.deepEqual(waits, [500]);
    assert.equal(published.length, 1);
    assert.deepEqual(result, { requests: 2, received: 2, unique: 1, queued: 1 });
});

test('HTTP errors returned as values, thrown transport errors and malformed responses are failures', async () => {
    for (const response of [new Error('bad transport'), { code: 503, message: 'Unavailable' }, {}, null, { Vehicles: {} }]) {
        await assert.rejects(collectScan({ getVehicles: async () => response }, { publish: () => assert.fail('must not publish') }, config()), /getVehicles failed/);
    }
    await assert.rejects(collectScan({ getVehicles: async () => { throw new Error('offline'); } }, {}, config()), /offline/);
});

test('watchdog turns a hung request into a fatal restart error', async () => {
    await assert.rejects(withWatchdog(() => new Promise(() => {}), 10), WatchdogError);
    assert.equal(await withWatchdog(() => Promise.resolve(4), 10), 4);
});

test('retry backoff grows to at most 60 seconds; failed scans never overlap', async () => {
    assert.deepEqual([1, 2, 3, 6, 7, 99].map(backoffMs), [1000, 2000, 4000, 32000, 60000, 60000]);
    const controller = new AbortController();
    const waits = [];
    let calls = 0;
    await runLoop(async () => { calls++; if (calls < 4) throw new Error('API offline'); controller.abort(); }, 10000, {
        signal: controller.signal, label: 'collector', log: { warn: () => {} }, now: () => NOW,
        sleep: async (delay) => { waits.push(delay); },
    });
    assert.equal(calls, 4);
    assert.deepEqual(waits.slice(0, 3), [1000, 2000, 4000]);
});

test('watchdog fatal errors leave the retry loop instead of starting another hung call', async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = { getVehicles: () => { calls++; return new Promise(() => {}); } };
    const cfg = { ...config(), WATCHDOG_TIMEOUT: 0.01 };
    await assert.rejects(runLoop(() => collectScan(client, {}, cfg), 1,
        { signal: controller.signal, log: { warn: () => assert.fail() }, label: 'collector', fatal: (error) => error instanceof WatchdogError }), WatchdogError);
    assert.equal(calls, 1);
});
