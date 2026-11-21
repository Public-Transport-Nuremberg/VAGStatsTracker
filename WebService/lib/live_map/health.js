const TRACKING_MAX_AGE_MS = 10 * 60 * 1000;
const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function evaluateLiveMapHealth({ scanner, api = [], trackingAt, activePositions }, now = Date.now()) {
    const parts = clock.formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === 'hour').value);
    const minute = Number(parts.find((part) => part.type === 'minute').value);
    const servicePause = hour >= 1 && hour < 4;
    // Allow the processor one normal freshness window after service resumes.
    const startupGrace = hour === 4 && minute < 10;
    const reasons = [];
    const scannerValid = Array.isArray(scanner?.products) && scanner.products.length > 0
        && Number.isFinite(scanner.intervalMs) && scanner.intervalMs > 0;
    const apiMaxAgeMs = scannerValid ? Math.max(180000, scanner.intervalMs * 2 + 60000) : 180000;
    const fresh = (timestamp, limit) => Number.isFinite(timestamp) && timestamp > 0
        && timestamp <= now && now - timestamp <= limit;
    if (!scannerValid) reasons.push('scanner_state_missing');
    const products = scannerValid ? scanner.products.map((product, index) => {
        const state = api[index];
        const healthy = fresh(state?.successAt, apiMaxAgeMs)
            && Number.isInteger(state?.trips) && state.trips >= 0;
        if (!healthy) reasons.push(`api_stale:${product}`);
        return { product, healthy, lastSuccessAt: state?.successAt || null, trips: state?.trips ?? null };
    }) : [];
    if (!servicePause && !startupGrace) {
        if (!products.some((product) => product.healthy && product.trips > 0)) reasons.push('no_trips_during_service');
        if (!fresh(trackingAt, TRACKING_MAX_AGE_MS)) reasons.push('tracking_stale');
        if (!(activePositions > 0)) reasons.push('no_live_positions');
    }
    return {
        status: reasons.length ? 'unhealthy' : 'healthy', source: 'puls',
        checkedAt: new Date(now).toISOString(), timeZone: 'Europe/Berlin', servicePause, startupGrace,
        reasons, products, trackingAt: trackingAt || null, activePositions,
        apiMaxAgeMs, trackingMaxAgeMs: TRACKING_MAX_AGE_MS,
    };
}

const parse = (value) => {
    try { return JSON.parse(value); } catch { return null; }
};

async function readLiveMapHealth(redis) {
    const scanner = parse(await redis.get('HEALTH:LIVEMAP:SCANNER'));
    const products = Array.isArray(scanner?.products) ? scanner.products : [];
    const now = Date.now();
    const [apiValues, trackingAt, activePositions] = await Promise.all([
        products.length ? redis.mget(products.map((product) => `HEALTH:LIVEMAP:API:${product.toLowerCase()}`)) : [],
        redis.get('HEALTH:LIVEMAP:TRACKING'),
        redis.zcount('TRIPS_GEO_EXPIRY', `(${now}`, '+inf'),
    ]);
    return evaluateLiveMapHealth({ scanner, api: apiValues.map(parse), trackingAt: Number(trackingAt),
        activePositions: Number(activePositions) });
}

async function sendLiveMapHealth(res, read) {
    res.header('Cache-Control', 'no-store');
    let timer;
    try {
        const health = await Promise.race([
            read(),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 3000); }),
        ]);
        return res.status(health.status === 'healthy' ? 200 : 503).json(health);
    } catch {
        return res.status(503).json({ status: 'unhealthy', source: 'puls', reasons: ['health_read_failed'] });
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { evaluateLiveMapHealth, readLiveMapHealth, sendLiveMapHealth };
