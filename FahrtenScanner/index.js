require('dotenv').config();
require('module-alias/register');
const { log } = require('@lib/logger');
const { checkEnv } = require('@lib/dotENV');
const envSchema = require('./envSchema');

// Init logger
process.log = log;

// Check if all .env values are valid
const isENVok = checkEnv(envSchema);

if(isENVok) {
    process.log.error('Invalid ENV values. Please check your .env file and fix the above mentioned errors.');
    process.exit(1);
}

// Load more complex modules
const watchdog = require('@lib/watchdog');

// Prepare process.app
process.app = {};
process.app.watchdog = watchdog;

// Go application livecycle
//const app = require('@src');