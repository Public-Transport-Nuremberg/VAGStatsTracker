const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const crypto = require('crypto');
const { observe } = require('@lib/clickhouse');
const router = new HyperExpress.Router();

/* Plugin info*/
const PluginName = 'Observe';
const PluginRequirements = [];
const PluginVersion = '0.0.1';

const temperatureSchema = Joi.object({
    timestamp: Joi.date().iso().required(),
    device: Joi.string().trim().min(1).max(128).required(),
    sequence: Joi.number().integer().min(0).max(255).required(),
    block_identifier: Joi.string().trim().max(32).required(),
    rail_temperature: Joi.number().integer().min(0).max(255).required(),
    ambient_temperature: Joi.number().integer().min(0).max(255).required(),
    raw_telegram: Joi.string().trim().max(1024).required(),
    secret: Joi.string().optional().strip(),
});

const latestSchema = Joi.object({
    device: Joi.string().trim().min(1).max(128).optional(),
    secret: Joi.string().optional().strip(),
});

const safeEquals = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;

    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const getProvidedSecret = (req, body = {}) => {
    const authorization = req.headers['authorization'];
    if (authorization?.toLowerCase().startsWith('bearer ')) return authorization.slice(7);

    return req.headers['x-observe-secret']
        || req.query.secret
        || body?.secret;
}

const requireObserveSecret = (req, body) => {
    const expectedSecret = process.env.OBSERVE_SECRET;
    if (!expectedSecret) {
        const error = new Error('OBSERVE_SECRET is not configured');
        error.status = 500;
        throw error;
    }

    const providedSecret = getProvidedSecret(req, body);
    if (!safeEquals(providedSecret, expectedSecret)) {
        const error = new Error('Invalid observe secret');
        error.status = 401;
        throw error;
    }
}

const parseJsonBody = async (req) => {
    try {
        return await req.json(null);
    } catch {
        const error = new Error('Invalid JSON body');
        error.status = 400;
        throw error;
    }
}

router.post('/temperature', limiter(), async (req, res) => {
    const body = await parseJsonBody(req);
    requireObserveSecret(req, body);

    const value = await temperatureSchema.validateAsync(body, { stripUnknown: true });
    await observe.insertTemperature(value);

    res.status(201).json({
        ok: true,
        timestamp: value.timestamp.toISOString(),
        device: value.device,
    });
});

router.get('/latest', limiter(), async (req, res) => {
    requireObserveSecret(req);

    const value = await latestSchema.validateAsync(req.query, { stripUnknown: true });
    const latest = await observe.getLatestTemperature(value.device);

    if (!latest) {
        res.status(404).json({
            message: 'No observation found',
            info: value.device ? `No observation found for ${value.device}` : 'No observation has been stored yet',
            reason: 'Empty',
        });
        return;
    }

    res.json(latest);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};
