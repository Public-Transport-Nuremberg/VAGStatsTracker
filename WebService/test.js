require('dotenv').config({quiet: true});
const Redis = require("ioredis");

const redis = new Redis({
    port: process.env.Redis_Port || 6379,
    host: process.env.Redis_Host || "127.0.0.1",
    username: process.env.Redis_User || "default",
    password: process.env.Redis_Password || "default",
    db: process.env.Redis_DB || 0,
});

redis.on("error", (err) => {
    console.error(err);
    process.exit(2);
});

(async () => {
    const keys = await redis.keys("TRIP:*");
    const trams = [];

    for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;

        const obj = JSON.parse(raw);

        if (obj.Produkt === "Tram") {
            trams.push(obj);
        }
    }

    console.log(trams);
    await redis.quit();
})().catch(async (err) => {
    console.error(err);
    await redis.quit();
    process.exit(1);
});
