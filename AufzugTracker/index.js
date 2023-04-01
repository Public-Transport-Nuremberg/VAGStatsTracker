require('dotenv').config();
require('module-alias/register');
const watchdog = require('@lib/watchdog');
const { log } = require('@lib/logger');

process.app = {};
process.app.watchdog = watchdog;
process.log = log;

const app = require('@src');