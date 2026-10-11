const { createClient } = require('@clickhouse/client');

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
    await clickhouse.insert({
        table: 'livegps_observations', values: batch.map(({ row }) => row), format: 'JSONEachRow',
    });
    await store.acknowledge(batch.map(({ id }) => id));
    return batch.length;
}

module.exports = { createClickHouse, archiveBatch };
