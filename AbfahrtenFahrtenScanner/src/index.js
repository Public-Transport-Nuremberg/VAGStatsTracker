const vgn_wrapper = require('oepnv-nuremberg');

const { writeNewDatapoint, writeNewDatapointKey, ScheduleJob } = require('@lib/redis');
const { findFutureTimestampIndex, filterDuplicates } = require('@lib/util');

const vgn = new vgn_wrapper.openvgn();

const MakeTripRequests = async () => {
    const ProductPromiseArray = [];

    process.env.products.split(',').forEach(async (product) => {
        ProductPromiseArray.push(vgn.getTrips(product.toLocaleLowerCase(), { timespan: 10 }));
    });

    try {
        const results = await Promise.allSettled(ProductPromiseArray)

        // We use "Soll" (planned) times, because we wanna track the punctuality
        results.map(async (result) => {
            const { status, value } = result;
            if (status === 'rejected') return;

            // Check if value is instance of Error
            if (value instanceof Error) {
                process.log.error(value);
                writeNewDatapoint('ERRORLIST:Trips.Statuscode', value.code) // Log the error code
                return;
            }

            const { Fahrt, Meta } = value;

            writeNewDatapoint('METRICLIST:Trips.RequestTime', Meta.RequestTime); // Store the request time for later analysis

            const { Fahrten, Produkt } = Fahrt;
            process.app.watchdog.updateMonitor(Produkt); // Update the watchdog monitor for the product
            writeNewDatapointKey(`METRIC:TotalTripsTracked.${Produkt}`, Fahrten.length); // Store the amount of trips we got

            const now = new Date();
            const currentlyActive = Fahrten.filter(fahrt => {
                const startZeit = new Date(fahrt.Startzeit);
                const endZeit = new Date(fahrt.Endzeit);
                return now >= startZeit && now <= endZeit;
            });

            writeNewDatapointKey(`METRIC:TotalTripsActive.${Produkt}`, currentlyActive.length); // Store the amount of trips are currently active

            const filteredFahrten = await filterDuplicates(Fahrten); // Check for duplicates we already have in the queue
            process.log.debug(`Filtered ${Fahrten.length - filteredFahrten.length} duplicates for ${Produkt}`);

            //Limit it at 1 to test the system
            // const testfilteredFahrten = filteredFahrten.slice(0, 1)

            filteredFahrten.map(async (fahrt) => {
                const { Fahrtnummer, Betriebstag } = fahrt;
                const abfahrt = await vgn.getTrip(Fahrtnummer, { product: Produkt, date: Betriebstag })

                // Check if value is instance of Error
                if (abfahrt instanceof Error) {
                    process.log.error(abfahrt);
                    writeNewDatapoint('ERRORLIST:Trip.Statuscode', abfahrt.code) // Log the error code
                    return;
                }

                const { Fahrt, Meta } = abfahrt;
                const { Fahrtverlauf } = Fahrt;
                writeNewDatapoint('METRICLIST:Trip.RequestTime', Meta.RequestTime); // Store the request time for later analysis

                // Find the next stop in the near future
                const futureIndex = findFutureTimestampIndex(Fahrtverlauf, (parseInt(process.env.SCANBEFORE, 10) || 30) * 1000);
                if (futureIndex === -1) return; //

                const TripTimeline = Fahrtverlauf.map((stop) => { return stop.VGNKennung }); // Get the timeline of the trip, so we can recreate the job without another trip request
                const TripDepartureTimeline = Fahrtverlauf.map((stop) => { return new Date(stop.AnkunftszeitSoll || stop.AbfahrtszeitSoll).getTime() }); // Get the timeline of the trip, so we can recreate the job without another trip request

                const futureFahrt = Fahrtverlauf[futureIndex]; // Get data for the next stop in the future
                futureFahrt.Fahrtnummer = Fahrtnummer; // Store that so we can filter the exact trip later
                futureFahrt.Linienname = Fahrt.Linienname; // Store that so we can filter the exact trip later
                const timestamp = new Date(futureFahrt.AnkunftszeitSoll || futureFahrt.AbfahrtszeitSoll).getTime() - (parseInt(process.env.SCANBEFORE, 10) || 30) * 1000;

                // Filter fake Linien, like 84 is only a TAXI
                ScheduleJob(Fahrtnummer, Fahrt, futureFahrt, TripTimeline, TripDepartureTimeline, timestamp) // Create the job and a key to use for filtering
            });
        });

        process.log.info('All requests completed');

    } catch (error) {
        process.log.error(error);
    }

};

(async () => {
    process.log.system('Starting FahrtenScanner, scanning every ' + process.env.SCAN_INTERVAL + ' minutes');
    await MakeTripRequests();
    setInterval(MakeTripRequests, parseInt(process.env.SCAN_INTERVAL, 10) * 60 * 1000);
})();