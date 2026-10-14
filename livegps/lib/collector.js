const { setTimeout: sleep } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { normalizeObservation } = require('./observations');

class WatchdogError extends Error {
    constructor(timeoutMs) {
        super(`VMI request exceeded watchdog timeout of ${timeoutMs} ms; worker restart required`);
        this.name = 'WatchdogError';
    }
}

async function withWatchdog(callback, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(callback),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new WatchdogError(timeoutMs)), timeoutMs); }),
        ]);
    } finally { clearTimeout(timer); }
}

function* createTiles(config) {
    const width = config.LIVEGPS_TILE_SIZE_DEGREES;
    const columns = Math.ceil((config.LIVEGPS_EAST - config.LIVEGPS_WEST) / width);
    const rows = Math.ceil((config.LIVEGPS_NORTH - config.LIVEGPS_SOUTH) / width);
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const west = config.LIVEGPS_WEST + column * width;
            const south = config.LIVEGPS_SOUTH + row * width;
            yield { west, south, east: Math.min(config.LIVEGPS_EAST, config.LIVEGPS_WEST + (column + 1) * width),
                north: Math.min(config.LIVEGPS_NORTH, config.LIVEGPS_SOUTH + (row + 1) * width) };
        }
    }
}

async function collectScan(client, store, config, options = {}) {
    const wait = options.sleep || sleep;
    const now = options.now || Date.now;
    const monotonicNow = options.monotonicNow || (() => performance.now());
    const parameters = config.LIVEGPS_FETCH_MODE === 'tiles' ? createTiles(config) : [{}];
    const seen = new Set();
    let requests = 0;
    let received = 0;
    let queued = 0;
    for (const parameter of parameters) {
        if (options.signal?.aborted) break;
        if (requests) await wait(config.LIVEGPS_TILE_DELAY_MS, undefined, { signal: options.signal });
        let response;
        let fetchedAt;
        const requestStartedAt = monotonicNow();
        try {
            response = await withWatchdog(() => client.getVehicles(parameter), config.WATCHDOG_TIMEOUT * 1000);
        } finally {
            const durationMilliseconds = Math.max(0, monotonicNow() - requestStartedAt);
            fetchedAt = now();
            if (options.recordRequestDuration) {
                try {
                    await options.recordRequestDuration(durationMilliseconds, fetchedAt);
                } catch (error) {
                    // Monitoring must not interrupt collection or mask a fatal watchdog error.
                    options.log?.warn?.(`Failed to record GPS API request duration: ${error.message}`);
                }
            }
        }
        if (!response || response instanceof Error || !Array.isArray(response.Vehicles)) {
            throw new Error(`getVehicles failed${response?.code ? ` (HTTP ${response.code})` : ''}: ${response?.message || 'invalid response shape'}`);
        }
        const observations = response.Vehicles.map((vehicle) => normalizeObservation(vehicle, fetchedAt)).filter((observation) => {
            const key = `${observation.entityKey}:${observation.payloadHash}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        queued += await store.publish(observations);
        received += response.Vehicles.length;
        requests++;
    }
    return { requests, received, unique: seen.size, queued };
}

const backoffMs = (failures) => Math.min(60000, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 6));

async function runLoop(task, intervalMs, { signal, log, label, fatal = () => false, sleep: wait = sleep, now = Date.now }) {
    let failures = 0;
    while (!signal.aborted) {
        const started = now();
        let delay;
        try {
            const result = await task();
            failures = 0;
            // Drain a backlog immediately; an empty queue waits for the next pass.
            delay = label === 'archive' && result > 0 ? 0 : Math.max(0, intervalMs - (now() - started));
        } catch (error) {
            if (signal.aborted) break;
            if (fatal(error)) throw error;
            failures++;
            delay = backoffMs(failures);
            log.warn(`${label} failed; retry in ${delay} ms: ${error.message}`);
        }
        try { await wait(delay, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
    }
}

module.exports = { WatchdogError, withWatchdog, createTiles, collectScan, backoffMs, runLoop };
