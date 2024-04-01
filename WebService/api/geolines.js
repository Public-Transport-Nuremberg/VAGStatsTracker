const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { plublicStaticCache } = require('@middleware/cacheRequest');
const Joi = require('joi');
const { openvgn } = require('oepnv-nuremberg');
const router = new HyperExpress.Router();

const vgn = new openvgn();

/* Plugin info*/
const PluginName = 'geoLines'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

const valid_lines = [ "4", "5", "6", "7", "8", "10", "11", "U1", "U2", "U3" ]

const lineSchema = Joi.object({
    line: Joi.string().custom((value, helpers) => {
        if (!valid_lines.includes(value)) {
            return helpers.error('any.invalid');
        }
        return value;
    }).required(),
});
// plublicStaticCache(60*1000) also not parameter aware
router.get('/:line', limiter(), async (req, res) => {
    const { line } = await lineSchema.validateAsync(req.params);
    const lineData = await vgn.geoLines(line);

    res.json(lineData.Cords);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};