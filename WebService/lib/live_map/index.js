const { openvgn } = require('oepnv-nuremberg');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const {
    getIndexedTripValues,
    getTripValuesInBoundingBox,
    updateTripLocations,
} = require('@lib/redis');
const { live } = require('@lib/clickhouse');
const { calculateTripProgress, estimateGpsPosition } = require('./estimated_gps');
const { linequerySchema } = require('./query_schema');

const vgn = new openvgn();
let positionWorkerTimer = null;
let positionWorkerRunning = false;

const getStop = (vgnKennung) => {
    if (vgnKennung === null || vgnKennung === undefined) return {};
    try {
        return StopObjectStore.get(vgnKennung) || {};
    } catch (error) {
        process.log?.warn?.(`Failed to read stop ${vgnKennung}: ${error.message}`);
        return {};
    }
};

const getTripLivePosition = async (trip, now = Date.now()) => {
    const currentStop = getStop(trip.VGNKennung);
    const nextStop = getStop(trip.nextVGNKennung);
    const progress = calculateTripProgress(trip, now);
    const EstimatedGPS = await estimateGpsPosition(
        vgn,
        trip.Linienname,
        currentStop,
        nextStop,
        progress
    );

    return { currentStop, nextStop, progress, EstimatedGPS };
};

const enrichTrip = async (trip, now) => {
    const { currentStop, nextStop, progress, EstimatedGPS } = await getTripLivePosition(trip, now);

    return {
        ...trip,
        PercentageToNextStop: progress,
        EstimatedGPS,
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

const getDisplayPosition = (trip) => trip.EstimatedGPS || {
    Latitude: trip.StopLatitude,
    Longitude: trip.StopLongitude,
};

const isInsideBoundingBox = (trip, boundingBox) => {
    if (!boundingBox) return true;
    const position = getDisplayPosition(trip);
    const latitude = Number(position?.Latitude);
    const longitude = Number(position?.Longitude);
    return Number.isFinite(latitude)
        && Number.isFinite(longitude)
        && longitude >= boundingBox.minLongitude
        && longitude <= boundingBox.maxLongitude
        && latitude >= boundingBox.minLatitude
        && latitude <= boundingBox.maxLatitude;
};

const refreshLiveTripLocations = async () => {
    if (positionWorkerRunning) return 0;
    positionWorkerRunning = true;

    try {
        const trips = await getIndexedTripValues();
        const now = Date.now();
        const locations = await Promise.all(Object.entries(trips).map(async ([tripId, trip]) => {
            const { currentStop, EstimatedGPS } = await getTripLivePosition(trip, now);
            const position = EstimatedGPS || currentStop;
            return {
                tripId,
                latitude: position?.Latitude,
                longitude: position?.Longitude,
            };
        }));
        return updateTripLocations(locations);
    } finally {
        positionWorkerRunning = false;
    }
};

const startLiveMapPositionWorker = () => {
    if (positionWorkerTimer) return;

    const configuredInterval = Number(process.env.LIVE_MAP_POSITION_INTERVAL_MS);
    const interval = Number.isFinite(configuredInterval) && configuredInterval > 0
        ? configuredInterval
        : 1000;
    const refresh = () => {
        void refreshLiveTripLocations().catch((error) => {
            process.log?.error?.(`Failed to refresh live trip positions: ${error.stack || error}`);
            if (process.env.SENTRY_DSN) process.sentry?.captureException(error);
        });
    };

    refresh();
    positionWorkerTimer = setInterval(refresh, interval);
    positionWorkerTimer.unref?.();
};

const getLiveMapPayload = async (query = {}, options = {}) => {
    const values = options.validated ? query : await linequerySchema.validateAsync(query);
    const lineFilter = values.Linie ? new Set(values.Linie.split(',')) : null;
    const allTripValues = values.boundingBox
        ? await getTripValuesInBoundingBox(values.boundingBox)
        : await getIndexedTripValues();
    const payload = {};
    const now = Date.now();

    const enrichedTrips = await Promise.all(Object.entries(allTripValues).map(async ([key, trip]) => {
        if (!trip || trip.VGNKennung === 0) return null;
        if (lineFilter && !lineFilter.has(trip.Linienname)) return null;

        const enrichedTrip = await enrichTrip(trip, now);
        if (!isInsideBoundingBox(enrichedTrip, values.boundingBox)) return null;
        return [key, enrichedTrip];
    }));

    for (const entry of enrichedTrips) {
        if (entry) payload[entry[0]] = entry[1];
    }

    payload.__meta = {
        cancelledToday: await live.getCancelledTripsToday(),
    };

    return payload;
};

module.exports = {
    calculateTripProgress,
    getLiveMapPayload,
    linequerySchema,
    refreshLiveTripLocations,
    startLiveMapPositionWorker,
};
