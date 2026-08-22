const { openvgn } = require('oepnv-nuremberg');
const { traceVgnClient } = require('@lib/apiTrace');

const vgn = traceVgnClient(new openvgn(), 'FahrtenProcessor');

const { Worker } = require('bullmq');

const { getLastStopAndProgress, getSegmentStartTimestamp, removeDuplicatesAndKeepOrder } = require('@lib/util');
const { writeNewDatapoint, recordKnownTripStops, ScheduleJob, delTripKey, errorExporter } = require('@lib/redis');

const { insertOrUpdateFahrtEntry, insertOrUpdateHaltestelle } = require('@lib/clickhouse');

const queueData = {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || "127.0.0.1",
    username: process.env.REDIS_USER || "default",
    password: process.env.REDIS_PASSWORD || "example",
    db: process.env.REDIS_DB + 1 || 1,
}

const worker = new Worker('q:trips', async (job) => {
    let currentTripResponse = null;
    try {
        const {
            Fahrtnummer,
            Betriebstag,
            Produkt,
            AlreadyTrackedStops = [],
            Startzeit,
            Endzeit,
            Fahrt: ScannerFahrt,
            RecordKnownStops = true,
            StopLearningSource = null,
        } = job.data;

        const tripData = await vgn.getTrip(Fahrtnummer, { product: Produkt, date: Betriebstag })

        currentTripResponse = tripData;
        if (!tripData?.Fahrt
            || !Array.isArray(tripData.Fahrt.Fahrtverlauf)
            || tripData.Fahrt.Fahrtverlauf.length === 0) {
            const statusCode = tripData?.code || tripData?.statusCode || 500;
            const upstreamMessage = tripData?.message || tripData?.error || 'response contains no Fahrt';
            writeNewDatapoint('ERRORLIST:Trip.Statuscode', statusCode);
            throw new Error(
                `getTrip returned no usable Fahrt for ${Fahrtnummer} `
                + `(${Produkt}, ${Betriebstag}): ${upstreamMessage}`
            );
        }
        const { Fahrt, Meta } = tripData;
        const { Linienname, Fahrzeugnummer, Besetzgrad, Richtung, Richtungstext, Fahrtverlauf } = Fahrt;

        writeNewDatapoint('METRICLIST:Trip.RequestTime', Meta?.RequestTime || 0); // Store the request time for later analysis
        if (StopLearningSource === 'getTrips') await recordKnownTripStops(Fahrtverlauf);

        const currentTime = new Date();
        const Fahrtverlauf_result = getLastStopAndProgress(Fahrtverlauf, currentTime);
        const unProcessedStopsList = removeDuplicatesAndKeepOrder(Fahrtverlauf_result.vgnCodes, AlreadyTrackedStops); // All those stops we need to write to db

        const dbInsertPromises = unProcessedStopsList.map((stop) => {
            const stopObject = Fahrtverlauf.find((obj) => obj.VGNKennung === stop);
            process.log.warn(`Inserting fahrt ${Fahrtnummer} (${Produkt}) stop ${stopObject.Haltestellenname} into the database...`);
            const AnkunftszeitVerspätung = stopObject.AnkunftszeitIst ? Math.floor((new Date(stopObject.AnkunftszeitIst) - new Date(stopObject.AnkunftszeitSoll)) / 1000) : 0;
            const AbfahrtszeitVerspätung = stopObject.AbfahrtszeitIst ? Math.floor((new Date(stopObject.AbfahrtszeitIst) - new Date(stopObject.AbfahrtszeitSoll)) / 1000) : 0;
            return insertOrUpdateFahrtEntry(Fahrtnummer, Betriebstag, Produkt, stopObject.VGNKennung, stopObject.Haltepunkt, stopObject.Richtungstext, stopObject.AnkunftszeitSoll, AnkunftszeitVerspätung, stopObject.AbfahrtszeitSoll, AbfahrtszeitVerspätung);
        });

        const insertResult = await Promise.allSettled(dbInsertPromises);
        for (const result of insertResult) {
            if (result.status === 'rejected') {
                if (result.reason.code === '23503') {
                    try {
                        // GANZ EHRLICH WAS IST FUCKING FALSCH MIT EUCH? DAS IST JA ABRARTIG PEINLICH
                        // Because the DB is kinda... normalized, there are some cases where a fahrt stops at stops not existing. Nice, isn´t it?
                        // Thats why we add all stops missing in /haltestellen here... 
                        const resultIndex = insertResult.indexOf(result);
                        const stopObject = Fahrtverlauf.find((obj) => obj.VGNKennung === unProcessedStopsList[resultIndex]);
                        process.log.warn(`Could not find stop ${stopObject.VGNKennung} in the database, trying to insert it now...`);
                        await insertOrUpdateHaltestelle(stopObject.VGNKennung, stopObject.VAGKennung, stopObject.Haltestellenname, stopObject.Latitude, stopObject.Longitude, Produkt);
                        // Insert the trip again... now that we actualy HAVE it.
                        const AnkunftszeitVerspätung = stopObject.AnkunftszeitIst ? Math.floor((new Date(stopObject.AnkunftszeitIst) - new Date(stopObject.AnkunftszeitSoll)) / 1000) : 0;
                        const AbfahrtszeitVerspätung = stopObject.AbfahrtszeitIst ? Math.floor((new Date(stopObject.AbfahrtszeitIst) - new Date(stopObject.AbfahrtszeitSoll)) / 1000) : 0;
                        await insertOrUpdateFahrtEntry(Fahrtnummer, Betriebstag, Produkt, stopObject.VGNKennung, stopObject.Haltepunkt, stopObject.Richtungstext, stopObject.AnkunftszeitSoll, AnkunftszeitVerspätung, stopObject.AbfahrtszeitSoll, AbfahrtszeitVerspätung);
                        continue;
                    } catch (error) {
                        errorExporter(error, error, job.data);
                        if (process.env.SENTRY_DSN) process.sentry.captureException(error);
                        throw new Error(error);
                    }
                }
                errorExporter(result.reason, result, job.data);
                if (process.env.SENTRY_DSN) process.sentry.captureException(result);
                throw new Error(result.reason);
            }
        }


        const lastStopObject = Fahrtverlauf[Fahrtverlauf_result.lastStopIndex];

        if (Fahrtverlauf_result.lastStopIndex === -1) {
            throw new Error(`Could not find last stop for ${Fahrtnummer} (${Produkt})`);
        }

        // Check if we have reached the end of the trip
        if (Fahrtverlauf_result.lastStopIndex === Fahrtverlauf.length - 1) {
            process.log.info(`Trip [${Fahrtnummer}] ${Produkt} (${Linienname}) has reached the end of its route ${lastStopObject.Haltestellenname}`);
            delTripKey(Fahrtnummer); // We are done with this trip
            return;
        }
        const nextStopObject = Fahrtverlauf[Fahrtverlauf_result.lastStopIndex + 1];

        const tripKeyData = {
            VGNKennung: lastStopObject.VGNKennung,
            VAGKennung: lastStopObject.VAGKennung,
            nextVGNKennung: nextStopObject.VGNKennung,
            nextVAGKennung: nextStopObject.VAGKennung,
            Produkt: Produkt,
            Linienname: Linienname,
            Richtung: Richtung,
            Richtungstext: Richtungstext,
            Fahrzeugnummer: Fahrzeugnummer,
            Betriebstag: Betriebstag,
            Besetzgrad: Besetzgrad,
            Haltepunkt: lastStopObject.Haltepunkt,
            AnkunftszeitSoll: lastStopObject.AnkunftszeitSoll ?? -1,
            AnkunftszeitIst: lastStopObject.AnkunftszeitIst ?? -1,
            nextAnkunftszeitSoll: nextStopObject.AnkunftszeitSoll ?? -1,
            nextAnkunftszeitIst: nextStopObject.AnkunftszeitIst ?? -1,
            AbfahrtszeitSoll: lastStopObject.AbfahrtszeitSoll ?? -1,
            AbfahrtszeitIst: lastStopObject.AbfahrtszeitIst ?? -1,
            nextAbfahrtszeitSoll: nextStopObject.AbfahrtszeitSoll ?? -1,
            nextAbfahrtszeitIst: nextStopObject.AbfahrtszeitIst ?? -1,
            PercentageToNextStop: Fahrtverlauf_result.progress,
            Fahrt: ScannerFahrt ?? null,
        }

        const getFirstTimestamp = (timestamps) => timestamps
            .map((timestamp) => new Date(timestamp).getTime())
            .find(Number.isFinite);
        const nextRunAtTimestamp = getFirstTimestamp([
            nextStopObject.AnkunftszeitIst,
            nextStopObject.AbfahrtszeitIst,
            nextStopObject.AnkunftszeitSoll,
            nextStopObject.AbfahrtszeitSoll,
        ]);
        const currentSegmentStartTimestamp = getSegmentStartTimestamp(lastStopObject, nextStopObject);

        if (!Number.isFinite(nextRunAtTimestamp)) {
            process.log.error(`Could not find next stop time for ${Fahrtnummer} (${Produkt})`);
        }

        const nowTimestamp = Date.now();
        const halfwayTimestamp = Number.isFinite(currentSegmentStartTimestamp)
            && Number.isFinite(nextRunAtTimestamp)
            && nextRunAtTimestamp > currentSegmentStartTimestamp
            ? currentSegmentStartTimestamp + ((nextRunAtTimestamp - currentSegmentStartTimestamp) / 2)
            : null;
        const nextRunAt = Number.isFinite(halfwayTimestamp) && halfwayTimestamp > nowTimestamp
            ? halfwayTimestamp
            : Number.isFinite(nextRunAtTimestamp) && nextRunAtTimestamp > nowTimestamp
                ? nextRunAtTimestamp
                : Number.isFinite(nextRunAtTimestamp)
                    ? nowTimestamp + 30000
                    : nowTimestamp + (5 * 60 * 1000);

        await ScheduleJob(
            Fahrtnummer,
            Betriebstag,
            Produkt,
            tripKeyData,
            Fahrtverlauf_result.vgnCodes,
            nextRunAt,
            Startzeit,
            Endzeit,
            lastStopObject.Latitude,
            lastStopObject.Longitude,
            false,
            StopLearningSource
        );
        process.log.info(`Processed [${Fahrtnummer}] ${Produkt} (${Linienname}) [${new Date(lastStopObject.AbfahrtszeitIst).toLocaleTimeString()}] ${lastStopObject.Haltestellenname} Next stop: ${nextStopObject.Haltestellenname} [${new Date(nextStopObject.AnkunftszeitIst).toLocaleTimeString()}] Progress: ${Fahrtverlauf_result.progress.toFixed(0)}`);

    } catch (error) {
        if (process.env.SENTRY_DSN) process.sentry.captureException({error, currentTripResponse});
        console.log(error);
        throw error;
    }
}, {
    connection: queueData,
    removeOnComplete: { count: 1 },
    removeOnFail: { count: 50 },
    concurrency: 5
});

worker.on('failed', (job, error) => {
    if (!job) return;

    const maxAttempts = Number(job.opts.attempts) || 1;
    if (job.attemptsMade < maxAttempts) return;

    const { Fahrtnummer } = job.data;
    if (Fahrtnummer === undefined || Fahrtnummer === null) return;

    void delTripKey(Fahrtnummer)
        .then(() => process.log.warn(
            `Removed stale trip key for ${Fahrtnummer} after ${maxAttempts} failed attempts: ${error.message}`
        ))
        .catch((cleanupError) => {
            process.log.error(
                `Failed to remove stale trip key for ${Fahrtnummer}: ${cleanupError.stack || cleanupError}`
            );
            if (process.env.SENTRY_DSN) process.sentry.captureException(cleanupError);
        });
});
