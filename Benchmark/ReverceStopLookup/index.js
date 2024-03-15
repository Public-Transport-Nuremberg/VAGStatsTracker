const StoreBenchmark = require('./benchmark.js');

const { ObectStore, MapStore, MegaHashStore, RedisStore } = require('./lib/engine.js');

const redisData = {
    port: process.env.Redis_Port || 6379,
    host: process.env.Redis_Host || "127.0.0.1",
    username: process.env.Redis_User || "default",
    password: process.env.Redis_Password || "example",
    db: process.env.Redis_DB || 0,
}

process.redisData = redisData;

const storeClasses = [ObectStore, MapStore, MegaHashStore, RedisStore];

const benchmark = new StoreBenchmark(storeClasses, {
    maxKeys: 10_000_000,
    metricsEvery: 2_000_000,
});


benchmark.run();