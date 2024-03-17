const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const router = new HyperExpress.Router();

/* Plugin info*/
const PluginName = 'Stops'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

const stopquerySchema = Joi.object({
    Haltestellenname: Joi.string().optional(),
    VGNKennung: Joi.number().integer().optional(),
    VAGKennung: Joi.string().optional(),
    Latitude: Joi.number().min(-180).max(180).optional(),
    Longitude: Joi.number().min(-180).max(180).optional(),
    Produkte: Joi.string().optional()
});

const locationquerySchema = Joi.object({
    Latitude: Joi.number().min(-180).max(180).required(),
    Longitude: Joi.number().min(-180).max(180).required(),
    Radius: Joi.number().min(0).max(40 * 1000 * 1000).default(500).optional(),
});

router.get('/search', async (req, res) => {
    const value = await stopquerySchema.validateAsync(req.query);
    const filteredResults = StopObjectStore.filterByQuery(value);

    res.json(filteredResults);
});

router.get('/location', async (req, res) => {
    const { Latitude, Longitude, Radius } = await locationquerySchema.validateAsync(req.query);
    const results = StopObjectStore.findNearbyStations({Latitude, Longitude}, Radius);

    res.json(results);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};