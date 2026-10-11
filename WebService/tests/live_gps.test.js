const test = require('node:test');
const assert = require('node:assert/strict');
const {
  operatingDate, berlinDate, historyUrl, gpsHistorySchema,
  readGpsVehicleValues, queryGpsHistory,
} = require('../lib/live_gps');
const { linequerySchema } = require('../lib/live_map/query_schema');

const NOW = Date.parse('2026-10-11T22:30:00Z');
const memberA = 'a'.repeat(64);
const memberB = 'b'.repeat(64);

test('operatingDate strictly accepts ISO and DD.MM.YYYY dates', () => {
  assert.equal(operatingDate('2026-02-28'), '2026-02-28');
  assert.equal(operatingDate('28.02.2026'), '2026-02-28');
  for (const value of ['2026-02-29', '31.02.2026', '2026-2-01', '28/02/2026', '']) assert.equal(operatingDate(value), null);
});

test('berlinDate uses Europe/Berlin around midnight and historyUrl preserves identities', () => {
  assert.equal(berlinDate('2026-10-11T22:30:00Z'), '2026-10-12');
  assert.equal(historyUrl({ vehicleId: '001/A', operator: 'O&V', dayOfOperation: '11.10.2026' }), '/vehicleHistoryGPS/2026-10-11/001%2FA?operator=O%26V');
  assert.equal(historyUrl({ vehicleId: null, entityKey: memberA, fetchedAt: '2026-10-11T23:30:00Z' }), `/vehicleHistoryGPS/2026-10-12/${memberA}?identity=object`);
  assert.equal(historyUrl({ vehicleId: 'x', operator: '', fetchedAt: 'bad' }), null);
});

test('gpsHistorySchema rejects malformed dates and unknown object identities', async () => {
  await assert.rejects(gpsHistorySchema.validateAsync({ at: '11.10.2026', id: 'BUS-01' }));
  await assert.rejects(gpsHistorySchema.validateAsync({ at: '2026-10-11', id: 'not-a-hash', identity: 'object' }));
  await assert.rejects(gpsHistorySchema.validateAsync({ at: '2026-10-11', id: 'x', identity: 'other' }));
  assert.deepEqual(await gpsHistorySchema.validateAsync({ at: '2026-10-11', id: '001', operator: 'VAG' }), { at: '2026-10-11', id: '001', operator: 'VAG', identity: 'vehicle' });
});

function redisFor(entries, values) {
  return {
    geosearch: async () => entries.filter((entry, index) => index % 2 === 0),
    pipeline: () => ({ zscore() { return this; }, exec: async () => entries.filter((entry, index) => index % 2 === 1).map((score) => [null, score]) }),
    zrangebyscore: async (...args) => { redisFor.args = args; return entries; },
    mget: async (keys) => { redisFor.keys = keys; return keys.map((key) => values[entries.indexOf(key.split(':').pop()) / 2]); },
  };
}
const gps = (key, extra = {}) => JSON.stringify({ source: 'vmi', vehicleKey: key, vehicleId: '12', operator: 'VAG', latitude: 49.4, longitude: 11.1, timestamp: '2026-10-11T22:29:00Z', line: '4', motCode: 4, ...extra });

test('readGpsVehicleValues filters stale, malformed, null/future and bounding-box/line entries', async () => {
  const redis = redisFor([memberA, String(NOW + 60000), memberB, String(NOW + 60000), 'missing', String(NOW + 60000)], [
    gps(memberA), '{bad json', null,
  ]);
  const result = await readGpsVehicleValues(redis, { Linie: '4', boundingBox: { minLongitude: 11, maxLongitude: 12, minLatitude: 49, maxLatitude: 50 } }, NOW);
  assert.deepEqual(Object.keys(result), [`gps:${memberA}`]);
  assert.deepEqual(redisFor.keys, [`LIVEGPS:VMI:VEHICLE:${memberA}`, `LIVEGPS:VMI:VEHICLE:${memberB}`, 'LIVEGPS:VMI:VEHICLE:missing']);
  const expired = redisFor([memberA, String(NOW - 1)], [gps(memberA, { timestamp: '2026-10-11T22:00:00Z' })]);
  assert.deepEqual(await readGpsVehicleValues(expired, {}, NOW), {});
  for (const invalid of [
    { timestamp: '2026-10-11T23:00:00Z' }, { timestamp: null }, { timestamp: 'invalid' },
    { latitude: null }, { latitude: 90 }, { latitude: '49.4' }, { longitude: 181 },
    { source: 'puls' }, { vehicleKey: memberB },
  ]) {
    const invalidRedis = redisFor([memberA, String(NOW + 60000)], [gps(memberA, invalid)]);
    assert.deepEqual(await readGpsVehicleValues(invalidRedis, {}, NOW), {}, JSON.stringify(invalid));
  }
  const validRedis = redisFor([memberA, String(NOW + 60000)], [gps(memberA)]);
  assert.deepEqual(await readGpsVehicleValues(validRedis, { Linie: 'U1' }, NOW), {});
  assert.deepEqual(await readGpsVehicleValues(validRedis, { boundingBox: {
    minLongitude: 12, maxLongitude: 13, minLatitude: 49, maxLatitude: 50,
  } }, NOW), {});
});

test('readGpsVehicleValues keeps same vehicle number from distinct operators as separate members', async () => {
  const a = gps(memberA, { operator: 'VAG' });
  const b = gps(memberB, { operator: 'OVF', vehicleKey: memberB });
  const result = await readGpsVehicleValues(redisFor([memberA, '9999999999999', memberB, '9999999999999'], [a, b]), {}, NOW);
  assert.deepEqual(Object.keys(result).sort(), [`gps:${memberA}`, `gps:${memberB}`].sort());
  assert.equal(result[`gps:${memberB}`].Operator, 'OVF');
});

test('line query schema defaults source, normalizes aliases and bounding boxes', async () => {
  assert.equal((await linequerySchema.validateAsync({})).source, 'puls');
  assert.equal((await linequerySchema.validateAsync({ source: 'gps', line: '4, U1'.replace(' ', '') })).Linie, '4,U1');
  assert.deepEqual((await linequerySchema.validateAsync({ pos1: '12,50', pos2: [10, 49] })).boundingBox, { minLongitude: 10, maxLongitude: 12, minLatitude: 49, maxLatitude: 50 });
  await assert.rejects(linequerySchema.validateAsync({ source: 'other' }));
  await assert.rejects(linequerySchema.validateAsync({ pos1: '10,49' }));
});

test('queryGpsHistory uses FINAL, bounded parameters, identity selector and UTC conversion', async () => {
  let request;
  const client = { query: async (value) => { request = value; return { json: async () => [
    { timestamp: '2026-10-11 22:00:00.000', fetched_at: '2026-10-11 22:00:01.000', latitude: 49, longitude: 11 },
    { timestamp: null, fetched_at: '2026-10-11T21:00:00Z', latitude: 49.1, longitude: 11.1 },
  ] }; } };
  const result = await queryGpsHistory(client, { at: '2026-10-11', id: '001/A', operator: 'O&V', identity: 'vehicle' });
  assert.match(request.query, /FROM gps_fahrten FINAL/);
  assert.match(request.query, /FROM gps_observations FINAL/);
  assert.match(request.query, /vehicle_id = \{id:String\} AND ifNull\(operator, ''\) = \{operator:String\}/);
  assert.match(request.query, /LIMIT 100001/);
  assert.deepEqual(request.query_params, { id: '001/A', operator: 'O&V', day: '2026-10-11' });
  assert.equal(result.points[1].timestamp, '2026-10-11T22:00:00.000Z');
  assert.equal(result.points[0].timestamp, null);
  await queryGpsHistory(client, { at: '2026-10-11', id: memberA, identity: 'object' });
  assert.match(request.query, /entity_key = \{id:String\}/);
  assert.doesNotMatch(request.query, /vehicle_id =/);
});
