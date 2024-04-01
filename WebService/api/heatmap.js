const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { plublicStaticCache } = require('@middleware/cacheRequest');
const { heatmap } = require('@lib/postgres');
const Joi = require('joi');
const router = new HyperExpress.Router();

/* Plugin info*/
const PluginName = 'Heatmap'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

const datePattern = /^(\d{4})\-(\d{2})\-(\d{2})$/;

const getYesterdaysDate = () => {
    const date = new Date();
    date.setDate(date.getDate() - 1);

    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();

    return `${yyyy}-${mm}-${dd}`;
}

const schema = Joi.object({
    at: Joi.string().pattern(datePattern).message('Date must be in yyyy-mm-dd format'),
    from: Joi.string().pattern(datePattern).message('Date must be in yyyy-mm-dd format'),
    to: Joi.string().pattern(datePattern).message('Date must be in yyyy-mm-dd format'),
}).xor('at', 'from').with('from', 'to').without('at', ['from', 'to']);

const validateWithDefault = (input) => {
    if (Object.keys(input).length === 0) { input.at = getYesterdaysDate(); }
    return schema.validate(input);
}
//plublicStaticCache(60 * 1000) Make cache aware of the parameters used
router.get('/', limiter(), async (req, res) => {
    const value = validateWithDefault(req.query);
    if (value.error) {
        throw new Error(value.error);
    }

    if(value.value.at) {
        const result = await heatmap.getDay(value.value.at);
        res.json(result);
    } else if (value.value.from && value.value.to) {
        const result = await heatmap.getTimeFrame(value.value.from, value.value.to);
        res.json(result);
    } else {
        throw new Error('Invalid query');
    }
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};