const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { openvgn } = require('oepnv-nuremberg');
const { loadConfig } = require('./envSchema');
const { createLogger } = require('./lib/logger');
const { createRedis, ObservationStore } = require('./lib/redis');
const { createClickHouse, archiveBatch } = require('./lib/clickhouse');
const { collectScan, runLoop, WatchdogError } = require('./lib/collector');

async function main() {
    const config = loadConfig();
    const log = createLogger(config);
    process.log = log;
    const controller = new AbortController();
    const redis = createRedis(config);
    const clickhouse = createClickHouse(config);
    const client = new openvgn();
    const store = new ObservationStore(redis, { ttlSeconds: config.LIVEGPS_CACHE_TTL_SECONDS, batchSize: config.LIVEGPS_BATCH_SIZE });
    let shuttingDown = false;
    const stop = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('Stopping livegps; unconfirmed observations remain in Redis');
        controller.abort();
        // The wrapper cannot cancel a hung getVehicles request. Bound shutdown too.
        setTimeout(() => process.exit(process.exitCode || 0), 5000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    redis.on('error', (error) => log.warn(`Redis: ${error.message}`));
    try {
        await redis.connect();
        await store.initialize();
        log.info(`Collecting all delivered VMI objects (mode=${config.LIVEGPS_FETCH_MODE}); PULS IDs remain separate`);
        let lastBacklogLog = 0;
        const archive = async () => {
            try {
                const count = await archiveBatch(store, clickhouse);
                if (Date.now() - lastBacklogLog >= 30000) {
                    log.info(`ClickHouse archived=${count}; Redis backlog=${await store.backlog()}`);
                    lastBacklogLog = Date.now();
                }
                return count;
            } catch (error) {
                if (Date.now() - lastBacklogLog >= 30000) {
                    const backlog = await store.backlog().catch(() => 'unavailable');
                    log.warn(`ClickHouse archive blocked; Redis backlog=${backlog}`);
                    lastBacklogLog = Date.now();
                }
                throw error;
            }
        };
        const loops = { signal: controller.signal, log };
        await Promise.all([
            runLoop(async () => {
                const result = await collectScan(client, store, config, { signal: controller.signal });
                log.info(`Scan requests=${result.requests}, received=${result.received}, unique=${result.unique}, changes=${result.queued}`);
            }, config.LIVEGPS_SCAN_INTERVAL_MS, { ...loops, label: 'collector', fatal: (error) => error instanceof WatchdogError }),
            runLoop(archive, 1000, { ...loops, label: 'archive' }),
            runLoop(() => store.cleanup(), 1000, { ...loops, label: 'geo cleanup' }),
        ]);
    } catch (error) {
        process.exitCode = 1;
        log.error(error.message);
        error.logged = true;
        stop();
        throw error;
    } finally {
        controller.abort();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        redis.disconnect();
        await clickhouse.close();
    }
}

if (require.main === module) {
    main().catch((error) => { if (!error.logged) console.error(error.message); process.exit(1); });
}

module.exports = { main };
