function createLogger(config) {
    const names = ['error', 'warning', 'info', 'debug', 'system'];
    const colors = [31, 33, 32, 35, 36];
    const log = {};
    names.forEach((name, index) => {
        log[name] = (message) => {
            if (index > config.LOG_LEVEL) return;
            const label = config.LOG_COLOR ? `\x1b[${colors[index]}m[${name.toUpperCase()}]\x1b[0m` : `[${name.toUpperCase()}]`;
            const line = `[${config.APPLICATION}] [${new Date().toISOString()}] ${label} ${message}`;
            if (config.LOG_TYPE === 'stdout') process.stdout.write(`${line}\n`);
            else if (index === 0) console.error(line);
            else if (index === 1) console.warn(line);
            else console.log(line);
        };
    });
    log.warn = log.warning;
    return log;
}

module.exports = { createLogger };
