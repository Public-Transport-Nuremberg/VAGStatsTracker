const vgn_wrapper = require('oepnv-nuremberg');

const { writeNewDatapoint } = require('@lib/redis');
const { findFutureTimestampIndex } = require('@lib/util');

const vgn = new vgn_wrapper.openvgn();

const MakeTripRequests = async () => {
    const ProductPromiseArray = [];

    process.env.products.split(',').forEach(async (product) => {
        ProductPromiseArray.push(vgn.getTrips(product.toLocaleLowerCase(), { timespan: 10 }));
    });

    try {
        const results = await Promise.allSettled(ProductPromiseArray)

        results.map((result) => {
            const { status, value } = result;
            const { Fahrt, Meta } = value;

            writeNewDatapoint('Trips.RequestTime', Meta.RequestTime);

            const { Fahrten, Produkt } = Fahrt;

            Fahrten.map(async (fahrt) => {
                const { Fahrtnummer, Betriebstag } = fahrt;
                const abfaht = await vgn.getTrip(Fahrtnummer, { product: Produkt, date: Betriebstag })

                const { Fahrt, Meta } = abfaht;
                const { Fahrtverlauf } = Fahrt;
                writeNewDatapoint('Trip.RequestTime', Meta.RequestTime);

                const futureIndex = findFutureTimestampIndex(Fahrtverlauf);
                if (futureIndex === -1) return;
                
                const futureFahrt = Fahrtverlauf[futureIndex]; // Get data for the next stop in the future
                futureFahrt.Fahrtnummer = Fahrtnummer;
                console.log(futureFahrt);
            });

            if (status === 'rejected') return;
        });

    } catch (error) {
        process.log.error(error);
    }

};

(async () => {
    await MakeTripRequests();
})();

//setInterval(MakeTripRequests, 10 * 1000);