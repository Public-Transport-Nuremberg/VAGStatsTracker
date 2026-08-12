const Redis = require('ioredis');

const TRIPS_GEO_KEY = 'TRIPS:GEO';
const TRIPS_GEO_EXPIRY_KEY = 'TRIPS:GEO:EXPIRY';
const EARTH_RADIUS_METERS = 6371008.8;
const REDIS_MAX_LATITUDE = 85.05112878;
const COORDINATE_EPSILON = 0.000001;
const GEO_CLEANUP_INTERVAL_MS = 10000;
let lastGeoCleanupAt = 0;
let geoCleanupPromise = null;

const redisData = {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || "127.0.0.1",
    username: process.env.REDIS_USER || "default",
    password: process.env.REDIS_PASSWORD || "example",
    db: process.env.REDIS_DB || 0,
}

// Initialize Redis connection
const redis = new Redis(redisData);

// Function to parse Redis info output and extract relevant values
const monitorRedis = async () => {
    const info = await redis.info();
    
    const lines = info.split('\n').filter(line => line.trim() !== '');

    const relevantKeys = [
        'used_memory',
        'used_memory_peak',
        'used_memory_rss',
        'connected_clients',
        'blocked_clients',
        'instantaneous_ops_per_sec',
        'keyspace_hits',
        'keyspace_misses',
        'total_commands_processed',
        'rejected_connections',
        'expired_keys',
        'evicted_keys',
        'used_cpu_sys',
        'used_cpu_user'
    ];

    const data = {};
    let section = '';
    for (const line of lines) {
        if (line.startsWith('#')) {
            section = line.substring(1).trim();
            data[section] = {};
        } else {
            const [key, value] = line.split(':');
            const trimmedKey = key.trim();
            if(!relevantKeys.includes(trimmedKey)) continue; // If the key is not present in the relevantKeys array, skip it
            if (relevantKeys.includes(trimmedKey)) {
                data[section][trimmedKey] = value.trim();
            }
        }
    }

    return data;
};

const findAllMetricKeys = async () => {
    const keys = await redis.keys('METRIC:*');
    return keys;
}

const findAllMetricListKeys = async () => {
    const keys = await redis.keys('METRICLIST:*');
    return keys;
}
const findAllErrorListKeys = async () => {
    const keys = await redis.keys('ERRORLIST:*');
    return keys;
}

const findAllErrorIDKeys = async () => {
    const keys = await redis.keys('ERRORID:*');
    return keys;
}

const findAllTripKeys = async () => {
    const keys = await redis.keys('TRIP:*');
    return keys;
}

const getValuesFromKeys = async (keyName, keys) => {
    if(keys.length === 0) return {};
    const values = await redis.mget(keys); // Fetch the values for the given keys
    // Combine keys and values into an object
    const result = keys.reduce((obj, key, index) => {
        if (values[index] !== null) {
            obj[key.replace(keyName, "")] = JSON.parse(values[index]); // Assign each value to its corresponding key
        }
        return obj;
    }, {});
    return result;
}

const cleanupExpiredTripLocations = async () => {
    const now = Date.now();
    if (geoCleanupPromise) return geoCleanupPromise;
    if (now - lastGeoCleanupAt < GEO_CLEANUP_INTERVAL_MS) return;

    lastGeoCleanupAt = now;
    // Select and remove in one atomic operation so a concurrent refresh stays indexed.
    geoCleanupPromise = redis.eval(`
        local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
        for _, member in ipairs(expired) do
            redis.call('ZREM', KEYS[1], member)
            redis.call('ZREM', KEYS[2], member)
        end
        return #expired
    `, 2, TRIPS_GEO_KEY, TRIPS_GEO_EXPIRY_KEY, now, 1000);

    try {
        await geoCleanupPromise;
    } finally {
        geoCleanupPromise = null;
    }
};

const removeStaleTripLocations = async (tripIds) => {
    if (tripIds.length === 0) return;
    await redis.eval(`
        local removed = 0
        for _, member in ipairs(ARGV) do
            if redis.call('EXISTS', 'TRIP:' .. member) == 0 then
                redis.call('ZREM', KEYS[1], member)
                redis.call('ZREM', KEYS[2], member)
                removed = removed + 1
            end
        end
        return removed
    `, 2, TRIPS_GEO_KEY, TRIPS_GEO_EXPIRY_KEY, ...tripIds);
};

const getTripValuesByIds = async (tripIds) => {
    if (tripIds.length === 0) return {};

    const keys = tripIds.map((tripId) => `TRIP:${tripId}`);
    const values = await redis.mget(keys);
    const staleTripIds = [];
    const result = {};

    values.forEach((value, index) => {
        if (value === null) {
            staleTripIds.push(tripIds[index]);
            return;
        }
        result[tripIds[index]] = JSON.parse(value);
    });

    await removeStaleTripLocations(staleTripIds);
    return result;
};

const getIndexedTripValues = async () => {
    await cleanupExpiredTripLocations();
    return getTripValuesByIds(await redis.zrange(TRIPS_GEO_KEY, 0, -1));
};

const getTripValuesInBoundingBox = async (boundingBox) => {
    await cleanupExpiredTripLocations();

    const minLatitude = Math.max(boundingBox.minLatitude, -REDIS_MAX_LATITUDE);
    const maxLatitude = Math.min(boundingBox.maxLatitude, REDIS_MAX_LATITUDE);
    if (minLatitude >= maxLatitude) return {};

    const centerLongitude = (boundingBox.minLongitude + boundingBox.maxLongitude) / 2;
    const centerLatitude = (minLatitude + maxLatitude) / 2;
    const radians = Math.PI / 180;

    // Redis GEOSEARCH takes metric dimensions. Slightly enlarge the candidate box,
    // then apply the exact WGS84 bounds below to avoid edge rounding exclusions.
    const widthMeters = Math.max(
        (boundingBox.maxLongitude - boundingBox.minLongitude) * radians
            * EARTH_RADIUS_METERS * Math.cos(centerLatitude * radians) * 1.01,
        1
    );
    const heightMeters = Math.max(
        (maxLatitude - minLatitude) * radians * EARTH_RADIUS_METERS * 1.01,
        1
    );

    const candidates = await redis.geosearch(
        TRIPS_GEO_KEY,
        'FROMLONLAT', centerLongitude, centerLatitude,
        'BYBOX', widthMeters, heightMeters, 'm',
        'WITHCOORD'
    );

    const tripIds = candidates
        .filter(([, coordinates]) => {
            const longitude = Number(coordinates[0]);
            const latitude = Number(coordinates[1]);
            return longitude >= boundingBox.minLongitude - COORDINATE_EPSILON
                && longitude <= boundingBox.maxLongitude + COORDINATE_EPSILON
                && latitude >= boundingBox.minLatitude - COORDINATE_EPSILON
                && latitude <= boundingBox.maxLatitude + COORDINATE_EPSILON;
        })
        .map(([tripId]) => tripId);

    return getTripValuesByIds(tripIds);
};

const calculateRateAndAverageResponseTimeAndReset = async (keys, timeframeInSeconds) => {
    const ratesAndAverages = {};

    for (const key of keys) {
        const responses = await redis.lrange(key, 0, -1);
        const count = responses.length;
        const rate = (count / timeframeInSeconds).toFixed(2);

        const totalResponseTime = responses.reduce((total, responseTime) => {
            return total + parseFloat(responseTime);
        }, 0);
        const averageResponseTime = count > 0 ? (totalResponseTime / count).toFixed(0) : 0;

        ratesAndAverages[key.replace("METRICLIST:", "")] = {
            rate,
            averageResponseTime
        };

        await redis.del(key);
    }

    return ratesAndAverages;
}

const countStatusCodesByKey = async (keys) => {
    const allStatusCodeCounts = {};

    for (const key of keys) {
        const statusCodes = await redis.lrange(key, 0, -1);
        const statusCodeCounts = {};

        for (const code of statusCodes) {
            if (!statusCodeCounts[code]) {
                statusCodeCounts[code] = 0;
            }
            statusCodeCounts[code]++;
        }

        allStatusCodeCounts[key.replace("ERRORLIST:", "")] = statusCodeCounts;

        await redis.del(key);
    }

    return allStatusCodeCounts;
}



module.exports = {
    monitorRedis,
    findAllMetricKeys,
    findAllMetricListKeys,
    findAllErrorListKeys,
    findAllErrorIDKeys,
    findAllTripKeys,
    getValuesFromKeys,
    getIndexedTripValues,
    getTripValuesInBoundingBox,
    calculateRateAndAverageResponseTimeAndReset,
    countStatusCodesByKey
}
