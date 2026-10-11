const test = require('node:test');
const assert = require('node:assert/strict');
const { archiveBatch } = require('../lib/clickhouse');
const { normalizeObservation } = require('../lib/observations');
const { toStorageRows } = require('../lib/storage');
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
    assert.equal(inserts[1].table, 'gps_fahrten');
    assert.equal(inserts[2].table, 'gps_observations');
    assert.deepEqual(inserts[2].values, [toStorageRows(entries[0].row).observation]);
});

test('failed Redis confirmation retries the already-written observation unchanged', async () => {
    const row = normalizeObservation(vehicle(), NOW).row;
    const inserts = [];
    let attempts = 0;
    const store = { readBatch: async () => [{ id: '1-0', row }], acknowledge: async () => { if (!attempts++) throw new Error('Redis disconnected'); } };
    const ch = { insert: async ({ values }) => inserts.push(values) };
    await assert.rejects(archiveBatch(store, ch), /Redis disconnected/);
    assert.equal(await archiveBatch(store, ch), 1);
    assert.deepEqual(inserts[0], inserts[2]);
    assert.deepEqual(inserts[1], inserts[3]);
});

test('partial observation insert failure retries metadata and observations before acknowledging', async () => {
    const first = normalizeObservation(vehicle(), NOW).row;
    const second = normalizeObservation(vehicle({ Timestamp: '2026-10-11T12:00:00Z' }), NOW + 10000).row;
    const entries = [{ id: '1-0', row: first }, { id: '2-0', row: second }];
    const events = [];
    let fail = true;
    const store = { readBatch: async () => entries, acknowledge: async (ids) => events.push({ ack: ids }) };
    const ch = { insert: async (request) => {
        events.push(request);
        if (request.table === 'gps_observations' && fail) { fail = false; throw new Error('ambiguous insert'); }
    } };
    await assert.rejects(archiveBatch(store, ch), /ambiguous insert/);
    assert.deepEqual(events.map(({ table }) => table), ['gps_fahrten', 'gps_observations']);
    assert.equal(events[0].values.length, 1, 'one metadata row per unchanged trip in a batch');
    assert.equal(events[1].values.length, 2);
    assert.equal(await archiveBatch(store, ch), 2);
    assert.deepEqual(events[0], events[2]);
    assert.deepEqual(events[1], events[3]);
    assert.deepEqual(events[4], { ack: ['1-0', '2-0'] });
});

test('empty stream does not send a ClickHouse insert or acknowledgement', async () => {
    assert.equal(await archiveBatch({ readBatch: async () => [], acknowledge: () => assert.fail() }, { insert: () => assert.fail() }), 0);
});
