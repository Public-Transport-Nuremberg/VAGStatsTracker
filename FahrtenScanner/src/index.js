const vgn_wrapper = require('oepnv-nuremberg');

const { writeNewDatapoint, ScheduleJob } = require('@lib/redis');
const { findFutureTimestampIndex, filterDuplicates } = require('@lib/util');

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
            const { Fahrt, Meta } = value;

            writeNewDatapoint('Trips.RequestTime', Meta.RequestTime);

            const { Fahrten, Produkt } = Fahrt;

            const filteredFahrten = await filterDuplicates(Fahrten); // Check for duplicates we already have in the queue
            process.log.debug(`Filtered ${Fahrten.length - filteredFahrten.length} duplicates for ${Produkt}`);

            filteredFahrten.map(async (fahrt) => {
                const { Fahrtnummer, Betriebstag } = fahrt;
                const abfaht = await vgn.getTrip(Fahrtnummer, { product: Produkt, date: Betriebstag })

                const { Fahrt, Meta } = abfaht;
                const { Fahrtverlauf } = Fahrt;
                writeNewDatapoint('Trip.RequestTime', Meta.RequestTime);

                const futureIndex = findFutureTimestampIndex(Fahrtverlauf);
                if (futureIndex === -1) return;
                
                const futureFahrt = Fahrtverlauf[futureIndex]; // Get data for the next stop in the future
                futureFahrt.Fahrtnummer = Fahrtnummer; // Store that so we can filter the exact trip later
                const timestamp = new Date(futureFahrt.AnkunftszeitSoll || futureFahrt.AbfahrtszeitSoll).getTime();

                ScheduleJob(Fahrtnummer, futureFahrt, timestamp)
            });

            if (status === 'rejected') return;
        });

        process.log.info('All requests completed');

    } catch (error) {
        process.log.error(error);
    }

};

(async () => {
    await MakeTripRequests();
})();

//setInterval(MakeTripRequests, 10 * 1000);