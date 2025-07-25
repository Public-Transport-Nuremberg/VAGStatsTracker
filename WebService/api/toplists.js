const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { plublicStaticCache } = require('@middleware/cacheRequest');
const performance = require('perf_hooks').performance;
const geolib = require('geolib');
const { views, vehicle } = require('@lib/postgres');
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

const atSchema = Joi.object({
    at: Joi.string().pattern(datePattern).message('Date must be in yyyy-mm-dd format'),
});

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

    if (value?.from || value?.to) {
        throw new Error('Not yet supported');
    }

    const queryStart = performance.now();
    let queryEnd = 0;
    let calcStart = 0;
    let calcEnd = 0;

    switch (list) {
        case 'by_stops':
            const result = await views.topList.delayByStops(value.at);
            for (let entry of result) {
                entry.haltestelleInfo = StopObjectStore.get(entry.vgnkennung);
            }
            queryEnd = performance.now();
            res.json({
                meta: {
                    queryTime: Math.floor(queryEnd - queryStart),
                    groupTime: 0,
                    calcTime: Math.floor(calcEnd - calcStart),
                    sortTime: 0,
                }, data: result
            });
            break;
        case 'by_lines':
            const result2 = await views.topList.delayByLines(value.at);
            queryEnd = performance.now();
            res.json({
                meta: {
                    queryTime: Math.floor(queryEnd - queryStart),
                    groupTime: 0,
                    calcTime: Math.floor(calcEnd - calcStart),
                    sortTime: 0,
                }, data: result2
            });
            break;
        case 'by_vehicles':
            const result3 = await views.topList.delayByVehicles(value.at);
            queryEnd = performance.now();

            calcStart = performance.now();
            for (let entry of result3) {
                entry.fahrzeugInfo = vgn.getVehicleDataById(entry.fahrzeugnummer);
            }
            calcEnd = performance.now();

            res.json({
                meta: {
                    queryTime: Math.floor(queryEnd - queryStart),
                    groupTime: 0,
                    calcTime: Math.floor(calcEnd - calcStart),
                    sortTime: 0,
                }, data: result3
            });
            break;
        default:
            throw new Error('Invalid query');
    }
});

router.get('/vehicle/distance/:at', limiter(), async (req, res) => {
    const value = await atSchema.validateAsync(req.params);
    if (value.error) {
        throw new Error(value.error);
    }

    const queryStart = performance.now();
    const result = await vehicle.allGPS(value.at);
    const queryEnd = performance.now();

    const groupStart = performance.now();
    const vehicleRoutes = {};
    result.forEach(row => {
        if (!vehicleRoutes[row.fahrzeugnummer]) {
            vehicleRoutes[row.fahrzeugnummer] = [];
        }
        vehicleRoutes[row.fahrzeugnummer].push({
            latitude: row.latitude,
            longitude: row.longitude,
        });
    });
    const groupEnd = performance.now();

    // Calculate total distance per Fahrzeugnummer
    const calcStart = performance.now();
    const distances = {};
    for (const fahrzeugnummer in vehicleRoutes) {
        let totalDistance = 0;
        const route = vehicleRoutes[fahrzeugnummer];

        for (let i = 1; i < route.length; i++) {
            totalDistance += geolib.getDistance(
                route[i - 1],
                route[i]
            );
        }

        distances[fahrzeugnummer] = totalDistance;
    }
    const calcEnd = performance.now();

    const sortStart = performance.now();
    // Sort by distance
    const sortedData = Object.keys(distances).map(fahrzeugnummer => {
        return {
            fahrzeugnummer,
            distance_m: distances[fahrzeugnummer],
        };
    }).sort((a, b) => b.distance_m - a.distance_m);
    const sortEnd = performance.now();

    res.json({
        meta: {
            queryTime: Math.floor(queryEnd - queryStart),
            groupTime: Math.floor(groupEnd - groupStart),
            calcTime: Math.floor(calcEnd - calcStart),
            sortTime: Math.floor(sortEnd - sortStart),
        }, data: sortedData
    });
});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};