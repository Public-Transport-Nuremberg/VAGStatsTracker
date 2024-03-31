const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const { openvgn } = require('oepnv-nuremberg');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
const router = new HyperExpress.Router();

const vgn = new openvgn();

/* Plugin info*/
const PluginName = 'Live'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

// Kinda expesive, but should work
const linequerySchema = Joi.object({
    Linie: Joi.string().custom((value, helpers) => {
        const parts = value.split(',');
        for (let part of parts) {
            if (!/^[A-Z0-9]+$/i.test(part)) {
                return helpers.error('any.invalid');
            }
        }
        return value;
    }),
});

router.get('all', limiter(), async (req, res) => {
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys("TRIP:", allTripKeys);

    res.status(200).json(allTripValues);
});

router.get('/map', limiter(), async (req, res) => {
    const values = await linequerySchema.validateAsync(req.query);
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys("TRIP:", allTripKeys);

    // Delete keys we dont want
    Object.entries(allTripValues).forEach(([key, trip]) => {
        if (values.Linie) {
            if (!values.Linie.split(',').includes(allTripValues[key].Linienname)) {
                delete allTripValues[key];
            }
        }
        // remove all entrys that have 0 as VGNKennung (Because its not populated yet)
        if (!trip || trip.VGNKennung === 0) {
            delete allTripValues[key];
        }
    });

    Object.entries(allTripValues).forEach(([key, trip]) => {
        const { Latitude, Longitude, Haltestellenname, Produkte } = StopObjectStore.get(trip.VGNKennung);
        allTripValues[key].Haltestellenname = Haltestellenname;
        allTripValues[key].Produkte = Produkte;
        allTripValues[key].Latitude = Latitude;
        allTripValues[key].Longitude = Longitude;
    });

    Object.entries(allTripValues).forEach(([key, trip]) => {
        const { Latitude, Longitude, Haltestellenname, Produkte } = StopObjectStore.get(trip.nextVGNKennung);
        allTripValues[key].nextHaltestellenname = Haltestellenname;
        allTripValues[key].nextProdukte = Produkte;
        allTripValues[key].nextLatitude = Latitude;
        allTripValues[key].nextLongitude = Longitude;

        allTripValues[key].FahrzeugInfo = vgn.getVehicleDataById(trip.Fahrzeugnummer);
    });

    res.status(200).json(allTripValues);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};