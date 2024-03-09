const Redis = require('ioredis');
const { Queue } = require('bullmq');

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

const checkTripKey = async (number) => {
    const key = `TRIP:${number}`;
    const exists = await redis.exists(key);
    return exists;
}

/**
 * Adds the key and schedules a job.
 * @param {Number} number The unique identifier for the key.
 * @param {Object} data The data to complete the job.
 * @param {Number} timestamp The timestamp for when the job should be nearly executed.
 */
const ScheduleJob = async (number, data, timestamp) => {
    const key = `TRIP:${number}`;

    // Check that the timestamp is at least 5 seconds in the future
    const timeNow = new Date().getTime();
    const delay = timestamp - timeNow;

    if (delay > 5000) {
        // The key does not exist, so add the key to Redis
        await redis.set(key, timestamp);
        // Schedule the job with BullMQ
        await trips_q.add(`${number}:${data.VGNKennung}:${data.Haltepunkt}`, data, { delay });
        console.log(`${number}:${data.VGNKennung}:${data.Haltepunkt}`)
        process.log.info(`Job for ${key} scheduled to run in ${new Date(timestamp).toLocaleString()} - Delay: ${(delay/1000).toFixed(0)} Seconds`);
    } else {
        process.log.info(`Cannot schedule job for ${key} because the timestamp is too soon or in the past. ${new Date(timestamp).toLocaleString()} - ${delay}`);
    }
};

module.exports = {
    writeNewDatapoint,
    checkTripKey,
    ScheduleJob
}
