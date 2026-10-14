const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readGpsVehicleValues } = require('../lib/live_gps');
const { summarizeGpsVehicles } = require('../lib/live_gps/metrics');
const config = require('../config/metrics');

const NOW = Date.parse('2026-10-14T10:00:00Z');

const createGpsRedis = () => {
    const entries = new Map();
    const add = (key, extra = {}, expiresAt = NOW + 60000) => {
        entries.set(key, { expiresAt, value: JSON.stringify({
            source: 'vmi', vehicleKey: key, entityKey: `entity-${key}`,
            vehicleId: key, operator: 'VAG', motCode: 5, line: 'E5',
            latitude: 49.45, longitude: 11.08,
            timestamp: new Date(NOW - 10000).toISOString(), ...extra,
        }) });
    };
    const redis = {
        zrangebyscore: async (key, minimum, maximum, scores) => {
            assert.equal(key, 'LIVEGPS:VMI:GEO_EXPIRY');
            assert.equal(maximum, '+inf');
            assert.equal(scores, 'WITHSCORES');
            return [...entries].filter(([, entry]) => entry.expiresAt > Number(minimum.slice(1)))
                .flatMap(([member, entry]) => [member, String(entry.expiresAt)]);
        },
        mget: async (keys) => keys.map((key) => entries.get(key.replace('LIVEGPS:VMI:VEHICLE:', ''))?.value ?? null),
    };
    return { redis, add, entries };
};

test('counts real GPS map markers, distinguishing vehicle identities from fallback objects', () => {
    const snapshot = summarizeGpsVehicles({
        'gps:bus-vag': { PositionSource: 'gps', Produkt: 'Bus', VehicleIdentifier: '001', Operator: 'VAG' },
        'gps:bus-ovf': { PositionSource: 'gps', Produkt: 'Bus', VehicleIdentifier: '001', Operator: 'OVF' },
        'gps:tram': { PositionSource: 'gps', Produkt: 'Tram', VehicleIdentifier: null },
        'gps:other': { PositionSource: 'gps', Produkt: 'unknown"label', VehicleIdentifier: '' },
        'puls:trip': { Produkt: 'Bus', EstimatedGPS: { Latitude: 49, Longitude: 11 } },
        __meta: { source: 'gps' },
    });
    assert.deepEqual(snapshot.totals, { Vehicles: 4, IdentifiedVehicles: 2, UnidentifiedVehicles: 2 });
    assert.deepEqual(snapshot.byProduct.Bus, { Vehicles: 2, IdentifiedVehicles: 2, UnidentifiedVehicles: 0 });
    assert.equal(snapshot.byProduct.Tram.UnidentifiedVehicles, 1);
    assert.equal(snapshot.byProduct.Unknown.UnidentifiedVehicles, 1);
    assert.equal(snapshot.byProduct.UBahn.Vehicles, 0);
    assert.equal(snapshot.totals.Vehicles,
        Object.values(snapshot.byProduct).reduce((total, counts) => total + counts.Vehicles, 0));
});

test('uses the GPS map reader to exclude expired, malformed, missing and invalid observations', async () => {
    const { redis, add, entries } = createGpsRedis();
    add('bus-vag', { vehicleId: '001' });
    add('bus-ovf', { vehicleId: '001', operator: 'OVF' });
    add('tram', { motCode: 4, vehicleId: null });
    add('ubahn', { motCode: 2 });
    add('sbahn', { motCode: 1 });
    add('zug', { motCode: 0 });
    add('expired', {}, NOW);
    add('future', { timestamp: new Date(NOW + 1000).toISOString() });
    add('no-time', { timestamp: null });
    add('no-position', { latitude: null });
    add('bad-position', { longitude: 181 });
    add('wrong-source', { source: 'puls' });
    add('wrong-key', { vehicleKey: 'other' });
    add('inconsistent-expiry', { timestamp: new Date(NOW - 10000).toISOString() }, NOW - 20000);
    entries.set('malformed', { value: '{bad json', expiresAt: NOW + 60000 });
    entries.set('missing', { value: null, expiresAt: NOW + 60000 });

    const vehicles = await readGpsVehicleValues(redis, {}, NOW);
    const snapshot = summarizeGpsVehicles(vehicles);
    assert.equal(snapshot.totals.Vehicles, 6);
    assert.equal(snapshot.totals.IdentifiedVehicles, 5);
    assert.equal(snapshot.totals.UnidentifiedVehicles, 1);
    assert.equal(snapshot.byProduct.Bus.Vehicles, 2);
    for (const product of ['Tram', 'UBahn', 'SBahn', 'Zug']) assert.equal(snapshot.byProduct[product].Vehicles, 1);
    assert.equal(snapshot.byProduct.Unknown.Vehicles, 0);
    assert.deepEqual(summarizeGpsVehicles(await readGpsVehicleValues(redis, {}, NOW + 60000)).totals,
        { Vehicles: 0, IdentifiedVehicles: 0, UnidentifiedVehicles: 0 });
});

const loadMetricsEndpoint = (getGpsVehicleValues) => {
    let handler;
    const dependencies = {
        'ultimate-express': { Router: class {
            get(route, middleware, callback) { handler = callback; }
        } },
        '@middleware/limiter': { limiter: () => () => {} },
        '@config/metrics': config,
        '@lib/live_map/metrics': { getLiveMapMetrics: () => ({ totals: {}, byProduct: {} }) },
        '@lib/live_gps/metrics': { summarizeGpsVehicles },
        '@lib/redis': {
            findAllMetricKeys: async () => [], findAllMetricListKeys: async () => [],
            findAllErrorListKeys: async () => [], findAllTripKeys: async () => [],
            getValuesFromKeys: async () => ({}),
            calculateRateAndAverageResponseTimeAndReset: async () => ({}),
            countStatusCodesByKey: async () => ({}), monitorRedis: async () => ({}),
            getGpsVehicleValues,
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/metrics.js'), 'utf8'), {
        module: { exports: {} }, require: (name) => dependencies[name], setInterval: () => {},
    });
    return handler;
};

const response = () => ({
    set(key, value) { this.contentType = value; return this; },
    status(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; return this; },
});

test('endpoint counts the global GPS dataset on every scrape and resets expired products to zero', async () => {
    const { redis, add } = createGpsRedis();
    add('bus-vag');
    add('tram', { motCode: 4, vehicleId: null });
    let now = NOW;
    let reads = 0;
    const handler = loadMetricsEndpoint(async (query) => {
        assert.equal(Object.keys(query).length, 0, 'metrics have no viewport or line filters');
        reads++;
        return readGpsVehicleValues(redis, query, now);
    });
    await new Promise(setImmediate);
    const res = response();
    await handler({}, res);
    assert.equal(res.contentType, 'text/plain; version=0.0.4; charset=utf-8');
    assert.match(res.body, /^LiveGPS_Vehicles 2$/m);
    assert.match(res.body, /^LiveGPS_VehiclesByProduct\{product="Bus"\} 1$/m);
    assert.match(res.body, /^LiveGPS_VehiclesByProduct\{product="Tram"\} 1$/m);
    assert.match(res.body, /^LiveGPS_VehiclesByProduct\{product="UBahn"\} 0$/m);
    assert.match(res.body, /^LiveGPS_IdentifiedVehicles 1$/m);
    assert.match(res.body, /^LiveGPS_UnidentifiedVehicles 1$/m);
    for (const metric of Object.values(config.LiveGPS)) {
        for (const name of [metric.Metric, metric.ProductMetric]) {
            assert.equal(res.body.split('\n').filter((line) => line.startsWith(`# HELP ${name} `)).length, 1);
            assert.equal(res.body.split('\n').filter((line) => line === `# TYPE ${name} gauge`).length, 1);
        }
    }
    now += 60000;
    await handler({}, res);
    assert.equal(reads, 2, 'reads refresh without waiting for the background PULS metrics scan');
    assert.match(res.body, /^LiveGPS_Vehicles 0$/m);
    assert.match(res.body, /^LiveGPS_VehiclesByProduct\{product="Bus"\} 0$/m);
    assert.match(res.body, /^LiveGPS_IdentifiedVehicles 0$/m);
    assert.match(res.body, /^LiveGPS_UnidentifiedVehicles 0$/m);
});

test('endpoint propagates GPS read failures instead of reporting a false zero count', async () => {
    let fail = true;
    const handler = loadMetricsEndpoint(async () => {
        if (fail) throw new Error('Redis unavailable');
        return {};
    });
    await new Promise(setImmediate);
    const res = response();
    await assert.rejects(handler({}, res), /Redis unavailable/);
    assert.equal(res.body, undefined);
    fail = false;
    await handler({}, res);
    assert.match(res.body, /^LiveGPS_Vehicles 0$/m);
});
