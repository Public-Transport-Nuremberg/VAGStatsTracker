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
const knownTripStopsKey = 'SCANNER:PrimaryTripStops';
const departureDiscoveryRequestsKey = 'SCANNER:DepartureDiscovery:REQUESTS';
const departureDiscoveryCandidatesKey = 'SCANNER:DepartureDiscovery:CANDIDATES';
const departureDiscoveryMentionedKey = 'SCANNER:DepartureDiscovery:MENTIONED';
const departureDiscoveryScheduleKey = 'SCANNER:DepartureDiscovery:SCHEDULE';
const departureDiscoveryStateKey = 'SCANNER:DepartureDiscovery:STATE';
const departureDiscoveryRequiredKey = 'SCANNER:DepartureDiscovery:REQUIRED';

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

const getKnownTripStopIds = async () => new Set(await redis.smembers(knownTripStopsKey));

const getDepartureDiscoveryRequiredStopIds = async () => {
    const [requiredStopIds, requestEntries] = await Promise.all([
        redis.smembers(departureDiscoveryRequiredKey),
        redis.hgetall(departureDiscoveryRequestsKey),
    ]);
    const required = new Set(requiredStopIds.map(String));
    for (const [stopId, value] of Object.entries(requestEntries)) {
        try {
            if (Number(JSON.parse(value).newTrips) > 0) required.add(String(stopId));
        } catch {}
    }
    if (required.size > requiredStopIds.length) {
        await redis.sadd(departureDiscoveryRequiredKey, ...required);
    }
    return required;
};

const markDepartureDiscoveryRequired = (stopId) => redis.sadd(
    departureDiscoveryRequiredKey,
    String(stopId)
);

const updateDepartureDiscoveryPlan = async ({
    candidates,
    mentionedStopIds,
    state,
    initialSchedule = [],
    maximumScheduledAt = null,
}) => {
    const [previousCandidates, scheduledStops, rawPreviousState, schedulesPastMaximum] = await Promise.all([
        redis.smembers(departureDiscoveryCandidatesKey),
        redis.zrange(departureDiscoveryScheduleKey, 0, -1),
        redis.get(departureDiscoveryStateKey),
        Number.isFinite(maximumScheduledAt)
            ? redis.zrangebyscore(departureDiscoveryScheduleKey, `(${maximumScheduledAt}`, '+inf')
            : Promise.resolve([]),
    ]);
    let previousState = {};
    try { previousState = rawPreviousState ? JSON.parse(rawPreviousState) : {}; } catch { previousState = {}; }
    const resetSchedule = state.enabled === false
        || previousState.scheduler !== 'per-stop'
        || previousState.schedulerVersion !== state.schedulerVersion;
    const candidateSet = new Set(candidates.map(String));
    const scheduledSet = resetSchedule ? new Set() : new Set(scheduledStops.map(String));
    const removedCandidates = previousCandidates.filter((stopId) => !candidateSet.has(String(stopId)));
    const missingSchedules = initialSchedule.filter(({ stopId }) => !scheduledSet.has(String(stopId)));
    const schedulesToClamp = schedulesPastMaximum.filter((stopId) => candidateSet.has(String(stopId)));
    const transaction = redis.multi()
        .del(departureDiscoveryCandidatesKey)
        .del(departureDiscoveryMentionedKey)
        .set(departureDiscoveryStateKey, JSON.stringify(state));

    if (resetSchedule) transaction.del(departureDiscoveryScheduleKey);

    if (candidates.length > 0) {
        transaction.sadd(departureDiscoveryCandidatesKey, ...candidates.map(String));
    }
    if (mentionedStopIds.length > 0) {
        transaction.sadd(departureDiscoveryMentionedKey, ...mentionedStopIds.map(String));
    }
    if (!resetSchedule && removedCandidates.length > 0) {
        transaction.zrem(departureDiscoveryScheduleKey, ...removedCandidates);
    }
    if (missingSchedules.length > 0) {
        transaction.zadd(
            departureDiscoveryScheduleKey,
            ...missingSchedules.flatMap(({ stopId, timestamp }) => [Number(timestamp), String(stopId)])
        );
    }
    if (!resetSchedule && schedulesToClamp.length > 0) {
        transaction.zadd(
            departureDiscoveryScheduleKey,
            ...schedulesToClamp.flatMap((stopId) => [Number(maximumScheduledAt), String(stopId)])
        );
    }

    await transaction.exec();
};

const recordDepartureDiscoveryRequest = (stopId, data) => redis.hset(
    departureDiscoveryRequestsKey,
    String(stopId),
    JSON.stringify(data)
);

const getDepartureDiscoveryRequest = async (stopId) => {
    const value = await redis.hget(departureDiscoveryRequestsKey, String(stopId));
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const claimDueDepartureDiscoveryStop = async (now, leaseUntil) => redis.eval(`
    local stopId = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)[1]
    if not stopId then return nil end
    if redis.call('SISMEMBER', KEYS[2], stopId) == 0 then
        redis.call('ZREM', KEYS[1], stopId)
        return ''
    end
    redis.call('ZADD', KEYS[1], ARGV[2], stopId)
    return stopId
`, 2, departureDiscoveryScheduleKey, departureDiscoveryCandidatesKey, Number(now), Number(leaseUntil));

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
        StopLearningSource: RecordKnownStops ? 'getTrips' : 'departures',
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
    getKnownTripStopIds,
    getDepartureDiscoveryRequiredStopIds,
    markDepartureDiscoveryRequired,
    updateDepartureDiscoveryPlan,
    recordDepartureDiscoveryRequest,
    getDepartureDiscoveryRequest,
    claimDueDepartureDiscoveryStop,
    setDepartureDiscoveryScheduledAt,
    addJob
}
