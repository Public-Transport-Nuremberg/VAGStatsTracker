const Watchdog = require('event-watchdog');

const watchdog = new Watchdog(parseInt(process.env.SCAN_INTERVAL, 10) * 60 * 1000, 1, (function () { if (process.env.DEBUG === 'true' || process.env.DEBUG === true) { return true; } else { return false; } })());

process.env.PRODUCTS.split(',').forEach(async (product) => {
    watchdog.addMonitor(product);
});

watchdog.on('timeout', (data) => {
    const { monitor, offline_since } = data;
    process.log.error(`Watchdog timeout for monitor ${monitor} after ${new Date(offline_since)}`);
    process.exit(1);
});

module.exports = watchdog;