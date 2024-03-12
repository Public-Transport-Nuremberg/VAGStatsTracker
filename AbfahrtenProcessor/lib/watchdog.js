const Watchdog = require('event-watchdog');

const watchdog = new Watchdog(parseInt(process.env.WATCHDOG_TIMEOUT, 10) || 60, 1, (function () { if (process.env.DEBUG === 'true' || process.env.DEBUG === true) { return true; } else { return false; } })());

watchdog.on('timeout', (data) => {
    const { monitor, offline_since } = data;
    process.log.error(`Watchdog timeout for monitor ${monitor} after ${new Date(offline_since).toLocaleString()}`);
    process.exit(1);
});

module.exports = watchdog;