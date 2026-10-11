const test = require('node:test');
const assert = require('node:assert/strict');
const { archiveBatch } = require('../lib/clickhouse');
const { normalizeObservation } = require('../lib/observations');
const { NOW, vehicle } = require('./fixtures');

test('ClickHouse outage retains the pending batch and next attempt uses identical IDs and timestamps', async () => {
    const entries = [{ id: '123-0', row: normalizeObservation(vehicle(), NOW).row }];
    const inserts = [];
    const acknowledgements = [];
    const store = { readBatch: async () => entries, acknowledge: async (ids) => acknowledgements.push(ids) };
    const ch = { insert: async (request) => { inserts.push(request); if (inserts.length === 1) throw new Error('CH offline'); } };
    await assert.rejects(archiveBatch(store, ch), /CH offline/);
    assert.equal(acknowledgements.length, 0);
    assert.equal(await archiveBatch(store, ch), 1);
    assert.deepEqual(inserts[0], inserts[1]);
    assert.deepEqual(acknowledgements, [['123-0']]);
    assert.equal(inserts[1].format, 'JSONEachRow');
    assert.equal(inserts[1].table, 'livegps_observations');
});

test('failed Redis confirmation retries the already-written observation unchanged', async () => {
    const row = normalizeObservation(vehicle(), NOW).row;
    const inserts = [];
    let attempts = 0;
    const store = { readBatch: async () => [{ id: '1-0', row }], acknowledge: async () => { if (!attempts++) throw new Error('Redis disconnected'); } };
    const ch = { insert: async ({ values }) => inserts.push(values) };
    await assert.rejects(archiveBatch(store, ch), /Redis disconnected/);
    assert.equal(await archiveBatch(store, ch), 1);
    assert.deepEqual(inserts[0], inserts[1]);
});

test('empty stream does not send a ClickHouse insert or acknowledgement', async () => {
    assert.equal(await archiveBatch({ readBatch: async () => [], acknowledge: () => assert.fail() }, { insert: () => assert.fail() }), 0);
});
