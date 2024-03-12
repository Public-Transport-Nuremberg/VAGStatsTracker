const { openvgn } = require('oepnv-nuremberg');

const vgn = new openvgn();

const Redis = require('ioredis');
const { Worker } = require('bullmq');

const { NotDeparturesFound } = require('@lib/errors');

const { writeNewDatapoint, ScheduleJob, delTripKey, errorExporter } = require('@lib/redis');

const queueData = {
    port: process.env.Redis_Port || 6379,
    host: process.env.Redis_Host || "127.0.0.1",
    username: process.env.Redis_User || "default",
    password: process.env.Redis_Password || "default",
    db: process.env.Redis_DB + 1 || 1,
}

new Worker('q:trips', async (job) => {
    try {
        const { Fahrtnummer, VGNKennung, Linienname, tripTimeline, tripDepartureTimeline, needsProcessingUntil } = job.data;
        // Find the next stop in tripTimeline, and check if its the last stop
        const thisStopIndex = tripTimeline.indexOf(VGNKennung);
        const nextStopID = tripTimeline[thisStopIndex + 1];
        const nextTimestamp = tripDepartureTimeline[thisStopIndex + 1] - (parseInt(process.env.SCANBEFORE, 10) || 30) * 1000; // Scan x seconds before the expected arrival time

        const nextData = {
            Fahrtnummer,
            VGNKennung: nextStopID,
            Linienname,
            tripTimeline,
            tripDepartureTimeline
        }

        // If the job enterd the worker later than the SCANBEFORE time, we rescedule it for the next stop
        if (new Date().getTime() - needsProcessingUntil > parseInt(process.env.SCANBEFORE, 10) * 1000) {
            if (thisStopIndex + 1 >= tripTimeline.length - 1) {
                process.log.info(`Tryed looking ahead for ${Fahrtnummer} (Linie: ${Linienname}) but its final destination was reached`);
                delTripKey(Fahrtnummer);
                return;
            }
            process.log.info(`JobTime: ${new Date(needsProcessingUntil).toLocaleString()} Job for ${Fahrtnummer} (Linie: ${Linienname}) is too late. Resceduled for next stop`);
            ScheduleJob(Fahrtnummer, nextData, tripTimeline, tripDepartureTimeline, nextTimestamp, 0);
            return;
        }

        const departure = await vgn.getDepartures(VGNKennung, { Line: Linienname, timespan: 5, LimitCount: 50 });

        // Check if value is instance of Error
        if (departure instanceof Error) {
            process.log.error(departure);
            writeNewDatapoint('ERRORLIST:Departure.Statuscode', departure.code) // Log the error code
            return;
        }

        const { Departures, Meta } = departure;

        if(!Meta) console.log(departure, job.data)
        writeNewDatapoint('METRICLIST:Departure.RequestTime', Meta.RequestTime); // Store the request time for later analysis
        
        // Find the departure for the trip we are interested in (Fahrtnummer)
        const tripDeparture = Departures.find((departure) => departure.Fahrtnummer === Fahrtnummer);
        if (!tripDeparture) {
            if( Meta.RequestTime >= parseInt(process.env.SCANBEFORE, 10 ) * 1000) {
                process.log.warn(`JobTime: ${new Date(needsProcessingUntil).toLocaleString()} (${Meta.RequestTime}ms) Check for ${Fahrtnummer} (Linie: ${Linienname}) way skipped API delay and resceduled for next stop`);
                ScheduleJob(Fahrtnummer, nextData, tripTimeline, tripDepartureTimeline, nextTimestamp, Meta.RequestTime);
                return;
            }
            // console.log(departure.Stop, "thisStopIndex", thisStopIndex, "tripLegth", tripTimeline.length);
            //console.log(Fahrtnummer, Departures);
            if (thisStopIndex >= tripTimeline.length - 1) {
                process.log.info(`JobTime: ${new Date(needsProcessingUntil).toLocaleString()} (${Meta.RequestTime}ms) Trip ${Fahrtnummer} (Linie: ${Linienname}) has reached its final destination at ${departure.Stop}`);
                delTripKey(Fahrtnummer);

                // Here we can check where the product is and will head on next, if we want. This can be used to find out if a trip actually never existed
                // VAG will show trips, that are operated by a third party, even when the third party never shows up. This can only be kinda checked this way
                return;
            }
            if (job.attemptsStarted > 1) { // We failed once, lets look ahead
                if (thisStopIndex + 1 >= tripTimeline.length - 1) {
                    process.log.info(`Tryed looking ahead for ${Fahrtnummer} ${departure.Stop} (Linie: ${Linienname}) but its final destination was reached`);
                    delTripKey(Fahrtnummer);
                    return;
                }
                const departureNextStop = await vgn.getDepartures(nextStopID, { Line: Linienname, timespan: 20, LimitCount: 15 });
                const { Departures, Meta } = departureNextStop;

                // if(!Meta) console.log(departure, job.data)
                writeNewDatapoint('METRICLIST:Departure.RequestTime', Meta.RequestTime); // Store the request time for later analysis

                const tripDepartureNextStop = Departures.find((departure) => departure.Fahrtnummer === Fahrtnummer);

                if (!tripDepartureNextStop) {
                    const errorID = errorExporter(`Could not find departure for next stop ${nextStopID} for ${Fahrtnummer} (Linie: ${Linienname})`, departure, job.data);
                    process.log.error(`ID:${errorID} Could not find departure for next stop ${nextStopID} for ${Fahrtnummer} (Linie: ${Linienname})`);
                    delTripKey(Fahrtnummer);
                    return;
                }

                process.log.info(`Looked ahead for ${Fahrtnummer} ${departure.Stop} (Linie: ${Linienname}) to ${nextStopID} with a delay of ${tripDepartureNextStop.Verspätung} seconds`);
                return;
            }

            process.log.warn(`JobTime: ${new Date(needsProcessingUntil).toLocaleString()} (${Meta.RequestTime}ms) Could not find departure on first try for ${Fahrtnummer} ${departure.Stop} (${VGNKennung}) (Linie: ${Linienname})`);
            throw new NotDeparturesFound(`Could not find departure on first try for ${Fahrtnummer} ${departure.Stop} (${VGNKennung}) (Linie: ${Linienname})`);
        }

        if (thisStopIndex === -1) {
            const errorID = errorExporter(`Could not find stop in tripTimeline for ${Fahrtnummer}`, departure, job.data);
            process.log.error(`ID:${errorID} Could not find stop in tripTimeline for ${Fahrtnummer}`);

            process.log.error(departure);
            return;
        }

        process.log.info(`JobTime: ${new Date(needsProcessingUntil).toLocaleString()} (${Meta.RequestTime}ms) Processed ${Fahrtnummer} at ${departure.Stop} (Linie: ${Linienname}) to ${nextStopID} with a delay of ${tripDeparture.Verspätung} seconds`);
        process.log.debug(`Job scan at ${new Date(nextTimestamp).toLocaleString()} (${Meta.RequestTime}ms) Departure: ${new Date(tripDepartureTimeline[thisStopIndex + 1]).toLocaleString()}`);

        ScheduleJob(Fahrtnummer, nextData, tripTimeline, tripDepartureTimeline, nextTimestamp, Meta.RequestTime);

    } catch (error) {
        if(error instanceof NotDeparturesFound) {
            throw error;
        }
        console.log(error);
        throw error;
    }
}, {
    connection: queueData,
    removeOnComplete: { count: 1 },
    removeOnFail: { count: 50 },
    concurrency: 25
});