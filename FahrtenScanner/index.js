require('dotenv').config();
require('module-alias/register');
const { log } = require('@lib/logger');
const { checkEnv } = require('@lib/dotENV');
const envSchema = require('./envSchema');
const joi = require('joi');

checkEnv(envSchema);

//const watchdog = require('@lib/watchdog');

process.app = {};
//process.app.watchdog = watchdog;

process.log = log;

//const app = require('@src');