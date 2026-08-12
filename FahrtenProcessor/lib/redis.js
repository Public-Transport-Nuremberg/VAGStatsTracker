const Redis = require('ioredis');
const { Queue } = require('bullmq');
const randomstring = require('randomstring');

const TRIPS_GEO_KEY = 'TRIPS:GEO';
const TRIPS_GEO_EXPIRY_KEY = 'TRIPS:GEO:EXPIRY';
const REDIS_MAX_LATITUDE = 85.05112878;

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

const metricsTime = 1
setInterval(async () => {
    queueMetrics = await trips_q.getJobCounts()
    redis.set('METRIC:QueuedTotalTrips.Active', queueMetrics.active, "EX", metricsTime * 2);
    redis.set('METRIC:QueuedTotalTrips.Delayed', queueMetrics.delayed, "EX", metricsTime * 2);
    redis.set('METRIC:QueuedTotalTrips.Completed', queueMetrics.completed, "EX", metricsTime * 2);
    redis.set('METRIC:QueuedTotalTrips.Failed', queueMetrics.failed, "EX", metricsTime * 2);
}, metricsTime * 1000);

/**
 * Write a new datapoint to the Redis list, specified by the listKey, to avrage out later
 * @param {String} datapoint 
 * @param {String} listKey 
 */
const writeNewDatapoint = (listKey, datapoint) => {
    redis.rpush(listKey, datapoint);
}

/**
 * Check if a key exists in the Redis database
 * @param {Number} number 
 * @returns 
 */
const checkTripKey = async (number) => {
    const key = `TRIP:${number}`;
    const exists = await redis.exists(key);
    return exists;
}

/**
 * Delete a key from the Redis database
 * @param {Number} number 
 */
const delTripKey = async (number) => {
    const key = `TRIP:${number}`;
    await redis.multi()
        .del(key)
        .zrem(TRIPS_GEO_KEY, number)
        .zrem(TRIPS_GEO_EXPIRY_KEY, number)
        .exec();
}

/**
 * Write a new error to the Redis database with all available information
 * @param {String} errorMessage 
 * @param {Any} errorData 
 * @param {Object} jobData
 * @returns 
 */
const errorExporter = (errorMessage, errorData, jobData) => {
    const errorToken = randomstring.generate({
        length: 20,
        charset: 'alphanumeric'
    });
    const errorKey = `ERRORID:${errorToken}`;
    redis.set(errorKey, JSON.stringify({ errorMessage, errorData, jobData }, "EX", parseInt(process.env.ERROR_EXPIRE, 10) || 3600));
    return errorToken;
}

/**
 * @typedef {Object} tripData
 * @property {Number} VGNKennung
 * @property {String} VAGKennung
 * @property {String} Produkt
 * @property {String} Linienname
 * @property {String} Richtung
 * @property {String} Richtungstext
 * @property {Number} Fahrzeugnummer
 * @property {String} Betriebstag
 * @property {Number} Besetzgrad
 * @property {String} Haltepunkt
 * @property {String} AbfahrtszeitSoll
 * @property {String} AbfahrtszeitIst
 * @property {Number} PercentageToNextStop
 * @property {Object} Fahrt
 */

/**
 * Schedule a new job in the queue for when the product will proboably stop at the next stop
 * @param {Number} Fahrtnummer 
 * @param {String} Betriebstag 
 * @param {String} Produkt 
 * @param {tripData} keyData 
 * @param {number[]} AlreadyTrackedStops 
 * @param {String} runAtTimestamp 
 * @param {String} Startzeit
 * @param {String} Endzeit 
 * @param {Number} latitude
 * @param {Number} longitude
 * @returns 
 */
const ScheduleJob = async (Fahrtnummer, Betriebstag, Produkt, keyData, AlreadyTrackedStops, runAtTimestamp, Startzeit, Endzeit, latitude, longitude) => {

    const key = `TRIP:${Fahrtnummer}`;

    const ttl = parseInt(((Endzeit - new Date().getTime()) / 1000) + (60 * 60), 10);
    const delay = parseInt((runAtTimestamp - new Date().getTime()), 10);

    const tripTtl = Math.max(ttl, 1);
    const expiresAt = Date.now() + (tripTtl * 1000);
    const validPosition = Number.isFinite(Number(latitude))
        && Number.isFinite(Number(longitude))
        && Number(latitude) >= -REDIS_MAX_LATITUDE
        && Number(latitude) <= REDIS_MAX_LATITUDE
        && Number(longitude) >= -180
        && Number(longitude) <= 180;

    const transaction = redis.multi().set(key, JSON.stringify(keyData), "EX", tripTtl);
    if (validPosition) {
        transaction
            .geoadd(TRIPS_GEO_KEY, Number(longitude), Number(latitude), Fahrtnummer)
            .zadd(TRIPS_GEO_EXPIRY_KEY, expiresAt, Fahrtnummer);
    } else {
        transaction
            .zrem(TRIPS_GEO_KEY, Fahrtnummer)
            .zrem(TRIPS_GEO_EXPIRY_KEY, Fahrtnummer);
    }
    await transaction.exec();

    await trips_q.add(`${Fahrtnummer}`, {
        Fahrtnummer: Fahrtnummer,
        Betriebstag: Betriebstag,
        Produkt: Produkt,
        AlreadyTrackedStops: AlreadyTrackedStops,
        Startzeit: Startzeit,
        Endzeit: Endzeit,
        Fahrt: keyData.Fahrt ?? null,
    }, { delay: Math.max(delay, 30000), attempts: 2 });

    return delay
}

module.exports = {
    writeNewDatapoint,
    checkTripKey,
    delTripKey,
    errorExporter,
    ScheduleJob
}
