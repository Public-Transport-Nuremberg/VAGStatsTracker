const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { summarizeLiveMapPositions } = require('../lib/live_map/metrics');

const loadModule = (relativePath, dependencies = {}, globals = {}) => {
    const filename = path.resolve(__dirname, '..', relativePath);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        exports: module.exports,
        require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
        process: { env: {} },
        Date,
        ...globals,
    }, { filename });
    return module.exports;
};

const validLocation = (product, estimatedGps = true) => ({
    product, estimatedGps, latitude: 49.45, longitude: 11.08,
});

test('counts GPS, fallback and missing positions by product and in total', () => {
    const snapshot = summarizeLiveMapPositions([
        validLocation('Bus'),
        validLocation('Bus', false),
        validLocation('Tram'),
        { product: 'UBahn', latitude: undefined, longitude: undefined },
        validLocation('unexpected"product'),
    ], 3, 1234567, 42);

    assert.deepEqual(snapshot.totals, {
        Trips: 5, EstimatedGPSTrips: 3, StopFallbackTrips: 1, MissingPositionTrips: 1,
        PositionsUpdated: 3, LastRefreshTimestamp: 1234.567, RefreshDurationMilliseconds: 42,
    });
    assert.deepEqual(snapshot.byProduct.Bus, {
        Trips: 2, EstimatedGPSTrips: 1, StopFallbackTrips: 1, MissingPositionTrips: 0,
    });
    assert.equal(snapshot.byProduct.UBahn.MissingPositionTrips, 1);
    assert.equal(snapshot.byProduct.Unknown.Trips, 1);
    assert.equal(snapshot.byProduct.SBahn.Trips, 0);
    for (const counts of [snapshot.totals, ...Object.values(snapshot.byProduct)]) {
        assert.equal(counts.Trips,
            counts.EstimatedGPSTrips + counts.StopFallbackTrips + counts.MissingPositionTrips);
    }
});

test('rejects missing, nonnumeric and out-of-range Redis GEO coordinates', () => {
    const invalidCoordinates = [
        [null, 11], [49, null], ['', 11], [49, ''], [undefined, 11],
        [NaN, 11], [Infinity, 11], [86, 11], [-86, 11], [49, 181], [49, -181],
    ];
    const snapshot = summarizeLiveMapPositions([
        ...invalidCoordinates.map(([latitude, longitude]) => ({
            product: 'Bus', estimatedGps: true, latitude, longitude,
        })),
        { product: 'Bus', estimatedGps: true, latitude: '49.45', longitude: '11.08' },
        { product: 'Tram', estimatedGps: false, latitude: 0, longitude: 0 },
    ]);
    assert.equal(snapshot.totals.MissingPositionTrips, invalidCoordinates.length);
    assert.equal(snapshot.totals.EstimatedGPSTrips, 1);
    assert.equal(snapshot.totals.StopFallbackTrips, 1);
});

const createWorker = (redis) => {
    const metrics = loadModule('lib/live_map/metrics.js');
    const worker = loadModule('lib/live_map/index.js', {
        'oepnv-nuremberg': { openvgn: class {} },
        '@lib/haltestellen_cache': {
            StopObjectStore: new Map([[1, { Latitude: 49.45, Longitude: 11.08 }]]),
        },
        '@lib/redis': redis,
        '@lib/clickhouse': { live: {} },
        './estimated_gps': {
            calculateTripProgress: () => 0.5,
            estimateGpsPosition: async (vgn, line, current, next, progress, product) =>
                product === 'Bus' ? { Latitude: 49.46, Longitude: 11.09 } : null,
        },
        './query_schema': { linequerySchema: {} },
        '@lib/api_trace': { traceVgnClient: (client) => client },
        './metrics': metrics,
    });
    return { worker, metrics };
};

test('worker publishes after the GEO write completes and prevents overlapping refreshes', async () => {
    let finishUpdate;
    let startUpdate;
    const updating = new Promise((resolve) => { startUpdate = resolve; });
    const redis = {
        getIndexedTripValues: async () => ({
            1: { Produkt: 'Bus', VGNKennung: 1 },
            2: { Produkt: 'Tram', VGNKennung: 1 },
            3: { Produkt: 'RBahn', VGNKennung: 999 },
        }),
        updateTripLocations: (locations) => {
            assert.equal(locations.length, 3);
            startUpdate();
            return new Promise((resolve) => { finishUpdate = resolve; });
        },
    };
    const { worker, metrics } = createWorker(redis);
    const refresh = worker.refreshLiveTripLocations();
    await updating;
    assert.equal(metrics.getLiveMapMetrics().totals.LastRefreshTimestamp, 0);
    assert.equal(await worker.refreshLiveTripLocations(), 0);
    finishUpdate(2);
    assert.equal(await refresh, 2);
    const snapshot = metrics.getLiveMapMetrics();
    assert.equal(snapshot.totals.Trips, 3);
    assert.equal(snapshot.totals.PositionsUpdated, 2);
    assert.equal(snapshot.byProduct.Bus.EstimatedGPSTrips, 1);
    assert.equal(snapshot.byProduct.Tram.StopFallbackTrips, 1);
    assert.equal(snapshot.byProduct.RBahn.MissingPositionTrips, 1);
    assert.ok(snapshot.totals.LastRefreshTimestamp > 0);
    assert.ok(snapshot.totals.RefreshDurationMilliseconds >= 0);
});

test('failed refresh retains the last snapshot; a subsequent empty refresh clears counts', async () => {
    let fail = false;
    let trips = { 1: { Produkt: 'Bus', VGNKennung: 1 } };
    const { worker, metrics } = createWorker({
        getIndexedTripValues: async () => trips,
        updateTripLocations: async (locations) => {
            if (fail) throw new Error('Redis unavailable');
            return locations.length;
        },
    });
    await worker.refreshLiveTripLocations();
    const successfulSnapshot = metrics.getLiveMapMetrics();
    fail = true;
    await assert.rejects(worker.refreshLiveTripLocations(), /Redis unavailable/);
    assert.equal(metrics.getLiveMapMetrics(), successfulSnapshot);
    fail = false;
    trips = {};
    await worker.refreshLiveTripLocations();
    const emptySnapshot = metrics.getLiveMapMetrics();
    assert.equal(emptySnapshot.totals.Trips, 0);
    assert.equal(emptySnapshot.totals.PositionsUpdated, 0);
    assert.equal(emptySnapshot.byProduct.Bus.EstimatedGPSTrips, 0);
    assert.ok(emptySnapshot.totals.LastRefreshTimestamp > 0);
});

test('metrics endpoint emits valid gauges and product labels alongside existing metrics', async () => {
    let handler;
    const liveMetrics = loadModule('lib/live_map/metrics.js');
    const config = require('../config/metrics');
    loadModule('api/metrics.js', {
        'ultimate-express': { Router: class {
            get(route, middleware, callback) { handler = callback; }
        } },
        '@middleware/limiter': { limiter: () => () => {} },
        '@config/metrics': config,
        '@lib/live_map/metrics': liveMetrics,
        '@lib/live_gps/metrics': require('../lib/live_gps/metrics'),
        '@lib/redis': {
            findAllMetricKeys: async () => ['METRIC:TotalTripsActive.Bus'],
            findAllMetricListKeys: async () => [],
            findAllErrorListKeys: async () => [],
            findAllTripKeys: async () => ['TRIP:1'],
            getValuesFromKeys: async () => ({ 'TotalTripsActive.Bus': 7 }),
            calculateRateAndAverageResponseTimeAndReset: async () => ({}),
            countStatusCodesByKey: async () => ({}),
            monitorRedis: async () => ({}),
            getGpsVehicleValues: async () => ({}),
        },
    }, { setInterval: () => {} });
    let body;
    let status;
    let contentType;
    const response = {
        status(value) { status = value; return this; },
        set(key, value) { assert.equal(key, 'Content-Type'); contentType = value; return this; },
        send(value) { body = value; },
    };
    await handler({}, response);
    assert.equal(status, 503);
    await new Promise(setImmediate);
    liveMetrics.recordLiveMapPositions([validLocation('Bus'), validLocation('Tram', false)], 2, 10000, 5);
    await handler({}, response);
    assert.equal(contentType, 'text/plain; version=0.0.4; charset=utf-8');
    assert.match(body, /^TotalTripsActive_Bus 7$/m);
    assert.match(body, /^LiveMap_Trips 2$/m);
    assert.match(body, /^LiveMap_EstimatedGPSTripsByProduct\{product="Bus"\} 1$/m);
    assert.match(body, /^LiveMap_StopFallbackTripsByProduct\{product="Tram"\} 1$/m);
    assert.match(body, /^LiveMap_TripsByProduct\{product="UBahn"\} 0$/m);
    assert.match(body, /^LiveMap_LastRefreshTimestamp 10$/m);
    const samples = body.split('\n').filter((line) => !line.startsWith('#'));
    assert.equal(new Set(samples.map((line) => line.split(' ')[0])).size, samples.length);
    for (const metric of Object.values(config.LiveMap)) {
        for (const name of [metric.Metric, metric.ProductMetric].filter(Boolean)) {
            assert.equal(body.split('\n').filter((line) => line.startsWith(`# HELP ${name} `)).length, 1);
            assert.equal(body.split('\n').filter((line) => line === `# TYPE ${name} gauge`).length, 1);
        }
    }
    liveMetrics.recordLiveMapPositions([], 0, 20000, 1);
    await handler({}, response);
    assert.match(body, /^LiveMap_Trips 0$/m);
    assert.match(body, /^LiveMap_EstimatedGPSTripsByProduct\{product="Bus"\} 0$/m);
});
