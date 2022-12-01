const vgn_wrapper = require('oepnv-nuremberg');

const vgn = new vgn_wrapper.openvgn();

const ProductPromiseArray = [];

process.env.products.split(',').forEach(async (product) => {
    ProductPromiseArray.push(vgn.getTrips(product.toLocaleLowerCase(), { timespan: 10 }));
});

const MakeTripRequests = () => {
    Promise.allSettled(ProductPromiseArray).then((results) => {
        console.log(results);
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === "fulfilled") {
                if (results[i].value.Fahrt) {
                    const product = results[i].value.Fahrt.Produkt.replace("-", "").toLocaleLowerCase()
                    process.app.watchdog.updateMonitor(product);
                    for (let trip of results[i].value.Fahrt.Fahrten) {
                        console.log(trip);
                        // Bevor er die RabbitMQ Nachrichten erstellt, holt er sich alle aktuellen Nummern von der Redis damit keine duplikate entstehen
                        /* Erzeugt eine RabbitMQ Nachricht, die für die Abfahrt getimed ist damit Sie von einem Worker aufegriffen wird
                        zeitgleich wird die Fahrtnummer in der Redis Eingetragen unter dem Produkt.

                        Ein Worker muss die Fahrtennummer aus der Redis löschen wenn diese am Ziel angekommen ist.
                        */
                    }
                    // Push Meta.RequestTime to Redis in a list
                } else {
                    process.log.error(results[i].value.message);
                }

                console.log(results[i].value);
            } else {
                process.log.error(`Failed to get ${process.env.products.split(',')[i]} trips`);
            }
        }
    });
};

setInterval(MakeTripRequests, 10 * 1000);