const Redis = require('ioredis');

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
        obj[key.replace(keyName, "")] = JSON.parse(values[index]); // Assign each value to its corresponding key
        return obj;
    }, {});
    return result;
}

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
    calculateRateAndAverageResponseTimeAndReset,
    countStatusCodesByKey
}