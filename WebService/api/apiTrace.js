const express = require('ultimate-express');
const Joi = require('joi');
const { verifyRequest } = require('@middleware/verifyRequest');
const { getLogs, getStatus, setEnabled } = require('@lib/api_trace');

const router = new express.Router();
const PluginName = 'API Trace';
const PluginRequirements = [];
const PluginVersion = '1.0.0';

const statusSchema = Joi.object({
    enabled: Joi.boolean().required(),
});

const logsSchema = Joi.object({
    limit: Joi.number().integer().min(1).max(1000).default(250),
    after: Joi.number().integer().min(0).optional(),
});

router.get('/status', verifyRequest('api.apiTrace.read'), async (req, res) => {
    res.json(await getStatus());
});

router.post('/status', verifyRequest('api.apiTrace.write'), async (req, res) => {
    const { enabled } = await statusSchema.validateAsync(req.body);
    res.json(await setEnabled(enabled));
});

router.get('/logs', verifyRequest('api.apiTrace.read'), async (req, res) => {
    const query = await logsSchema.validateAsync(req.query);
    res.json({ logs: await getLogs(query) });
});

module.exports = {
    router,
    PluginName,
    PluginRequirements,
    PluginVersion,
};
