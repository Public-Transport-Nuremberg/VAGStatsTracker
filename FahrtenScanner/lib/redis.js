const Redis = require('ioredis');
const { Queue } = require('bullmq');

const redisData = {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || "127.0.0.1",
    username: process.env.REDIS_USER || "default",
    password: process.env.REDIS_PASSWORD || "example",
    db: process.env.REDIS_DB || 0,
}

// Initialize Redis connection
const redis = new Redis(redisData);

queueData = redisData
queueData.db = queueData.db + 1

const trips_q = new Queue('q:trips', { connection: queueData });
const departureDiscoveryCursorKey = 'SCANNER:DepartureDiscoveryCursor';
const knownTripStopsKey = 'SCANNER:KnownTripStops';
const departureDiscoveryRequestsKey = 'SCANNER:DepartureDiscovery:REQUESTS';
const departureDiscoveryCandidatesKey = 'SCANNER:DepartureDiscovery:CANDIDATES';
const departureDiscoveryMentionedKey = 'SCANNER:DepartureDiscovery:MENTIONED';
const departureDiscoveryScheduleKey = 'SCANNER:DepartureDiscovery:SCHEDULE';
const departureDiscoveryStateKey = 'SCANNER:DepartureDiscovery:STATE';

/**
 * Write a new datapoint to the Redis list, specified by the listKey, to avrage out later
 * @param {String} datapoint 
 * @param {String} listKey 
 */
const writeNewDatapoint = (listKey, datapoint) => {
    redis.rpush(listKey, datapoint);
}

/**
 * Write a new datapoint as a seperate key
 * @param {String} datapoint 
 * @param {String} listKey 
 * @returns 
 */
const writeNewDatapointKey = (listKey, datapoint) => {
    return redis.set(listKey, datapoint);
}

const checkTripKey = async (number) => {
    const key = `TRIP:${number}`;
    const exists = await redis.exists(key);
    return exists;
}

const getDepartureDiscoveryCursor = async () => {
    const cursor = Number(await redis.get(departureDiscoveryCursorKey));
    return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
}

const setDepartureDiscoveryCursor = (cursor) => redis.set(departureDiscoveryCursorKey, cursor);

const getKnownTripStopIds = async () => new Set(await redis.smembers(knownTripStopsKey));

const updateDepartureDiscoveryPlan = async ({ candidates, mentionedStopIds, schedule, state }) => {
    const transaction = redis.multi()
        .del(departureDiscoveryCandidatesKey)
        .del(departureDiscoveryMentionedKey)
        .del(departureDiscoveryScheduleKey)
        .set(departureDiscoveryStateKey, JSON.stringify(state));

    if (candidates.length > 0) {
        transaction.sadd(departureDiscoveryCandidatesKey, ...candidates.map(String));
    }
    if (mentionedStopIds.length > 0) {
        transaction.sadd(departureDiscoveryMentionedKey, ...mentionedStopIds.map(String));
    }
    if (schedule.length > 0) {
        transaction.zadd(
            departureDiscoveryScheduleKey,
            ...schedule.flatMap(({ stopId, timestamp }) => [Number(timestamp), String(stopId)])
        );
    }

    await transaction.exec();
};

const recordDepartureDiscoveryRequest = (stopId, data) => redis.hset(
    departureDiscoveryRequestsKey,
    String(stopId),
    JSON.stringify(data)
);

const setDepartureDiscoveryScheduledAt = (stopId, timestamp) => redis.zadd(
    departureDiscoveryScheduleKey,
    Number(timestamp),
    String(stopId)
);

/**
 * Add a new fahrten job to the queue
 * @param {Number} Fahrtnummer 
 * @param {String} Betriebstag 
 * @param {String} Produkt 
 * @param {Number} runAtTimestamp 
 * @param {Number} Endzeit 
 * @param {Object} Fahrt
 * @param {Boolean} RecordKnownStops
 */
const addJob = async (Fahrtnummer, Betriebstag, Produkt, runAtTimestamp, Endzeit, Fahrt = null, RecordKnownStops = true) => {
    const key = `TRIP:${Fahrtnummer}`;

    const ttl = parseInt(((Endzeit - new Date().getTime()) / 1000) + (60 * 60), 10);
    const delay = parseInt((runAtTimestamp - new Date().getTime()) / 1000, 10);

    const keyData = {
        VGNKennung: 0,
        VAGKennung: 0,
        Produkt: 0,
        Linienname: 0,
        Richtung: 0,
        Richtungstext: 0,
        Fahrzeugnummer: 0,
        Betriebstag: 0,
        Besetzgrad: 0,
        Haltepunkt: 0,
        AbfahrtszeitSoll: 0,
        AbfahrtszeitIst: 0,
        PercentageToNextStop: 0,
        Fahrt,
    }

    redis.set(key, JSON.stringify(keyData), "EX", ttl);

    await trips_q.add(`${Fahrtnummer}`, {
        Fahrtnummer: Fahrtnummer,
        Betriebstag: Betriebstag,
        Produkt: Produkt,
        AlreadyTrackedStops: [],
        Startzeit: runAtTimestamp,
        Endzeit: Endzeit,
        Fahrt,
        RecordKnownStops,
    }, {
        delay: delay,
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
    });

    return delay
}

module.exports = {
    writeNewDatapoint,
    writeNewDatapointKey,
    checkTripKey,
    getDepartureDiscoveryCursor,
    setDepartureDiscoveryCursor,
    getKnownTripStopIds,
    updateDepartureDiscoveryPlan,
    recordDepartureDiscoveryRequest,
    setDepartureDiscoveryScheduledAt,
    addJob
}
