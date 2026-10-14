const test = require('node:test');
const assert = require('node:assert/strict');
const { ObservationStore } = require('../lib/redis');

test('stores last GPS request duration and timestamp atomically for the WebService metrics reader', async () => {
    const values = new Map();
    let transactions = 0;
    const redis = { multi: () => {
        const writes = [];
        return {
            set(key, value) { writes.push([key, value]); return this; },
            async exec() {
                transactions++;
                for (const [key, value] of writes) values.set(key, String(value));
                return writes.map(() => [null, 'OK']);
            },
        };
    } };
    const store = new ObservationStore(redis);
    await store.recordRequestDuration(125.75, 1234567);
    assert.deepEqual(Object.fromEntries(values), {
        'METRIC:LiveGPS.RequestDurationMilliseconds': '125.75',
        'METRIC:LiveGPS.LastRequestTimestamp': '1234.567',
    });
    await store.recordRequestDuration(50, 1235567);
    assert.equal(values.get('METRIC:LiveGPS.RequestDurationMilliseconds'), '50');
    assert.equal(values.get('METRIC:LiveGPS.LastRequestTimestamp'), '1235.567');
    assert.equal(transactions, 2);
    assert.equal(values.size, 2, 'samples overwrite the previous measurement without growing a list');
});

test('reports Redis transaction errors to the collector monitoring error handler', async () => {
    const redisError = new Error('Redis write failed');
    const redis = { multi: () => ({
        set() { return this; },
        exec: async () => [[redisError], [null, 'OK']],
    }) };
    await assert.rejects(new ObservationStore(redis).recordRequestDuration(1, 1000),
        (error) => error === redisError);
});
