const express = require('ultimate-express');
const Joi = require('joi');
const { verifyRequest } = require('@middleware/verifyRequest');
const { getLogs, getStatus } = require('@lib/api_trace');
const {
    getRecording,
    getSharedRecording,
    listRecordings,
    startRecording,
    stopRecording,
} = require('@lib/api_trace/recordings');

const router = new express.Router();
const PluginName = 'API Trace';
const PluginRequirements = [];
const PluginVersion = '1.0.0';

const logsSchema = Joi.object({
    limit: Joi.number().integer().min(1).max(1000).default(250),
    after: Joi.number().integer().min(0).optional(),
});

const recordingSchema = Joi.object({
    hours: Joi.number().integer().min(1).max(24).required(),
});

router.get('/shared/:shareToken', async (req, res) => {
    res.json(await getSharedRecording(req.params.shareToken));
});

router.get('/status', verifyRequest('api.apiTrace.read'), async (req, res) => {
    res.json(await getStatus());
});

router.get('/logs', verifyRequest('api.apiTrace.read'), async (req, res) => {
    const query = await logsSchema.validateAsync(req.query);
    res.json({ logs: await getLogs(query) });
});

router.get('/recordings', verifyRequest('api.apiTrace.read'), async (req, res) => {
    res.json({ recordings: await listRecordings() });
});

router.post('/recordings', verifyRequest('api.apiTrace.write'), async (req, res) => {
    const { hours } = await recordingSchema.validateAsync(req.body);
    res.status(201).json(await startRecording(hours));
});

router.post('/recordings/stop', verifyRequest('api.apiTrace.write'), async (req, res) => {
    res.json(await stopRecording());
});

router.get('/recordings/:id', verifyRequest('api.apiTrace.read'), async (req, res) => {
    const payload = await getRecording(req.params.id);
    if (req.query.download === '1') {
        res.header('Content-Disposition', `attachment; filename="api-trace-${req.params.id}.json"`);
    }
    res.json(payload);
});

module.exports = {
    router,
    PluginName,
    PluginRequirements,
    PluginVersion,
};
