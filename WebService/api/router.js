const express = require('ultimate-express');
const Joi = require('joi');
const { limiter } = require('@middleware/limiter');

const router = new express.Router();

const PluginName = 'Routing Engine';
const PluginRequirements = [];
const PluginVersion = '0.1.0';

const endpointSchema = Joi.alternatives().try(
    Joi.object({ stop_id: Joi.string().trim().min(1).max(200).required() }).required(),
    Joi.object({ station_id: Joi.alternatives().try(Joi.number().integer(), Joi.string().pattern(/^\d+$/)).required() }).required(),
    Joi.object({ VGNKennung: Joi.alternatives().try(Joi.number().integer(), Joi.string().pattern(/^\d+$/)).required() }).required(),
    Joi.object({ station_name: Joi.string().trim().min(1).max(200).required() }).required(),
    Joi.object({ Haltestellenname: Joi.string().trim().min(1).max(200).required() }).required()
);

const journeySchema = Joi.object({
    from: endpointSchema.required(),
    to: endpointSchema.required(),
    departure: Joi.string().isoDate().required(),
    profile: Joi.string().valid('fastest').default('fastest'),
    options: Joi.object({
        max_walk_seconds: Joi.number().integer().min(0).max(86400).default(900),
        max_transfers: Joi.number().integer().min(0).max(20).default(5),
        max_results: Joi.number().integer().min(1).max(10).default(5),
        allow_tight_transfers: Joi.boolean().default(false),
        products: Joi.array()
            .items(Joi.string().valid('bus', 'ubahn', 'tram', 'sbahn', 'rbahn'))
            .min(1)
            .unique()
            .optional(),
    }).default(),
}).required();

const routerUrl = (pathname) => {
    const configured = process.env.ROUTER_API_URL || 'http://127.0.0.1:8088';
    const base = new URL(configured);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new Error('ROUTER_API_URL must use http or https');
    }
    return new URL(pathname, `${base.origin}/`);
};

const timeoutMs = () => {
    const configured = Number(process.env.ROUTER_API_TIMEOUT_MS);
    return Number.isFinite(configured) ? Math.min(Math.max(configured, 1000), 60000) : 15000;
};

const sendUtf8Json = (res, status, value) => {
    res.status(status);
    res.set('Content-Type', 'application/json; charset=utf-8');
    return res.send(Buffer.from(JSON.stringify(value), 'utf8'));
};

const proxyJson = async (res, pathname, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs());

    try {
        const response = await fetch(routerUrl(pathname), {
            ...options,
            signal: controller.signal,
            headers: {
                accept: 'application/json',
                ...options.headers,
            },
        });
        const rawBody = await response.text();
        let body;
        try {
            body = rawBody ? JSON.parse(rawBody) : {};
        } catch {
            return res.status(502).json({ error: 'ROUTER_INVALID_RESPONSE' });
        }
        return sendUtf8Json(res, response.status, body);
    } catch (error) {
        const isTimeout = error.name === 'AbortError';
        process.log?.warn?.(`Routing Engine proxy failed: ${error.message}`);
        return res.status(isTimeout ? 504 : 503).json({
            error: isTimeout ? 'ROUTER_TIMEOUT' : 'ROUTER_UNAVAILABLE',
        });
    } finally {
        clearTimeout(timeout);
    }
};

router.get('/ready', async (req, res) => proxyJson(res, '/ready'));
router.get('/health', async (req, res) => proxyJson(res, '/health'));

router.post('/journeys', limiter(5), async (req, res) => {
    const request = await journeySchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: false,
    });
    return proxyJson(res, '/v1/journeys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
    });
});

module.exports = {
    router,
    PluginName,
    PluginRequirements,
    PluginVersion,
};
