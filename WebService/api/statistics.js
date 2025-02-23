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

const percentageSchema = Joi.object({
    outer_neg_bound: Joi.number().integer().min(-3600).max(3600).default(-900).optional(),
    outer_pos_bound: Joi.number().integer().min(-3600).max(3600).default(900).optional(),
    lower_inner_bound: Joi.number().integer().min(-3600).max(3600).default(-60).optional(),
    upper_inner_bound: Joi.number().integer().min(-3600).max(3600).default(180).optional(),
    years: Joi.number().integer().min(1).max(10).default(1).optional(),
});

/* Plugin info*/
const PluginName = 'Statisics'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('/lines', limiter(), async (req, res) => {
    res.json(Object.keys(linesWithStops));
});

router.get('/delay/avrage/line', limiter(), async (req, res) => {
    const value = await delayLineSchema.validateAsync(req.query);
    if (value.error) {
        throw new Error(value.error);
    }

    const result = await statistics.getAvgDelayByLine(value.line, value.days);

    res.json({station_order: linesWithStops[value.line], result});
});

router.get('/delay/percentage/week/product', limiter(), async (req, res) => {
    const value = await percentageSchema.validateAsync(req.query);
    if (value.error) {
        throw new Error(value.error);
    }

    const result = await statistics.percentageDelayByProductWeek(value.outer_neg_bound, value.outer_pos_bound, value.lower_inner_bound, value.upper_inner_bound, value.years);

    res.json(result);
});

router.get('/delay/percentage/month/product', limiter(), async (req, res) => {
    const value = await percentageSchema.validateAsync(req.query);
    if (value.error) {
        throw new Error(value.error);
    }

    const result = await statistics.percentageDelayByProductMonth(value.outer_neg_bound, value.outer_pos_bound, value.lower_inner_bound, value.upper_inner_bound, value.years);

    res.json(result);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};