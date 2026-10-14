// Browser-test fixture: actual application routes/WebSockets/views, isolated data adapters.
// Does not load .env, connect to services, or call a transit API.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const aliases = require('module-alias');
aliases.addAliases({ '@src': path.join(root, 'src'), '@lib': path.join(root, 'lib'),
    '@api': path.join(root, 'api'), '@middleware': path.join(root, 'middleware'), '@config': path.join(root, 'config') });
const mock = (file, exports) => {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
process.log = { debug() {}, error: console.error, warning() {}, warn() {} };
const { readGpsVehicleValues, queryGpsHistory, berlinDate } = require('../../lib/live_gps');
const now = Date.now();
const day = berlinDate(now);
const operator = 'VAN';
const vehicleId = 'BUS-A/01';
const entityKey = 'a'.repeat(64), vehicleKey = 'b'.repeat(64);
const payload = { source: 'vmi', entityKey, vehicleKey, operator, vehicleId,
    journeyId: 'journey-3', dayOfOperation: day, motCode: 5, product: 'BUS', line: 'E5',
    direction: 'Kornburg', currentStop: 'AM-RAN:1', nextStop: 'FINK:1',
    latitude: 49.452, longitude: 11.077, delaySeconds: 82 };
const vehicleCount = Math.max(1, Math.min(10000, Number(process.env.GPS_MAP_FIXTURE_VEHICLES) || 1));
const positions = new Map([[vehicleKey, payload]]);
for (let index = 1; index < vehicleCount; index++) {
    const key = index.toString(16).padStart(64, '0');
    positions.set(key, { ...payload, vehicleKey: key, entityKey: key, vehicleId: `TEST-${index}`,
        latitude: index < 10 ? 49.452 + index * 0.001 : 50 + (index % 100) * 0.001,
        longitude: index < 10 ? 11.077 + index * 0.001 : 8.5 + (index % 100) * 0.001 });
}
const fakeRedis = {
    geosearch: async (...args) => {
        const delay = Number(process.env.GPS_MAP_FIXTURE_QUERY_DELAY_MS) || 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const [, , longitude, latitude, , width, height] = args;
        const halfLatitude = height / 111227 / 2;
        const halfLongitude = width / (111227 * Math.cos(latitude * Math.PI / 180)) / 2;
        return [...positions].filter(([, value]) => Math.abs(value.latitude - latitude) <= halfLatitude
            && Math.abs(value.longitude - longitude) <= halfLongitude).map(([key]) => key);
    },
    pipeline: () => {
        const members = [];
        return { zscore(key, member) { members.push(member); return this; },
            exec: async () => members.map((member) => [null, positions.has(member) ? String(Date.now() + 160000) : null]) };
    },
    zrangebyscore: async () => [...positions.keys()].flatMap((key) => [key, String(Date.now() + 160000)]),
    mget: async (keys) => keys.map((key) => {
        const value = positions.get(key.replace('LIVEGPS:VMI:VEHICLE:', ''));
        return value ? JSON.stringify({ ...value, timestamp: new Date(Math.floor(Date.now() / 10000) * 10000 - 10000).toISOString() }) : null;
    }),
};
const trip = { Fahrzeugnummer: 625, Produkt: 'Bus', Linienname: 'E5', Richtungstext: 'Kornburg',
    VGNKennung: 1, nextVGNKennung: 2, Betriebstag: day,
    AbfahrtszeitIst: new Date(now).toISOString(), AbfahrtszeitSoll: new Date(now - 60000).toISOString(),
    nextAnkunftszeitIst: new Date(now + 120000).toISOString(), nextAnkunftszeitSoll: new Date(now + 60000).toISOString() };
mock(path.join(root, 'lib/redis'), {
    getGpsVehicleValues: (query) => readGpsVehicleValues(fakeRedis, query),
    getIndexedTripValues: async () => ({ 'fixture-puls': trip }),
    getTripValuesInBoundingBox: async () => ({ 'fixture-puls': trip }),
    updateTripLocations: async () => 1,
    findAllMetricKeys: async () => ['METRIC:LiveGPS.RequestDurationMilliseconds', 'METRIC:LiveGPS.LastRequestTimestamp'],
    findAllMetricListKeys: async () => [],
    findAllErrorListKeys: async () => [],
    findAllTripKeys: async () => [],
    getValuesFromKeys: async () => ({
        'LiveGPS.RequestDurationMilliseconds': 125.75,
        'LiveGPS.LastRequestTimestamp': now / 1000,
    }),
    calculateRateAndAverageResponseTimeAndReset: async () => ({}),
    countStatusCodesByKey: async () => ({}),
    monitorRedis: async () => ({}),
});
mock(path.join(root, 'lib/haltestellen_cache'), { StopObjectStore: { get: () => ({
    Latitude: 49.452, Longitude: 11.077, Haltestellenname: 'Fixture-Halt', Produkte: 'Bus',
}) } });
mock(path.join(root, 'lib/api_trace'), { traceVgnClient: (client) => client });
mock(path.join(root, 'lib/live_map/estimated_gps'), {
    calculateTripProgress: () => 0.5, estimateGpsPosition: async () => null,
});
const rows = [0, 1, 2, 3, 4].map((index) => ({
    timestamp: index === 0 ? null : new Date(now - [900000, 840000, 780000, 120000, 60000][index]).toISOString(),
    fetched_at: new Date(now - [900000, 840000, 780000, 120000, 60000][index]).toISOString(),
    latitude: 49.452 + index * 0.002, longitude: 11.077 + index * 0.002,
    delay_seconds: index * 20, line: 'E5', direction: 'Kornburg',
    journey_id: index === 0 ? 'journey-1' : 'journey-2',
    current_stop: 'AM-RAN:1', next_stop: 'FINK:1', mot_code: 5, product: 'BUS',
})).reverse();
const fakeCH = { query: async ({ query_params: params }) => {
    if (params.id === 'error') throw new Error('Fixture ClickHouse outage');
    return { json: async () => params.id === vehicleId || params.id === entityKey ? rows : [] };
} };
mock(path.join(root, 'lib/clickhouse'), {
    live: { getCancelledTripsToday: async () => 0 },
    vehicle: { getGpsHistory: (params) => queryGpsHistory(fakeCH, params), getHistory: async () => [] },
});
mock(path.join(root, 'middleware/limiter'), { limiter: () => (req, res, next) => next() });
const express = require('ultimate-express');
const api = new express.Router();
api.use('/live', require('../../api/live').router);
api.use('/vehicle', require('../../api/vehicle').router);
api.use('/metrics', require('../../api/metrics').router);
mock(path.join(root, 'api'), api);
const ejs = require('ejs');
const renderedViews = new Map();
for (const name of ['livemap', 'vehicleHistoryGPS']) {
    const html = ejs.render(fs.readFileSync(path.join(root, 'views', `${name}.ejs`), 'utf8'), {
        appName: 'GPS fixture', commitId: `test-${fs.statSync(path.join(root, 'public/dist/js/livemap_main.js')).mtimeMs}`,
    });
    renderedViews.set(path.join(root, 'public', `${name}.html`), html);
}
// Serve rendered fixtures in this process without changing generated application files.
const readFileSync = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
    const html = typeof file === 'string' && renderedViews.get(path.resolve(file));
    if (html !== undefined && html !== false) return args[0] ? html : Buffer.from(html);
    return readFileSync(file, ...args);
};
const app = require('../../src/app');
const port = Number(process.env.GPS_MAP_FIXTURE_PORT) || 18761;
app.listen(port, '127.0.0.1', () => console.log(`GPS browser fixture http://127.0.0.1:${port}/livemap; day=${day}`));
process.on('SIGINT', () => process.exit(0));
