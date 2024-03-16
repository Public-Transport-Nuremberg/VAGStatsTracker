const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
const router = new HyperExpress.Router();

/* Plugin info*/
const PluginName = 'Trips'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

router.get('', limiter(), async (req, res) => {
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys("TRIP:", allTripKeys);

    console.log(allTripKeys, allTripValues);

    res.status(200).json(allTripValues);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};