const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const Joi = require('joi');
const { openvgn } = require('oepnv-nuremberg');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const router = new HyperExpress.Router();

const vgn = new openvgn();

/* Plugin info*/
const PluginName = 'Departures';
const PluginRequirements = [];
const PluginVersion = '0.0.1';

const departureOptionsSchema = {
    Line: Joi.string().trim().max(16).optional(),
    Product: Joi.string().valid('UBahn', 'Tram', 'Bus').optional(),
    TimeSpan: Joi.number().integer().min(1).max(1440).optional(),
    TimeDelay: Joi.number().integer().min(0).max(1440).optional(),
    LimitCount: Joi.number().integer().min(1).max(100).default(30).optional(),
};

const stationSchema = Joi.object({
    VGNKennung: Joi.number().integer().optional(),
    VAGKennung: Joi.string().trim().optional(),
    ...departureOptionsSchema,
}).xor('VGNKennung', 'VAGKennung');

const closestSchema = Joi.object({
    Latitude: Joi.number().min(-90).max(90).required(),
    Longitude: Joi.number().min(-180).max(180).required(),
    Radius: Joi.number().min(1).max(40 * 1000 * 1000).default(500).optional(),
    ...departureOptionsSchema,
});

const tripParamsSchema = Joi.object({
    product: Joi.string().trim().max(32).required(),
    fahrtnummer: Joi.number().integer().required(),
});

const tripQuerySchema = Joi.object({
    Betriebstag: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const getInfoValue = (info, keys) => {
    for (const key of keys) {
        if (info?.[key] !== undefined && info[key] !== null && info[key] !== '') return info[key];
    }
    return null;
};

const countAccessibleDoors = (info) => {
    const doorCount = Number(info?.anzahl_tueren || info?.AnzahlTueren || 0);
    let accessibleDoors = 0;

    for (let i = 1; i <= Math.min(Math.max(doorCount, 0), 12); i++) {
        if (info[`tuer_${i}_mit_aufstellflaeche`] === true || info[`tuer_${i}_mit_aufstellflaeche`] === 'ja') {
            accessibleDoors += 1;
        }
    }

    return accessibleDoors || null;
};

const buildFeatureData = (departure) => {
    const info = departure?.Fahrzeug || {};
    const airConditioning = getInfoValue(info, ['Klimatisierung']);
    const fuelType = getInfoValue(info, ['Kraftstoffart']);
    const wheelchairSpaces = getInfoValue(info, ['Rollstuhlplaetze', 'Rollstuhlplatze']);
    const accessibleDoors = countAccessibleDoors(info);

    return {
        airConditioning,
        fuelType,
        wheelchairSpaces,
        accessibleDoors,
        vehicleInfo: departure?.FahrzeugInfo || null,
    };
};

const withFeatureData = (departures = []) => departures.map((departure) => ({
    ...departure,
    FeatureData: buildFeatureData(departure),
}));

const getStationByVagId = (vagKennung) => {
    const query = { VAGKennung: `%${vagKennung}%` };
    return StopObjectStore.filterByQuery(query)[0] || {};
};

const getStation = ({ VGNKennung, VAGKennung }) => {
    if (VGNKennung) return StopObjectStore.get(VGNKennung);
    return getStationByVagId(VAGKennung);
};

const getPreferredDepartureTarget = (value, station) => {
    return station?.VGNKennung || value.VGNKennung || value.VAGKennung;
};

const getDepartureOptions = (value) => Object.fromEntries(Object.entries({
    Line: value.Line,
    Product: value.Product,
    TimeSpan: value.TimeSpan,
    TimeDelay: value.TimeDelay,
    LimitCount: value.LimitCount,
}).filter(([, optionValue]) => optionValue !== undefined && optionValue !== null && optionValue !== ''));

const getStationDepartures = async (value) => {
    const station = getStation(value);
    const target = getPreferredDepartureTarget(value, station);
    const data = await vgn.getDepartures(String(target), getDepartureOptions(value));

    if (data instanceof Error) throw data;
    if (data?.code) {
        const error = new Error(data.message || 'Departure API failed');
        error.status = data.code;
        throw error;
    }

    return {
        ...data,
        Station: station,
        Departures: withFeatureData(data.Departures),
    };
};

router.get('/station', limiter(), async (req, res) => {
    const value = await stationSchema.validateAsync(req.query);
    res.json(await getStationDepartures(value));
});

router.get('/closest', limiter(), async (req, res) => {
    const value = await closestSchema.validateAsync(req.query);
    const nearbyStations = StopObjectStore.findNearbyStations({
        Latitude: value.Latitude,
        Longitude: value.Longitude,
    }, value.Radius).sort((a, b) => a.distanz - b.distanz);

    if (nearbyStations.length === 0) {
        res.status(404).json({
            message: 'No station found',
            info: `No station found within ${value.Radius}m`,
            reason: 'Radius',
        });
        return;
    }

    const closestStation = nearbyStations[0];
    const data = await getStationDepartures({
        ...value,
        VGNKennung: closestStation.VGNKennung,
    });

    res.json({
        ...data,
        Station: closestStation,
        NearbyStations: nearbyStations.slice(0, 5),
    });
});

router.get('/trip/:product/:fahrtnummer', limiter(), async (req, res) => {
    const params = await tripParamsSchema.validateAsync(req.params);
    const query = await tripQuerySchema.validateAsync(req.query);
    const data = await vgn.getTrip(params.fahrtnummer, {
        product: params.product,
        date: query.Betriebstag,
    });

    if (data instanceof Error) throw data;
    if (data?.code) {
        const error = new Error(data.message || 'Trip API failed');
        error.status = data.code;
        throw error;
    }

    res.json(data);
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};
