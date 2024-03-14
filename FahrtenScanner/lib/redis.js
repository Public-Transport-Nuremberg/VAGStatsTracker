const Redis = require('ioredis');
const { Queue } = require('bullmq');

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

/**
 * Add a new fahrten job to the queue
 * @param {Number} Fahrtnummer 
 * @param {String} Betriebstag 
 * @param {String} Produkt 
 * @param {Number} runAtTimestamp 
 * @param {Number} Endzeit 
 */
const addJob = async (Fahrtnummer, Betriebstag, Produkt, runAtTimestamp, Endzeit) => {
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
    }

    redis.set(key, JSON.stringify(keyData), "EX", ttl);

    await trips_q.add(`${Fahrtnummer}`, {
        Fahrtnummer: Fahrtnummer,
        Betriebstag: Betriebstag,
        Produkt: Produkt,
        AlreadyTrackedStops: [],
        Startzeit: runAtTimestamp,
        Endzeit: Endzeit
    }, { delay: delay, attempts: 2 });

    return delay
}

module.exports = {
    writeNewDatapoint,
    writeNewDatapointKey,
    checkTripKey,
    addJob
}
