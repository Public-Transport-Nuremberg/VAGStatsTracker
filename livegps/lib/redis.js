const Redis = require('ioredis');

const PREFIX = 'LIVEGPS:VMI:';
const KEYS = {
    stream: `${PREFIX}OBSERVATIONS`, geo: `${PREFIX}GEO`, expiry: `${PREFIX}GEO_EXPIRY`,
    state: (id) => `${PREFIX}STATE:${id}`,
    object: (id) => `${PREFIX}OBJECT:${id}`,
    vehicle: (id) => `${PREFIX}VEHICLE:${id}`,
    watermark: (id) => `${PREFIX}WATERMARK:${id}`,
};
const GROUP = 'clickhouse';
const CONSUMER = 'archive'; // Fixed name deliberately recovers this single worker's pending entries.

const publishScript = `
local sourceTime = tonumber(ARGV[5])
local function accepts(oldTime)
    if oldTime == false or oldTime == nil then return true end
    oldTime = tonumber(oldTime)
    if sourceTime < 0 then return oldTime < 0 end
    return oldTime < 0 or sourceTime >= oldTime
end
local queued = 0
if redis.call('HGET', KEYS[2], 'hash') ~= ARGV[1] then
    redis.call('XADD', KEYS[1], '*', 'row', ARGV[2])
    redis.call('HSET', KEYS[2], 'hash', ARGV[1])
    queued = 1
end
if accepts(redis.call('HGET', KEYS[2], 'latest_ms')) then
    redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
    redis.call('HSET', KEYS[2], 'latest_ms', ARGV[5])
end
local watermark = redis.call('HGET', KEYS[5], 'timestamp')
local updateVehicle = true
if watermark then
    updateVehicle = accepts(watermark)
    -- Select the same object consistently when two journeys have the same timestamp.
    if updateVehicle and sourceTime >= 0 and sourceTime == tonumber(watermark)
        and ARGV[7] > redis.call('HGET', KEYS[5], 'entity_key') then
        updateVehicle = false
    end
end
if updateVehicle then
    redis.call('SET', KEYS[4], ARGV[3], 'EX', ARGV[4])
    redis.call('HSET', KEYS[5], 'timestamp', ARGV[5], 'entity_key', ARGV[7])
    local geoUntil = tonumber(ARGV[9])
    if geoUntil > tonumber(ARGV[6]) then
        redis.call('GEOADD', KEYS[6], ARGV[10], ARGV[11], ARGV[8])
        redis.call('ZADD', KEYS[7], geoUntil, ARGV[8])
    else
        redis.call('ZREM', KEYS[6], ARGV[8])
        redis.call('ZREM', KEYS[7], ARGV[8])
    end
end
return queued
`;

const cleanupScript = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 1000)
for _, member in ipairs(expired) do
    redis.call('ZREM', KEYS[1], member)
    redis.call('ZREM', KEYS[2], member)
end
return #expired
`;

const acknowledgeScript = `
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], unpack(ARGV, 2))
redis.call('XDEL', KEYS[1], unpack(ARGV, 2))
return acknowledged
`;

function createRedis(config) {
    return new Redis({
        host: config.REDIS_HOST, port: config.REDIS_PORT, db: config.REDIS_DB,
        username: config.REDIS_USER || undefined, password: config.REDIS_PASSWORD || undefined,
        lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 10000, enableOfflineQueue: false,
    });
}

class ObservationStore {
    constructor(redis, { ttlSeconds = 180, batchSize = 500 } = {}) {
        this.redis = redis;
        this.ttlSeconds = ttlSeconds;
        this.batchSize = batchSize;
    }

    async initialize() {
        try { await this.redis.xgroup('CREATE', KEYS.stream, GROUP, '0', 'MKSTREAM'); }
        catch (error) { if (!error.message.includes('BUSYGROUP')) throw error; }
    }

    async publish(observations) {
        if (!observations.length) return 0;
        const { geoExpiry } = require('./observations');
        // Bound pipeline memory for unexpectedly large source responses.
        let queued = 0;
        for (let offset = 0; offset < observations.length; offset += this.batchSize) {
            const pipeline = this.redis.pipeline();
            for (const observation of observations.slice(offset, offset + this.batchSize)) {
                pipeline.eval(publishScript, 7, KEYS.stream, KEYS.state(observation.entityKey),
                    KEYS.object(observation.entityKey), KEYS.vehicle(observation.vehicleKey),
                    KEYS.watermark(observation.vehicleKey), KEYS.geo, KEYS.expiry,
                    observation.payloadHash, JSON.stringify(observation.row), JSON.stringify(observation.payload),
                    this.ttlSeconds, observation.sourceMs ?? -1, observation.fetchedAt,
                    observation.entityKey, observation.vehicleKey, geoExpiry(observation, this.ttlSeconds),
                    observation.payload.longitude ?? '', observation.payload.latitude ?? '');
            }
            const results = await pipeline.exec();
            for (const [error, result] of results) {
                if (error) throw error;
                queued += Number(result);
            }
        }
        return queued;
    }

    async recordRequestDuration(durationMilliseconds, completedAt) {
        const results = await this.redis.multi()
            .set('METRIC:LiveGPS.RequestDurationMilliseconds', durationMilliseconds)
            .set('METRIC:LiveGPS.LastRequestTimestamp', completedAt / 1000)
            .exec();
        for (const [error] of results) {
            if (error) throw error;
        }
    }

    async readBatch() {
        const read = (id) => this.redis.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', this.batchSize, 'STREAMS', KEYS.stream, id);
        let response = await read('0');
        if (!response?.[0]?.[1]?.length) response = await read('>');
        return (response?.[0]?.[1] || []).map(([id, fields]) => {
            const rowIndex = fields?.indexOf('row');
            if (rowIndex === undefined || rowIndex < 0) throw new Error(`Missing row in observation stream entry ${id}`);
            return { id, row: JSON.parse(fields[rowIndex + 1]) };
        });
    }

    async acknowledge(ids) {
        if (ids.length) await this.redis.eval(acknowledgeScript, 1, KEYS.stream, GROUP, ...ids);
    }

    backlog() { return this.redis.xlen(KEYS.stream); }

    async cleanup(now = Date.now()) {
        let removed = 0;
        let count;
        do {
            count = Number(await this.redis.eval(cleanupScript, 2, KEYS.geo, KEYS.expiry, now));
            removed += count;
        } while (count === 1000);
        return removed;
    }
}

module.exports = { createRedis, ObservationStore, KEYS, GROUP, CONSUMER };
