const { openvgn } = require('oepnv-nuremberg');

const vgn = new openvgn();

const Redis = require('ioredis');
const { Worker } = require('bullmq');

const { getLastStopAndProgress, removeDuplicatesAndKeepOrder } = require('@lib/util');
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
        const { Fahrtnummer, Betriebstag, Produkt, AlreadyTrackedStops, Startzeit, Endzeit } = job.data;

        const tripData = await vgn.getTrip(Fahrtnummer, { product: Produkt, date: Betriebstag })

        const { Fahrt, Meta } = tripData;
        const { Linienname, Fahrzeugnummer, Besetzgrad, Richtung, Richtungstext, Fahrtverlauf } = Fahrt;

        const currentTime = new Date();
        const Fahrtverlauf_result = getLastStopAndProgress(Fahrtverlauf, currentTime);
        const unProcessedStopsList = removeDuplicatesAndKeepOrder(AlreadyTrackedStops, Fahrtverlauf_result.vgnCodes); // All those stops we need to write to db

        // Check if there is a next stop or not
        if (Fahrtverlauf_result.lastStopIndex === Fahrtverlauf_result.length - 1) {
            delTripKey(Fahrtnummer); // We are done with this trip
            return;
        }

        const lastStopObject = Fahrtverlauf[Fahrtverlauf_result.lastStopIndex];
        const nextStopObject = Fahrtverlauf[Fahrtverlauf_result.lastStopIndex + 1];

        if(Fahrtverlauf_result.lastStopIndex === -1) {
            throw new Error(`Could not find last stop for ${Fahrtnummer} (${Produkt})`);
        }

        const tripKeyData = {
            VGNKennung: Fahrtnummer,
            VAGKennung: lastStopObject.VAGKennung,
            Produkt: Produkt,
            Linienname: Linienname,
            Richtung: Richtung,
            Richtungstext: Richtungstext,
            Fahrzeugnummer: Fahrzeugnummer,
            Betriebstag: Betriebstag,
            Besetzgrad: Besetzgrad,
            Haltepunkt: lastStopObject.Haltepunkt,
            AbfahrtszeitSoll: lastStopObject.AbfahrtszeitSoll,
            AbfahrtszeitIst: lastStopObject.AbfahrtszeitIst,
            PercentageToNextStop: Fahrtverlauf_result.progress,
        }

        //console.log(lastStopObject, nextStopObject);

        process.log.info(`Processed [${Fahrtnummer}] ${Produkt} (${Linienname}) [${lastStopObject.AbfahrtszeitIst}] ${lastStopObject.Haltestellenname} Next stop: ${nextStopObject.Haltestellenname} [${nextStopObject.AnkunftszeitIst}] Progress: ${Fahrtverlauf_result.progress}`);
        ScheduleJob(Fahrtnummer, Betriebstag, Produkt, tripKeyData, Fahrtverlauf_result.vgnCodes, new Date(nextStopObject.AnkunftszeitIst).getTime(), Startzeit, Endzeit);

    } catch (error) {

        console.log(error);
        throw error;
    }
}, {
    connection: queueData,
    removeOnComplete: { count: 1 },
    removeOnFail: { count: 50 },
    concurrency: 5
});