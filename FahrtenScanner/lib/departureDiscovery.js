const {
    claimDueDepartureDiscoveryStop,
    getDepartureDiscoveryRequest,
    getDepartureDiscoveryRequiredStopIds,
    getKnownTripStopIds,
    markDepartureDiscoveryRequired,
    recordDepartureDiscoveryRequest,
    setDepartureDiscoveryScheduledAt,
    updateDepartureDiscoveryPlan,
    writeNewDatapoint,
    writeNewDatapointKey,
} = require('@lib/redis');
const { traceFetch } = require('@lib/apiTrace');

const STOPS_URL = 'https://start.vag.de/dm/api/haltestellen.json/vgn?name=';
const STOPS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
let cachedStops = null;
let stopsCachedAt = 0;
let workerStarted = false;
let workerContext = null;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizeProduct = (product) => String(product || '').replace(/[\s-]/g, '').toLowerCase();
const normalizeStopCode = (stopCode) => String(stopCode || '').split(':')[0].trim().toUpperCase();

const getConfiguredNumber = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getAllStops = async () => {
    if (cachedStops && Date.now() - stopsCachedAt < STOPS_CACHE_TTL_MS) return cachedStops;
    const response = await traceFetch('FahrtenScanner', STOPS_URL);
    if (!response.ok) throw new Error(`Stops API failed with status ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.Haltestellen)) throw new Error('Stops API returned no Haltestellen array');
    cachedStops = payload.Haltestellen;
    stopsCachedAt = Date.now();
    return cachedStops;
};

const stopMatchesProducts = (stop, configuredProducts) => {
    const stopProducts = String(stop.Produkte || '').split(',').map(normalizeProduct);
    return configuredProducts.some((product) => stopProducts.includes(normalizeProduct(product)));
};

const stopIsMentioned = (stop, mentionedStopCodes) => String(stop.VAGKennung || '')
    .split(',').map(normalizeStopCode).some((stopCode) => mentionedStopCodes.has(stopCode));

const selectDiscoveryCandidates = (
    allStops,
    configuredProducts,
    mentionedStopCodes,
    knownTripStopIds,
    requiredStopIds = new Set()
) => allStops.filter((stop) => requiredStopIds.has(String(stop.VGNKennung))
    || !knownTripStopIds.has(String(stop.VGNKennung)));

const getLastDepartureTimestamp = (departures) => departures.reduce((latest, departure) => {
    // The API's TimeSpan is timetable-based. Prefer Soll so a delayed vehicle cannot create a polling gap.
    const timestamp = ['AbfahrtszeitSoll', 'AbfahrtszeitIst'].reduce((result, field) => {
        if (Number.isFinite(result)) return result;
        const parsed = departure[field] ? new Date(departure[field]).getTime() : Number.NaN;
        return Number.isFinite(parsed) ? parsed : result;
    }, Number.NaN);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
}, Number.NEGATIVE_INFINITY);

const getNextRequest = (departures, previousRequest, requestedTimeSpan, now = Date.now()) => {
    if (departures.length > 0) {
        const lastDepartureAt = getLastDepartureTimestamp(departures);
        return {
            schedulerMode: 'normal',
            nextTimeSpan: getConfiguredNumber('DEPARTURE_DISCOVERY_TIMESPAN_MINUTES', 10),
            nextScheduledAt: Number.isFinite(lastDepartureAt) ? Math.max(lastDepartureAt, now + 1000) : now + (10 * MINUTE_MS),
            lastDepartureAt: Number.isFinite(lastDepartureAt) ? new Date(lastDepartureAt).toISOString() : null,
            invalidDepartureTimes: !Number.isFinite(lastDepartureAt),
        };
    }

    const sparseTimeSpan = getConfiguredNumber('DEPARTURE_DISCOVERY_EMPTY_TIMESPAN_MINUTES', 60);
    const wasWideEmptyRequest = requestedTimeSpan >= sparseTimeSpan
        || previousRequest?.schedulerMode === 'empty-retry'
        || previousRequest?.schedulerMode === 'sparse';
    return {
        schedulerMode: wasWideEmptyRequest ? 'sparse' : 'empty-retry',
        nextTimeSpan: sparseTimeSpan,
        nextScheduledAt: now + ((wasWideEmptyRequest ? 60 : 10) * MINUTE_MS),
        lastDepartureAt: null,
        invalidDepartureTimes: false,
    };
};

const syncDepartureDiscoveryCandidates = async (configuredProducts, mentionedStopCodes, knownTripIds) => {
    const enabled = String(process.env.DEPARTURE_DISCOVERY_ENABLED || 'true').toLowerCase() === 'true';
    if (!enabled) {
        workerContext = null;
        await updateDepartureDiscoveryPlan({
            candidates: [], mentionedStopIds: [], state: { enabled: false, updatedAt: new Date().toISOString() },
        });
        return;
    }

    const allStops = await getAllStops();
    const [knownTripStopIds, requiredStopIds] = await Promise.all([
        getKnownTripStopIds(),
        getDepartureDiscoveryRequiredStopIds(),
    ]);
    const candidates = selectDiscoveryCandidates(
        allStops,
        configuredProducts,
        mentionedStopCodes,
        knownTripStopIds,
        requiredStopIds
    );
    const seededAt = Date.now();
    const maximumScheduledAt = seededAt + (60 * MINUTE_MS);
    const mentionedStopIds = allStops.filter((stop) => stopIsMentioned(stop, mentionedStopCodes))
        .map((stop) => stop.VGNKennung);

    workerContext = {
        ...workerContext,
        configuredProducts,
        knownTripIds: new Set([...knownTripIds].map(String)),
    };
    await updateDepartureDiscoveryPlan({
        candidates: candidates.map((stop) => stop.VGNKennung),
        mentionedStopIds,
        initialSchedule: candidates.map((stop) => ({
            stopId: stop.VGNKennung, timestamp: seededAt,
        })),
        maximumScheduledAt,
        state: {
            enabled: true,
            scheduler: 'per-stop',
            updatedAt: new Date().toISOString(),
            candidateSource: 'unlearned-stops',
            configuredProducts,
            normalTimeSpanMinutes: getConfiguredNumber('DEPARTURE_DISCOVERY_TIMESPAN_MINUTES', 10),
            emptyTimeSpanMinutes: getConfiguredNumber('DEPARTURE_DISCOVERY_EMPTY_TIMESPAN_MINUTES', 60),
            totalStops: allStops.length,
            knownTripStops: knownTripStopIds.size,
            mentionedStops: mentionedStopIds.length,
            candidates: candidates.length,
            requiredDiscoveryStops: requiredStopIds.size,
            candidatesWithoutConfiguredProducts: candidates
                .filter((stop) => !stopMatchesProducts(stop, configuredProducts)).length,
        },
    });
    await writeNewDatapointKey('METRIC:DepartureDiscovery.Candidates', candidates.length);
    await writeNewDatapointKey('METRIC:DepartureDiscovery.KnownTripStops', knownTripStopIds.size);
    process.log.info(`Departure discovery synced ${candidates.length} unlearned stop candidates`);
};

const processDueStop = async (stopId) => {
    const context = workerContext;
    if (!context?.vgn) return;
    const previousRequest = await getDepartureDiscoveryRequest(stopId);
    const normalTimeSpan = getConfiguredNumber('DEPARTURE_DISCOVERY_TIMESPAN_MINUTES', 10);
    const requestedTimeSpan = Number(previousRequest?.nextTimeSpan) || normalTimeSpan;
    const requestedAt = Date.now();
    await recordDepartureDiscoveryRequest(stopId, {
        ...previousRequest,
        state: 'running',
        schedulerMode: previousRequest?.schedulerMode || 'normal',
        requestedTimeSpan,
        requestedAt: new Date(requestedAt).toISOString(),
    });

    let response;
    try {
        response = await context.vgn.getDepartures(stopId, {
            Product: context.configuredProducts.join(','), TimeSpan: requestedTimeSpan,
        });
    } catch (error) {
        response = error;
    }

    if (!response || !Array.isArray(response.Departures)) {
        const statusCode = response?.code || 500;
        const retryAt = Date.now() + (10 * MINUTE_MS);
        writeNewDatapoint('ERRORLIST:DepartureDiscovery.Statuscode', statusCode);
        process.log.warn(`Departure discovery failed for stop ${stopId} (${statusCode})`);
        await recordDepartureDiscoveryRequest(stopId, {
            ...previousRequest,
            state: 'error',
            schedulerMode: previousRequest?.schedulerMode || 'normal',
            requestedTimeSpan,
            nextTimeSpan: requestedTimeSpan,
            requestedAt: new Date(requestedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - requestedAt,
            statusCode,
            departures: null,
            newTrips: 0,
            nextScheduledAt: new Date(retryAt).toISOString(),
            error: response?.message || response?.stack || String(response || 'Empty response'),
        });
        await setDepartureDiscoveryScheduledAt(stopId, retryAt);
        return;
    }

    const normalizedProducts = new Set(context.configuredProducts.map(normalizeProduct));
    const discoveredById = new Map();
    for (const departure of response.Departures) {
        const tripId = String(departure.Fahrtnummer);
        if (!departure.Fahrtnummer || context.knownTripIds.has(tripId)
            || !normalizedProducts.has(normalizeProduct(departure.Produkt))) continue;
        discoveredById.set(tripId, departure);
    }

    const next = getNextRequest(response.Departures, previousRequest, requestedTimeSpan);
    writeNewDatapoint('METRICLIST:DepartureDiscovery.RequestTime', response.Meta?.RequestTime || 0);
    await recordDepartureDiscoveryRequest(stopId, {
        state: 'success',
        schedulerMode: next.schedulerMode,
        requestedTimeSpan,
        nextTimeSpan: next.nextTimeSpan,
        requestedAt: new Date(requestedAt).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - requestedAt,
        statusCode: 200,
        requestTimeMs: response.Meta?.RequestTime || 0,
        departures: response.Departures.length,
        newTrips: discoveredById.size,
        lastDepartureAt: next.lastDepartureAt,
        invalidDepartureTimes: next.invalidDepartureTimes,
        nextScheduledAt: new Date(next.nextScheduledAt).toISOString(),
    });
    await setDepartureDiscoveryScheduledAt(stopId, next.nextScheduledAt);
    if (discoveredById.size > 0) await markDepartureDiscoveryRequired(stopId);
    await writeNewDatapointKey('METRIC:DepartureDiscovery.TripsFound', discoveredById.size);
    process.log.debug(
        `Departure discovery stop ${stopId}: ${response.Departures.length} departures, `
        + `mode ${next.schedulerMode}, next ${new Date(next.nextScheduledAt).toISOString()} `
        + `(TimeSpan ${next.nextTimeSpan})`
    );
    if (discoveredById.size > 0 && context.onDepartures) {
        await context.onDepartures([...discoveredById.values()]);
    }
};

const startDepartureDiscoveryWorker = (vgn, onDepartures) => {
    workerContext = { ...workerContext, vgn, onDepartures };
    if (workerStarted) return;
    workerStarted = true;
    const run = async () => {
        const requestDelay = getConfiguredNumber('DEPARTURE_DISCOVERY_REQUEST_DELAY_MS', 500);
        let delayUntilNextRun = 1000;
        try {
            if (workerContext?.vgn && Array.isArray(workerContext.configuredProducts)) {
                const now = Date.now();
                const stopId = await claimDueDepartureDiscoveryStop(now, now + (2 * MINUTE_MS));
                if (stopId) {
                    await processDueStop(stopId);
                    delayUntilNextRun = requestDelay;
                }
            }
        } catch (error) {
            if (process.env.SENTRY_DSN) process.sentry.captureException(error);
            process.log.error(error.stack || error);
            delayUntilNextRun = 5000;
        }
        setTimeout(run, delayUntilNextRun);
    };
    run();
};

module.exports = {
    getLastDepartureTimestamp,
    getNextRequest,
    normalizeStopCode,
    selectDiscoveryCandidates,
    startDepartureDiscoveryWorker,
    syncDepartureDiscoveryCandidates,
    waitForDiscoveryRateLimit: () => wait(getConfiguredNumber('DEPARTURE_DISCOVERY_REQUEST_DELAY_MS', 500)),
};
