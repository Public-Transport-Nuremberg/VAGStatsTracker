const express = require('ultimate-express');
const { limiter } = require('@middleware/limiter');
const { database } = require('@lib/clickhouse');

const router = new express.Router();
const PluginName = 'Database Stats';
const PluginRequirements = [];
const PluginVersion = '1.0.0';

let cachedStats;
let cachedAt = 0;
let refreshPromise;
const CACHE_MS = 2 * 60_000;

router.get('/', limiter(10), async (req, res) => {
    if (!cachedStats || Date.now() - cachedAt >= CACHE_MS) {
        if (!refreshPromise) {
            refreshPromise = database.getStats()
                .then((stats) => {
                    cachedStats = stats;
                    cachedAt = Date.now();
                    return stats;
                })
                .catch((error) => {
                    if (!cachedStats) throw error;
                    cachedAt = Date.now();
                    return cachedStats;
                })
                .finally(() => { refreshPromise = undefined; });
        }
        await refreshPromise;
    }

    res.json(cachedStats);
});

module.exports = { router, PluginName, PluginRequirements, PluginVersion };
