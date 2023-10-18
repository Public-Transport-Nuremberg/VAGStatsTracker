require('dotenv').config();
require('module-alias/register');
const { log } = require('@lib/logger');
const fs = require('node:fs');
const { checkEnv, genEnv } = require('dotenv-joi');
const envSchema = require('./envSchema');

// Init logger
process.log = log;

if (fs.existsSync('.env')) {
    // Check if all .env values are valid
    const isENVok = checkEnv(envSchema);
    if (isENVok) {
        process.log.error('Invalid ENV values. Please check your .env file and fix the above mentioned errors.');
        process.exit(1);
    }
} else {
    const envFile = genEnv(envSchema);
    fs.writeFileSync('.env', envFile);
    process.log.error('No .env file found. A new one has been generated. Please fill it with your values and restart the application.');
    process.exit(1);
}

// Load more complex modules
const watchdog = require('@lib/watchdog');

// Prepare process.app
process.app = {};
process.app.watchdog = watchdog;

// Go application livecycle
//const app = require('@src');