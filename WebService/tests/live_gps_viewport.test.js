const test = require('node:test');
const assert = require('node:assert/strict');
const { readGpsVehicleValues } = require('../lib/live_gps');
test('viewport excludes expired candidates and fetches only nearby snapshots', async () => {
    const now = Date.now();
    const candidates = ['nearby', 'expired', 'missing-expiry', 'edge'];
    const scores = [now + 10000, now - 1, null, now + 10000];
    let geoRequest, readKeys;
    const redis = {
        zrangebyscore: () => { throw new Error('must not read the full active index'); },
        geosearch: async (...args) => { geoRequest = args; return candidates; },
        pipeline: () => ({ zscore() { return this; }, exec: async () => scores.map((score) => [null, score]) }),
        mget: async (keys) => {
            readKeys = keys;
            return ['nearby', 'edge'].map((key) => JSON.stringify({
                source: 'vmi', vehicleKey: key, vehicleId: key, operator: 'VAN', line: 'E5',
                timestamp: new Date(now - 1000).toISOString(), latitude: 49.45,
                longitude: key === 'nearby' ? 11.08 : 11.21,
            }));
        },
    };
    const result = await readGpsVehicleValues(redis, { boundingBox: {
        minLatitude: 49.4, maxLatitude: 49.5, minLongitude: 11, maxLongitude: 11.2,
    } }, now);
    assert.equal(geoRequest[0], 'LIVEGPS:VMI:GEO');
    assert.equal(geoRequest[1], 'FROMLONLAT');
    assert.equal(geoRequest[4], 'BYBOX');
    assert.deepEqual(readKeys, ['LIVEGPS:VMI:VEHICLE:nearby', 'LIVEGPS:VMI:VEHICLE:edge']);
    assert.deepEqual(Object.keys(result), ['gps:nearby'], 'apply precise coordinates after enlarged GEO box');
});
