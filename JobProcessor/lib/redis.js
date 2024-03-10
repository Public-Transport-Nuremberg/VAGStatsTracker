const Redis = require('ioredis');
const { Queue } = require('bullmq');
const randomstring = require('randomstring');

const redisData = {
    port: process.env.Redis_Port || 6379,
    host: process.env.Redis_Host || "127.0.0.1",
    username: process.env.Redis_User || "default",
    password: process.env.Redis_Password || "default",
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
    const errorToken = randomstring.generate(10);
    const errorKey = `ERROR:${errorToken}`;
    redis.set(errorKey, JSON.stringify({ errorMessage, errorData, jobData }));
    return errorToken;
}

/**
 * Adds the key and schedules a job.
 * @param {Number} number The unique identifier for the key.
 * @param {Object} data The data to complete the job.
 * @param {Array} tripTimeline The timeline of the trip.
 * @param {Number} timestamp The timestamp for when the job should be nearly executed.
 * @param {Number} requestDuration The duration of the request
 */
const ScheduleJob = async (number, data, tripTimeline, timestamp, requestDuration) => {
    const key = `TRIP:${number}`;

    // Check that the timestamp is at least 5 seconds in the future
    const timeNow = new Date().getTime();
    const delay = (timestamp - timeNow) - requestDuration;

    if( delay < 5000 ) {
        delTripKey(number);
        return process.log.info(`Cannot schedule job for ${number} (Linie: ${data.Linienname}) because the timestamp is too soon or in the past. ${new Date(timestamp).toLocaleString()} - ${delay}, Ping: ${requestDuration}ms`);
    }

    // The key does not exist, so add the key to Redis
    await redis.set(key, timestamp);
    // Schedule the job with BullMQ
    data.tripTimeline = tripTimeline;
    await trips_q.add(`${number}:${data.VGNKennung}:${data.Haltepunkt}`, data, { delay, attempts: 3, });
    process.log.debug(`Job for ${key} scheduled to run in ${new Date(timestamp).toLocaleString()} - Scheduled in: ${(delay / 1000).toFixed(0)} Seconds`);

};

module.exports = {
    writeNewDatapoint,
    checkTripKey,
    delTripKey,
    errorExporter,
    ScheduleJob
}
