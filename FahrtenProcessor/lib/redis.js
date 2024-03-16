const Redis = require('ioredis');
const { Queue } = require('bullmq');
const randomstring = require('randomstring');

const redisData = {
    port: process.env.Redis_Port || 6379,
    host: process.env.Redis_Host || "127.0.0.1",
    username: process.env.Redis_User || "default",
    password: process.env.Redis_Password || "example",
    db: process.env.Redis_DB || 0,
}

// Initialize Redis connection
const redis = new Redis(redisData);

queueData = redisData
queueData.db = queueData.db + 1

const trips_q = new Queue('q:trips', { connection: queueData });

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
    await redis.del(key);
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
 * @returns 
 */
const ScheduleJob = async (Fahrtnummer, Betriebstag, Produkt, keyData, AlreadyTrackedStops, runAtTimestamp, Startzeit, Endzeit) => {

    const key = `TRIP:${Fahrtnummer}`;

    const ttl = parseInt(((Endzeit - new Date().getTime()) / 1000) + (60 * 60), 10);
    const delay = parseInt((runAtTimestamp - new Date().getTime()), 10);

    redis.set(key, JSON.stringify(keyData), "EX", ttl);

    await trips_q.add(`${Fahrtnummer}`, {
        Fahrtnummer: Fahrtnummer,
        Betriebstag: Betriebstag,
        Produkt: Produkt,
        AlreadyTrackedStops: AlreadyTrackedStops,
        Startzeit: Startzeit,
        Endzeit: Endzeit
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
