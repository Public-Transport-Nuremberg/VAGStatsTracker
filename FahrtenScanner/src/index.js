const vgn_wrapper = require('oepnv-nuremberg');

const { writeNewDatapoint, writeNewDatapointKey, addJob } = require('@lib/redis');
const { filterDuplicates } = require('@lib/util');

const vgn = new vgn_wrapper.openvgn();

const MakeTripRequests = async () => {
    const ProductPromiseArray = [];

    process.env.products.split(',').forEach(async (product) => {
        ProductPromiseArray.push(vgn.getTrips(product.toLocaleLowerCase(), { timespan: 10 }));
    });

    try {
        const results = await Promise.allSettled(ProductPromiseArray)

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
                const { Fahrtnummer, Linienname, Betriebstag, Startzeit, Endzeit } = fahrt;

                const jobDelay = await addJob(Fahrtnummer, Betriebstag, Produkt, new Date(Startzeit).getTime(), new Date(Endzeit).getTime());
                process.log.info(`Added job for ${Fahrtnummer} (Produkt: ${Produkt}) to run at ${new Date(Startzeit).toLocaleString()} (${jobDelay})`);
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