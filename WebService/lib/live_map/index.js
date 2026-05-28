const { openvgn } = require('oepnv-nuremberg');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { findAllTripKeys, getValuesFromKeys } = require('@lib/redis');
const { linequerySchema } = require('./query_schema');

const vgn = new openvgn();

const getStop = (vgnKennung) => {
    try {
        return StopObjectStore.get(vgnKennung) || {};
    } catch (error) {
        process.log?.warning?.(`Failed to read stop ${vgnKennung}: ${error.message}`);
        return {};
    }
};

const enrichTrip = (trip) => {
    const currentStop = getStop(trip.VGNKennung);
    const nextStop = getStop(trip.nextVGNKennung);

    return {
        ...trip,
        Haltestellenname: currentStop.Haltestellenname,
        Produkte: currentStop.Produkte,
        Latitude: currentStop.Latitude,
        Longitude: currentStop.Longitude,
        StopLatitude: currentStop.Latitude,
        StopLongitude: currentStop.Longitude,
        nextHaltestellenname: nextStop.Haltestellenname,
        nextProdukte: nextStop.Produkte,
        nextLatitude: nextStop.Latitude,
        nextLongitude: nextStop.Longitude,
        FahrzeugInfo: vgn.getVehicleDataById(trip.Fahrzeugnummer),
    };
};

const getLiveMapPayload = async (query = {}, options = {}) => {
    const values = options.validated ? query : await linequerySchema.validateAsync(query);
    const lineFilter = values.Linie ? new Set(values.Linie.split(',')) : null;
    const allTripKeys = await findAllTripKeys();
    const allTripValues = await getValuesFromKeys('TRIP:', allTripKeys);
    const payload = {};

    Object.entries(allTripValues).forEach(([key, trip]) => {
        if (!trip || trip.VGNKennung === 0) return;
        if (lineFilter && !lineFilter.has(trip.Linienname)) return;

        payload[key] = enrichTrip(trip);
    });

    return payload;
};

module.exports = {
    getLiveMapPayload,
    linequerySchema,
};
