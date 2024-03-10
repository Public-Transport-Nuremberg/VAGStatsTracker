const { openvgn } = require('oepnv-nuremberg');

const vgn = new openvgn();

const Redis = require('ioredis');
const { Worker } = require('bullmq');

const { writeNewDatapoint, ScheduleJob, delTripKey } = require('@lib/redis');

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
        const requestDepartureAmount = job.attemptsStarted * 4
        const departure = await vgn.getDepartures(VGNKennung, { Line: Linienname, timespan: 10, LimitCount: requestDepartureAmount });

        // Check if value is instance of Error
        if (departure instanceof Error) {
            process.log.error(departure);
            writeNewDatapoint('Departure.Error', departure.code) // Log the error code
            return;
        }

        const { Departures, Meta } = departure;

        // if(!Meta) console.log(departure, job.data)
        writeNewDatapoint('Departure.RequestTime', Meta.RequestTime); // Store the request time for later analysis

        // Find the next stop in tripTimeline, and check if its the last stop
        const thisStopIndex = tripTimeline.indexOf(VGNKennung);
        const nextStopID = tripTimeline[thisStopIndex + 1];
        const nextTimestamp = tripDepartureTimeline[thisStopIndex + 1] - parseInt(process.env.SCANBEFORE, 10) || 5; // Scan x seconds before the expected arrival time

        // Find the departure for the trip we are interested in (Fahrtnummer)
        const tripDeparture = Departures.find((departure) => departure.Fahrtnummer === Fahrtnummer);
        if (!tripDeparture) {
            // console.log(departure.Stop, "thisStopIndex", thisStopIndex, "tripLegth", tripTimeline.length);
            //console.log(Fahrtnummer, Departures);
            if (thisStopIndex === tripTimeline.length - 1) {
                process.log.info(`Trip ${Fahrtnummer} (Linie: ${Linienname}) has reached its final destination at ${departure.Stop}`);
                delTripKey(Fahrtnummer);

                // Here we can check where the product is and will head on next, if we want. This can be used to find out if a trip actually never existed
                // VAG will show trips, that are operated by a third party, even when the third party never shows up. This can only be kinda checked this way
                return;
            }
            if(job.attemptsStarted > 3) {
                // The trip started too early. So before env.SCANBEFORE
            }
            //process.log.error(`Could not find departure on try ${job.attemptsStarted} for ${Fahrtnummer} ${departure.Stop} (${VGNKennung}) (Linie: ${Linienname})`);
            throw new Error(`Could not find departure on try ${job.attemptsStarted} for ${Fahrtnummer} ${departure.Stop} (${VGNKennung}) (Linie: ${Linienname})`);
        }

        if (thisStopIndex === -1) {
            process.log.error(`Could not find stop in tripTimeline for ${Fahrtnummer}`);
            process.log.error(departure);
            return;
        }

        process.log.info(`Processed ${Fahrtnummer} at ${departure.Stop} (Linie: ${Linienname}) to ${nextStopID} with a delay of ${tripDeparture.Verspätung} seconds`);

        const nextData = {
            Fahrtnummer,
            VGNKennung: nextStopID,
            Linienname,
            tripTimeline,
            tripDepartureTimeline
        }

        ScheduleJob(Fahrtnummer, nextData, tripTimeline, nextTimestamp, Meta.RequestTime);

    } catch (error) {
        throw error;
    }
}, {
    connection: queueData,
    removeOnComplete: { count: 1 },
    removeOnFail: { count: 50 },
    concurrency: 10
});