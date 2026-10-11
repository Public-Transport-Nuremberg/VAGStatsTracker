const { createClient } = require('@clickhouse/client');
const { toStorageRows } = require('./storage');

function createClickHouse(config) {
    return createClient({
        url: `http://${config.CH_HOST}:${config.CH_PORT}`,
        username: config.CH_USER, password: config.CH_PASSWORD, database: config.CH_DATABASE,
        request_timeout: 30000,
    });
}

async function archiveBatch(store, clickhouse) {
    const batch = await store.readBatch();
    if (!batch.length) return 0;
    // Never regenerate fetched_at or observation_id on retries: ReplacingMergeTree
    // must see the identical partition and sorting key after an ambiguous failure.
    const rows = batch.map(({ row }) => toStorageRows(row));
    const fahrten = new Map(rows.map(({ fahrt }) => [fahrt.gps_fahrt_id, fahrt]));
    // Metadata must exist before its observations. Any failed insert (including
    // a missing migration) leaves the Redis batch pending for an identical retry.
    await clickhouse.insert({ table: 'gps_fahrten', values: [...fahrten.values()], format: 'JSONEachRow' });
    await clickhouse.insert({ table: 'gps_observations', values: rows.map(({ observation }) => observation), format: 'JSONEachRow' });
    await store.acknowledge(batch.map(({ id }) => id));
    return batch.length;
}

module.exports = { createClickHouse, archiveBatch };
