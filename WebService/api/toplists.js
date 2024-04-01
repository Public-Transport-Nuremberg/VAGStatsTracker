const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { plublicStaticCache } = require('@middleware/cacheRequest');
const { views } = require('@lib/postgres');
const Joi = require('joi');
const router = new HyperExpress.Router();
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { openvgn } = require('oepnv-nuremberg');
const vgn = new openvgn();

/* Plugin info*/
const PluginName = 'Toplist'; //This plugins name
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

const routeSchema = Joi.object({
    list: Joi.string().valid('by_stops', 'by_lines', 'by_vehicles').required(),
});

const validateWithDefault = async (input) => {
    if (Object.keys(input).length === 0) { input.at = getYesterdaysDate(); }
    return await schema.validateAsync(input);
}
//plublicStaticCache(60 * 1000) Make cache aware of the parameters used
router.get('/delay/:list', limiter(), async (req, res) => {
    const { list } = await routeSchema.validateAsync(req.params);
    const value = await validateWithDefault(req.query);
    if (value.error) {
        throw new Error(value.error);
    }

    if(value?.from || value?.to) {
        throw new Error('Not yet supported');
    }

    switch (list) {
        case 'by_stops':
            const result = await views.topList.delayByStops(value.at);
            for(let entry of result) {
                entry.haltestelleInfo = StopObjectStore.get(entry.vgnkennung);
            }
            res.json(result);
            break;
        case 'by_lines':
            const result2 = await views.topList.delayByLines(value.at);
            res.json(result2);
            break;
        case 'by_vehicles':
            const result3 = await views.topList.delayByVehicles(value.at);
            for(let entry of result3) {
                entry.fahrzeugInfo = vgn.getVehicleDataById(entry.fahrzeugnummer);
            }
            res.json(result3);
            break;
        default:
            throw new Error('Invalid query');
    }
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};