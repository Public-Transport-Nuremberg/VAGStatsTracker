const vgn_wrapper = require('oepnv-nuremberg');

const {
    writeNewDatapoint,
    writeNewDatapointKey,
    checkTripKey,
    addJob,
} = require('@lib/redis');
const { discoverDepartures, normalizeStopCode, waitForDiscoveryRateLimit } = require('@lib/departureDiscovery');
const { filterDuplicates } = require('@lib/util');
const { insertOrUpdateFahrt } = require('@lib/clickhouse');
const { traceVgnClient } = require('@lib/apiTrace');

const vgn = traceVgnClient(new vgn_wrapper.openvgn(), 'FahrtenScanner');
let scanRunning = false;

const getFirstTimeValue = (stop, fields) => {
    for (const field of fields) {
        if (stop?.[field] && Number.isFinite(new Date(stop[field]).getTime())) return stop[field];
    }
    return null;
};

const addMentionedStopCodes = (fahrt, mentionedStopCodes) => {
    for (const haltId of [fahrt.StartHaltID, fahrt.EndHaltID]) {
        const stopCode = normalizeStopCode(haltId);
        if (stopCode) mentionedStopCodes.add(stopCode);
    }
};

const storeAndScheduleFahrt = async (fahrt, product, runImmediately = false, recordKnownStops = true) => {
    const occupancy = fahrt.Besetzgrad ?? fahrt.Besetztgrad ?? 'Unbekannt';
    await insertOrUpdateFahrt(
        fahrt.Fahrtnummer,
        fahrt.Betriebstag,
        product,
        fahrt.Linienname,
        occupancy,
        fahrt.Fahrzeugnummer ?? -1,
        fahrt.Richtung,
        fahrt.FaelltAus
    );

    if (fahrt.FaelltAus === true) {
        process.log.info(`Skipped Redis job for cancelled Fahrt ${fahrt.Fahrtnummer} (Produkt: ${product}, Betriebstag: ${fahrt.Betriebstag})`);
        return false;
    }

    const startTimestamp = new Date(fahrt.Startzeit).getTime();
    const endTimestamp = new Date(fahrt.Endzeit).getTime();
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp) || endTimestamp <= Date.now()) {
        process.log.warn(`Cannot schedule Fahrt ${fahrt.Fahrtnummer}: invalid or expired trip times`);
        return false;
    }

    const runAtTimestamp = runImmediately ? Date.now() : startTimestamp;
    const jobDelay = await addJob(
        fahrt.Fahrtnummer,
        fahrt.Betriebstag,
        product,
        runAtTimestamp,
        endTimestamp,
        fahrt,
        recordKnownStops
    );
    process.log.info(`Added job for ${fahrt.Fahrtnummer} (Produkt: ${product}) to run at ${new Date(runAtTimestamp).toLocaleString()} (${jobDelay})`);
    return true;
};

const resolveDiscoveredDeparture = async (departure) => {
    if (await checkTripKey(departure.Fahrtnummer)) return false;

    const tripResponse = await vgn.getTrip(departure.Fahrtnummer, {
        product: departure.Produkt,
        date: departure.Betriebstag,
    });
    if (tripResponse instanceof Error || !tripResponse?.Fahrt?.Fahrtverlauf?.length) {
        const statusCode = tripResponse?.code || 500;
        writeNewDatapoint('ERRORLIST:DepartureDiscovery.Trip.Statuscode', statusCode);
        process.log.warn(`Could not resolve discovered Fahrt ${departure.Fahrtnummer} (${statusCode})`);
        return false;
    }

    writeNewDatapoint('METRICLIST:DepartureDiscovery.Trip.RequestTime', tripResponse.Meta?.RequestTime || 0);
    const { Fahrtverlauf, ...fahrtData } = tripResponse.Fahrt;
    const firstStop = Fahrtverlauf[0];
    const lastStop = Fahrtverlauf[Fahrtverlauf.length - 1];
    const Startzeit = getFirstTimeValue(firstStop, [
        'AbfahrtszeitIst',
        'AbfahrtszeitSoll',
        'AnkunftszeitIst',
        'AnkunftszeitSoll',
    ]);
    const Endzeit = getFirstTimeValue(lastStop, [
        'AnkunftszeitIst',
        'AnkunftszeitSoll',
        'AbfahrtszeitIst',
        'AbfahrtszeitSoll',
    ]);
    const fahrt = {
        ...fahrtData,
        Startzeit,
        Endzeit,
        StartHaltID: firstStop.Haltepunkt,
        EndHaltID: lastStop.Haltepunkt,
        FaelltAus: false,
    };

    if (await checkTripKey(fahrt.Fahrtnummer)) return false;
    return storeAndScheduleFahrt(fahrt, fahrt.Produkt || departure.Produkt, true, false);
};

const MakeTripRequests = async () => {
    if (scanRunning) {
        process.log.warn('Skipping FahrtenScanner iteration because the previous scan is still running');
        return;
    }
    scanRunning = true;

    try {
        const configuredProducts = process.env.PRODUCTS.split(',').map((product) => product.trim()).filter(Boolean);
        const requests = configuredProducts.map((product) => vgn.getTrips(product.toLowerCase(), { timespan: 10 }));
        const results = await Promise.allSettled(requests);
        const primaryTripIds = new Set();
        const mentionedStopCodes = new Set();

        for (const result of results) {
            if (result.status === 'rejected') {
                process.log.error(result.reason);
                continue;
            }

            const value = result.value;
            if (value instanceof Error || !Array.isArray(value?.Fahrt?.Fahrten)) {
                process.log.error(value);
                writeNewDatapoint('ERRORLIST:Trips.Statuscode', value?.code || 500);
                continue;
            }

            const { Fahrten, Produkt } = value.Fahrt;
            for (const fahrt of Fahrten) {
                primaryTripIds.add(String(fahrt.Fahrtnummer));
                addMentionedStopCodes(fahrt, mentionedStopCodes);
            }

            writeNewDatapoint('METRICLIST:Trips.RequestTime', value.Meta.RequestTime);
            process.app.watchdog.updateMonitor(Produkt);
            writeNewDatapointKey(`METRIC:TotalTripsTracked.${Produkt}`, Fahrten.length);

            const now = new Date();
            const currentlyActive = Fahrten.filter((fahrt) => now >= new Date(fahrt.Startzeit)
                && now <= new Date(fahrt.Endzeit));
            writeNewDatapointKey(`METRIC:TotalTripsActive.${Produkt}`, currentlyActive.length);

            const filteredFahrten = await filterDuplicates(Fahrten);
            process.log.debug(`Filtered ${Fahrten.length - filteredFahrten.length} duplicates for ${Produkt}`);
            const scheduleResults = await Promise.allSettled(
                filteredFahrten.map((fahrt) => storeAndScheduleFahrt(fahrt, Produkt))
            );
            for (const scheduleResult of scheduleResults) {
                if (scheduleResult.status === 'rejected') process.log.error(scheduleResult.reason);
            }
        }

        const discoveredDepartures = await discoverDepartures(
            vgn,
            configuredProducts,
            mentionedStopCodes,
            primaryTripIds
        );
        let resolvedTrips = 0;
        for (const departure of discoveredDepartures) {
            if (await resolveDiscoveredDeparture(departure)) resolvedTrips++;
            await waitForDiscoveryRateLimit();
        }
        await writeNewDatapointKey('METRIC:DepartureDiscovery.TripsResolved', resolvedTrips);
        process.log.info(`All requests completed; ${resolvedTrips} additional trips scheduled`);
    } catch (error) {
        if (process.env.SENTRY_DSN) process.sentry.captureException(error);
        process.log.error(error.stack || error);
    } finally {
        scanRunning = false;
    }
};

(async () => {
    process.log.system(`Starting FahrtenScanner, scanning every ${process.env.SCAN_INTERVAL} minutes`);
    await MakeTripRequests();
    setInterval(MakeTripRequests, parseInt(process.env.SCAN_INTERVAL, 10) * 60 * 1000);
})();
