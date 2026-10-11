const express = require('ultimate-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const { vehicle } = require('@lib/clickhouse');
const { openvgn } = require('oepnv-nuremberg');
const { traceVgnClient } = require('@lib/api_trace');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
const router = new express.Router();
const { gpsHistorySchema } = require('@lib/live_gps');

const vgn = traceVgnClient(new openvgn());

const datePattern = /^(\d{4})\-(\d{2})\-(\d{2})$/;

const vehicleID = Joi.object({
    id: Joi.number().required(),
    at: Joi.string().pattern(datePattern).message('Date must be in yyyy-mm-dd format')
});

/* Plugin info*/
const PluginName = 'Live'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('/gps/history/:at/:id', limiter(), async (req, res) => {
    // Ultimate Express retains percent escapes in route parameters (query strings are decoded).
    let id;
    try { id = decodeURIComponent(req.params.id); }
    catch { return res.status(400).json({ message: 'Invalid encoded vehicle identifier' }); }
    const params = await gpsHistorySchema.validateAsync({ ...req.query, ...req.params, id });
    res.json(await vehicle.getGpsHistory(params));
});

router.get('/history/:at/:id', limiter(), async (req, res) => {
    const params = await vehicleID.validateAsync(req.params);

    const result = await vehicle.getHistory(params.id, params.at);

    res.json(result);
});

router.get('/servedStops/:at/:id', limiter(), async (req, res) => {
    const params = await vehicleID.validateAsync(req.params);

    const result = await vehicle.servedStopsByVehicleIDandDay(params.id, params.at);

    res.json(result);
});

router.get('/servedLines/:at/:id', limiter(), async (req, res) => {
    const params = await vehicleID.validateAsync(req.params);

    const result = await vehicle.servedLinesByVehicleIDandDay(params.id, params.at);

    res.json(result);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};
