const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const { vehicle } = require('@lib/postgres');
const { openvgn } = require('oepnv-nuremberg');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
const router = new HyperExpress.Router();

const vgn = new openvgn();

const datePattern = /^(\d{4})\-(\d{2})\-(\d{2})$/;

const vehicleID = Joi.object({
    id: Joi.number().required(),
    at: Joi.string().pattern(datePattern).message('Date must be in yyyy-mm-dd format')
});

/* Plugin info*/
const PluginName = 'Live'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('/history/:at/:id', limiter(), async (req, res) => {
    const params = await vehicleID.validateAsync(req.params);

    const result = await vehicle.getHistory(params.id, params.at);

    res.json(result);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};