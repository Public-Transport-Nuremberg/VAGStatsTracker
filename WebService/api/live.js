const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
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

router.get('map', limiter(), async (req, res) => {
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys("TRIP:", allTripKeys);

    Object.entries(allTripValues).forEach(([key, trip]) => {
        // remove all entrys that have 0 as VGNKennung (Because its not populated yet)
        if (!trip || trip.VGNKennung === 0) {
            delete allTripValues[key];
        }

        const { Latitude, Longitude, Haltestellenname, Produkte } = StopObjectStore.get(trip.VGNKennung);
        allTripValues[key].Haltestellenname = Haltestellenname;
        allTripValues[key].Produkte = Produkte;
        allTripValues[key].Latitude = Latitude;
        allTripValues[key].Longitude = Longitude;
    });

    res.status(200).json(allTripValues);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};