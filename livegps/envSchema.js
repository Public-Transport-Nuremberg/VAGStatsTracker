const Joi = require('joi');

const envSchema = Joi.object({
    APPLICATION: Joi.string().default('livegps'),
    LOG_LEVEL: Joi.number().integer().min(0).max(4).default(2),
    LOG_TYPE: Joi.string().valid('console', 'stdout').default('console'),
    LOG_COLOR: Joi.boolean().default(false),
    CH_HOST: Joi.string().hostname().required(),
    CH_PORT: Joi.number().port().default(8123),
    CH_USER: Joi.string().default('default'),
    CH_PASSWORD: Joi.string().allow('').default(''),
    CH_DATABASE: Joi.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('vagstats'),
    REDIS_HOST: Joi.string().hostname().required(),
    REDIS_PORT: Joi.number().port().default(6379),
    REDIS_USER: Joi.string().allow('').default('default'),
    REDIS_PASSWORD: Joi.string().allow('').default(''),
    REDIS_DB: Joi.number().integer().min(0).default(0),
    LIVEGPS_SCAN_INTERVAL_MS: Joi.number().integer().min(1000).default(10000),
    LIVEGPS_FETCH_MODE: Joi.string().valid('all', 'tiles').default('all'),
    LIVEGPS_WEST: Joi.number().min(-180).max(180).default(8.9),
    LIVEGPS_SOUTH: Joi.number().min(-85).max(85).default(47.2),
    LIVEGPS_EAST: Joi.number().min(-180).max(180).default(13.9),
    LIVEGPS_NORTH: Joi.number().min(-85).max(85).default(50.6),
    LIVEGPS_TILE_SIZE_DEGREES: Joi.number().greater(0).max(0.5).default(0.5),
    LIVEGPS_TILE_DELAY_MS: Joi.number().integer().min(0).default(500),
    LIVEGPS_CACHE_TTL_SECONDS: Joi.number().integer().min(1).default(180),
    LIVEGPS_BATCH_SIZE: Joi.number().integer().min(1).max(10000).default(500),
    WATCHDOG_TIMEOUT: Joi.number().integer().min(1).max(600).default(60),
}).unknown(true);

function loadConfig(env = process.env) {
    const { value, error } = envSchema.validate(env, { abortEarly: false });
    if (error) throw new Error(`Invalid ENV: ${error.details.map(({ path, type }) => `${path.join('.')}: ${type}`).join('; ')}`);
    if (value.LIVEGPS_WEST >= value.LIVEGPS_EAST || value.LIVEGPS_SOUTH >= value.LIVEGPS_NORTH) {
        throw new Error('Invalid ENV: west must be less than east, south less than north');
    }
    // Avoid accidentally creating millions of tiles with a typo in the configuration.
    const tiles = Math.ceil((value.LIVEGPS_EAST - value.LIVEGPS_WEST) / value.LIVEGPS_TILE_SIZE_DEGREES)
        * Math.ceil((value.LIVEGPS_NORTH - value.LIVEGPS_SOUTH) / value.LIVEGPS_TILE_SIZE_DEGREES);
    if (value.LIVEGPS_FETCH_MODE === 'tiles' && tiles > 10000) throw new Error('Invalid ENV: more than 10000 tiles');
    return value;
}

module.exports = { envSchema, loadConfig };
