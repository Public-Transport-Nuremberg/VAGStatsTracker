const {
    getDepartureDiscoveryCursor,
    getKnownTripStopIds,
    recordDepartureDiscoveryRequest,
    setDepartureDiscoveryCursor,
    setDepartureDiscoveryScheduledAt,
    updateDepartureDiscoveryPlan,
    writeNewDatapoint,
    writeNewDatapointKey,
} = require('@lib/redis');
const { traceFetch } = require('@lib/apiTrace');

const STOPS_URL = 'https://start.vag.de/dm/api/haltestellen.json/vgn?name=';
const STOPS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let cachedStops = null;
let stopsCachedAt = 0;

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
    .split(',')
    .map(normalizeStopCode)
    .some((stopCode) => mentionedStopCodes.has(stopCode));

const selectRotatingBatch = (stops, cursor, batchSize) => {
    if (stops.length === 0) return { batch: [], nextCursor: 0 };

    const normalizedCursor = cursor % stops.length;
    const selectedCount = Math.min(batchSize, stops.length);
    const batch = Array.from(
        { length: selectedCount },
        (_, offset) => stops[(normalizedCursor + offset) % stops.length]
    );
    return {
        batch,
        nextCursor: (normalizedCursor + selectedCount) % stops.length,
    };
};

const selectDiscoveryCandidates = (allStops, configuredProducts, mentionedStopCodes, knownTripStopIds) => {
    return allStops.filter((stop) => stopMatchesProducts(stop, configuredProducts)
        && !knownTripStopIds.has(String(stop.VGNKennung))
        && !stopIsMentioned(stop, mentionedStopCodes));
};

const discoverDepartures = async (vgn, configuredProducts, mentionedStopCodes, knownTripIds) => {
    if (String(process.env.DEPARTURE_DISCOVERY_ENABLED || 'true').toLowerCase() !== 'true') {
        await updateDepartureDiscoveryPlan({
            candidates: [],
            mentionedStopIds: [],
            schedule: [],
            state: { enabled: false, updatedAt: new Date().toISOString() },
        });
        return [];
    }

    const allStops = await getAllStops();
    const knownTripStopIds = await getKnownTripStopIds();
    const candidates = selectDiscoveryCandidates(
        allStops,
        configuredProducts,
        mentionedStopCodes,
        knownTripStopIds
    );
    const cursor = await getDepartureDiscoveryCursor();
    const batchSize = getConfiguredNumber('DEPARTURE_DISCOVERY_BATCH_SIZE', 20);
    const requestDelay = getConfiguredNumber('DEPARTURE_DISCOVERY_REQUEST_DELAY_MS', 500);
    const timespan = getConfiguredNumber('DEPARTURE_DISCOVERY_TIMESPAN_MINUTES', 10);
    const { batch, nextCursor } = selectRotatingBatch(candidates, cursor, batchSize);
    const discoveredById = new Map();
    const normalizedConfiguredProducts = new Set(configuredProducts.map(normalizeProduct));
    const scanStartedAt = Date.now();
    const normalizedCursor = candidates.length > 0 ? cursor % candidates.length : 0;
    const scanIntervalMs = getConfiguredNumber('SCAN_INTERVAL', 5) * 60 * 1000;
    const fullRotationMs = Math.max(scanIntervalMs, Math.ceil(candidates.length / batchSize) * scanIntervalMs);
    const schedule = candidates.map((_, offset) => {
        const stop = candidates[(normalizedCursor + offset) % candidates.length];
        return {
            stopId: stop.VGNKennung,
            timestamp: scanStartedAt
                + (Math.floor(offset / batchSize) * scanIntervalMs)
                + ((offset % batchSize) * requestDelay),
        };
    });
    const mentionedStopIds = allStops
        .filter((stop) => stopIsMentioned(stop, mentionedStopCodes))
        .map((stop) => stop.VGNKennung);

    await updateDepartureDiscoveryPlan({
        candidates: candidates.map((stop) => stop.VGNKennung),
        mentionedStopIds,
        schedule,
        state: {
            enabled: true,
            running: true,
            scanStartedAt: new Date(scanStartedAt).toISOString(),
            candidateSource: 'unlearned-stops',
            configuredProducts,
            totalStops: allStops.length,
            knownTripStops: knownTripStopIds.size,
            mentionedStops: mentionedStopIds.length,
            candidates: candidates.length,
            batchSize: batch.length,
            cursor: normalizedCursor,
            nextCursor,
        },
    });

    for (const [index, stop] of batch.entries()) {
        let response;
        const requestedAt = Date.now();
        await recordDepartureDiscoveryRequest(stop.VGNKennung, {
            state: 'running',
            requestedAt: new Date(requestedAt).toISOString(),
        });
        try {
            response = await vgn.getDepartures(stop.VGNKennung, {
                Product: configuredProducts.join(','),
                TimeSpan: timespan,
            });
        } catch (error) {
            response = error;
        }

        if (!response || !Array.isArray(response.Departures)) {
            const statusCode = response?.code || 500;
            writeNewDatapoint('ERRORLIST:DepartureDiscovery.Statuscode', statusCode);
            process.log.warn(`Departure discovery failed for stop ${stop.VGNKennung} (${statusCode})`);
            await recordDepartureDiscoveryRequest(stop.VGNKennung, {
                state: 'error',
                requestedAt: new Date(requestedAt).toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: Date.now() - requestedAt,
                statusCode,
                error: response?.message || response?.stack || String(response || 'Empty response'),
            });
        } else {
            writeNewDatapoint('METRICLIST:DepartureDiscovery.RequestTime', response.Meta?.RequestTime || 0);
            let newTripsAtStop = 0;
            for (const departure of response.Departures) {
                const tripId = String(departure.Fahrtnummer);
                if (!departure.Fahrtnummer
                    || knownTripIds.has(tripId)
                    || !normalizedConfiguredProducts.has(normalizeProduct(departure.Produkt))) {
                    continue;
                }
                if (!discoveredById.has(tripId)) newTripsAtStop++;
                discoveredById.set(tripId, departure);
            }
            await recordDepartureDiscoveryRequest(stop.VGNKennung, {
                state: 'success',
                requestedAt: new Date(requestedAt).toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: Date.now() - requestedAt,
                statusCode: 200,
                requestTimeMs: response.Meta?.RequestTime || 0,
                departures: response.Departures.length,
                newTrips: newTripsAtStop,
            });
        }

        await setDepartureDiscoveryScheduledAt(stop.VGNKennung, Date.now() + fullRotationMs);

        if (index < batch.length - 1) await wait(requestDelay);
    }

    await setDepartureDiscoveryCursor(nextCursor);
    await writeNewDatapointKey('METRIC:DepartureDiscovery.StopsScanned', batch.length);
    await writeNewDatapointKey('METRIC:DepartureDiscovery.Candidates', candidates.length);
    await writeNewDatapointKey('METRIC:DepartureDiscovery.KnownTripStops', knownTripStopIds.size);
    await writeNewDatapointKey('METRIC:DepartureDiscovery.TripsFound', discoveredById.size);
    await writeNewDatapointKey('SCANNER:DepartureDiscovery:STATE', JSON.stringify({
        enabled: true,
        running: false,
        scanStartedAt: new Date(scanStartedAt).toISOString(),
        completedAt: new Date().toISOString(),
        candidateSource: 'unlearned-stops',
        configuredProducts,
        totalStops: allStops.length,
        knownTripStops: knownTripStopIds.size,
        mentionedStops: mentionedStopIds.length,
        candidates: candidates.length,
        batchSize: batch.length,
        cursor: normalizedCursor,
        nextCursor,
        tripsFound: discoveredById.size,
    }));
    process.log.info(`Departure discovery scanned ${batch.length}/${candidates.length} stops and found ${discoveredById.size} additional trip IDs`);

    return [...discoveredById.values()];
};

module.exports = {
    discoverDepartures,
    normalizeStopCode,
    selectDiscoveryCandidates,
    selectRotatingBatch,
    waitForDiscoveryRateLimit: () => wait(getConfiguredNumber('DEPARTURE_DISCOVERY_REQUEST_DELAY_MS', 500)),
};
