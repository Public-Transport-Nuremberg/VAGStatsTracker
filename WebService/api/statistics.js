const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const linesWithStops = require('@config/linesWithStops');
const { statistics } = require('@lib/postgres');
const Joi = require('joi');
const router = new HyperExpress.Router();

const delayLineSchema = Joi.object({
    line: Joi.string().regex(/^[a-zA-Z0-9]+$/).required(),
    days: Joi.number().integer().min(1).max(365).default(7).optional(),
});

/* Plugin info*/
const PluginName = 'Statisics'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('/lines', limiter(), async (req, res) => {
    res.json(Object.keys(linesWithStops));
});

router.get('/delay/line', limiter(), async (req, res) => {
    const value = await delayLineSchema.validateAsync(req.query);
    if (value.error) {
        throw new Error(value.error);
    }

    const result = await statistics.getAvgDelayByLine(value.line, value.days);

    res.json({station_order: linesWithStops[value.line], result});
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};