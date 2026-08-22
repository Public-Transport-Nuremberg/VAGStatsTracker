const Redis = require('ioredis');
const crypto = require('crypto');

const ENABLED_KEY = 'API_TRACE:ENABLED';
const LOG_KEY = 'API_TRACE:LOGS';
const BYTES_KEY = 'API_TRACE:BYTES';
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024 * 1024;

const redisOptions = {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || '127.0.0.1',
    username: process.env.REDIS_USER || 'default',
    password: process.env.REDIS_PASSWORD || 'example',
    db: process.env.REDIS_DB || 0,
};
const redis = new Redis(redisOptions);
let enabledCache = false;
let enabledCacheExpiresAt = 0;
let enabledCheckPromise = null;

const memberValue = (member) => JSON.parse(member.slice(member.indexOf(':') + 1));

const cleanupScript = `
local function memberSize(member)
    local separator = string.find(member, ':')
    if not separator then return 0 end
    return tonumber(string.sub(member, 1, separator - 1)) or 0
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1000)
for _, member in ipairs(expired) do
    redis.call('ZREM', KEYS[1], member)
    redis.call('DECRBY', KEYS[2], memberSize(member))
end
local bytes = tonumber(redis.call('GET', KEYS[2]) or '0')
if bytes < 0 then bytes = 0 redis.call('SET', KEYS[2], 0) end
return {#expired, bytes}
`;

const appendScript = `
local function memberSize(member)
    local separator = string.find(member, ':')
    if not separator then return 0 end
    return tonumber(string.sub(member, 1, separator - 1)) or 0
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[2], 'LIMIT', 0, 1000)
for _, member in ipairs(expired) do
    redis.call('ZREM', KEYS[1], member)
    redis.call('DECRBY', KEYS[2], memberSize(member))
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
local bytes = redis.call('INCRBY', KEYS[2], ARGV[3])
while bytes > tonumber(ARGV[5]) do
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0)
    if #oldest == 0 then bytes = 0 redis.call('SET', KEYS[2], 0) break end
    redis.call('ZREM', KEYS[1], oldest[1])
    bytes = redis.call('DECRBY', KEYS[2], memberSize(oldest[1]))
end
if bytes < 0 then redis.call('SET', KEYS[2], 0) end
return bytes
`;

const safeStringify = (value) => {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, item) => {
        if (typeof item === 'bigint') return item.toString();
        if (item instanceof Error) return { name: item.name, message: item.message, code: item.code, stack: item.stack };
        if (item && typeof item === 'object') {
            if (seen.has(item)) return '[Circular]';
            seen.add(item);
        }
        return item;
    });
};

const cleanup = async () => redis.eval(cleanupScript, 2, LOG_KEY, BYTES_KEY, Date.now() - RETENTION_MS);
const isEnabled = async (force = false) => {
    if (!force && Date.now() < enabledCacheExpiresAt) return enabledCache;
    if (!enabledCheckPromise) {
        enabledCheckPromise = redis.get(ENABLED_KEY)
            .then((value) => {
                enabledCache = value === '1';
                enabledCacheExpiresAt = Date.now() + 1000;
                return enabledCache;
            })
            .finally(() => { enabledCheckPromise = null; });
    }
    return enabledCheckPromise;
};
const setEnabled = async (enabled) => {
    await redis.set(ENABLED_KEY, enabled ? '1' : '0');
    enabledCache = enabled;
    enabledCacheExpiresAt = Date.now() + 1000;
    return getStatus();
};

const getStatus = async () => {
    await cleanup();
    const [enabled, bytes, count] = await Promise.all([
        isEnabled(true),
        redis.get(BYTES_KEY),
        redis.zcard(LOG_KEY),
    ]);
    return {
        enabled,
        bytes: Math.max(0, Number(bytes) || 0),
        maxBytes: MAX_BYTES,
        count,
        retentionHours: 24,
    };
};

const getLogs = async ({ limit = 250, after } = {}) => {
    await cleanup();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
    const members = after === undefined
        ? await redis.zrevrange(LOG_KEY, 0, boundedLimit - 1)
        : await redis.zrangebyscore(LOG_KEY, Number(after), '+inf', 'LIMIT', 0, boundedLimit);
    return members.map(memberValue);
};

const record = async (event) => {
    const timestamp = Date.now();
    const entry = safeStringify({
        id: `${timestamp}-${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date(timestamp).toISOString(),
        ...event,
    });
    const size = Buffer.byteLength(entry, 'utf8');
    await redis.eval(
        appendScript,
        2,
        LOG_KEY,
        BYTES_KEY,
        timestamp,
        timestamp - RETENTION_MS,
        size,
        `${size}:${entry}`,
        MAX_BYTES
    );
};

const traceCall = async (service, operation, args, callback) => {
    let enabled = false;
    try { enabled = await isEnabled(); } catch (error) { process.log?.warn?.(`API trace status check failed: ${error.message}`); }
    if (!enabled) return callback();

    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    await record({ requestId, phase: 'request', service, operation, request: { args } }).catch(() => {});
    try {
        const response = await callback();
        await record({ requestId, phase: 'response', service, operation, durationMs: Date.now() - startedAt, response }).catch(() => {});
        return response;
    } catch (error) {
        await record({ requestId, phase: 'response', service, operation, durationMs: Date.now() - startedAt, error }).catch(() => {});
        throw error;
    }
};

const NETWORK_METHODS = new Set([
    'getTrips', 'getTrip', 'getDepartures', 'getDeparturesbygps', 'getStops',
    'getStopsbygps', 'geoLines', 'reverseGeocode', 'getVagWebpageDisturbances', 'getLocations',
]);

const traceVgnClient = (client, service = 'WebService') => new Proxy(client, {
    get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || !NETWORK_METHODS.has(String(property))) return value;
        return (...args) => traceCall(service, String(property), args, () => value.apply(target, args));
    },
});

const traceFetch = async (service, url, options) => {
    let enabled = false;
    try { enabled = await isEnabled(); } catch {}
    if (!enabled) return fetch(url, options);
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    await record({ requestId, phase: 'request', service, operation: 'fetch', request: { url: String(url), options } }).catch(() => {});
    try {
        const response = await fetch(url, options);
        const body = await response.clone().text();
        await record({
            requestId,
            phase: 'response',
            service,
            operation: 'fetch',
            durationMs: Date.now() - startedAt,
            response: { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body },
        }).catch(() => {});
        return response;
    } catch (error) {
        await record({ requestId, phase: 'response', service, operation: 'fetch', durationMs: Date.now() - startedAt, error }).catch(() => {});
        throw error;
    }
};

const cleanupTimer = setInterval(() => cleanup().catch(() => {}), 60 * 1000);
cleanupTimer.unref();

module.exports = { getLogs, getStatus, setEnabled, traceVgnClient, traceFetch };
