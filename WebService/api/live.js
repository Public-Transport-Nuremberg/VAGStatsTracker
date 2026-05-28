const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
const { getLiveMapPayload, linequerySchema } = require('@lib/live_map');
const router = new HyperExpress.Router();

/* Plugin info*/
const PluginName = 'Live'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('all', limiter(), async (req, res) => {
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys("TRIP:", allTripKeys);

    res.status(200).json(allTripValues);
});

router.get('/map', limiter(), async (req, res) => {
    const query = await linequerySchema.validateAsync(req.query);
    res.status(200).json(await getLiveMapPayload(query, { validated: true }));
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};
