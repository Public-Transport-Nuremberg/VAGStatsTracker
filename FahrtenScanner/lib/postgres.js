const { createClient } = require('@clickhouse/client');

// Write services use async_insert so ClickHouse buffers small inserts server-side
const client = createClient({
    url: `http://${process.env.DB_HOST}:${process.env.DB_PORT || 8123}`,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 0,
    },
});

/**
 * Converts a product string to an integer
 * @param {String} product
 * @returns {Number}
 */
const convertProductToInt = (product) => {
    switch (product) {
        case 'Bus':    return 1;
        case 'UBahn':  return 2;
        case 'Tram':   return 3;
        case 'SBahn':  return 4;
        case 'RBahn':  return 5;
        default:       return 0;
    }
}

const convertProducttoBool = (product) => {
    const productBooleans = {
        Produkt_Bus: 0,
        Produkt_UBahn: 0,
        Produkt_Tram: 0,
        Produkt_SBahn: 0,
        Produkt_RBahn: 0,
    };
    if (!product) return productBooleans;

    switch (product.trim()) {
        case 'Bus':   productBooleans.Produkt_Bus = 1;   break;
        case 'UBahn': productBooleans.Produkt_UBahn = 1; break;
        case 'Tram':  productBooleans.Produkt_Tram = 1;  break;
        case 'SBahn': productBooleans.Produkt_SBahn = 1; break;
        case 'RBahn': productBooleans.Produkt_RBahn = 1; break;
    }

    return productBooleans;
}

/**
 * Extracts the gleis integer from a haltepunkt string
 * @param {String} haltepunkt
 * @returns {Number}
 */
const convertHaltepunktToInt = (haltepunkt) => {
    return parseInt(haltepunkt.split(':')[1], 10) || 0;
}

/**
 * @param {Number} Fahrtnummer
 * @param {String} Betriebstag
 * @param {String} Produkt
 * @param {Number} VGNKennung
 * @param {String} Haltepunkt
 * @param {String} Richtungstext
 * @param {Date}   AnkunftszeitSoll
 * @param {Number} AnkunftszeitVerspätung
 * @param {Date}   AbfahrtszeitSoll
 * @param {Number} AbfahrtszeitVerspätung
 */
const insertOrUpdateFahrtEntry = async (
    Fahrtnummer, Betriebstag, Produkt, VGNKennung, Haltepunkt,
    Richtungstext, AnkunftszeitSoll, AnkunftszeitVerspätung,
    AbfahrtszeitSoll, AbfahrtszeitVerspätung
) => {
    try {
        await client.insert({
            table: 'fahrten_halte',
            values: [{
                Fahrtnummer:                  parseInt(Fahrtnummer),
                Betriebstag:                  Betriebstag,
                Produkt:                      convertProductToInt(Produkt),
                VGNKennung:                   parseInt(VGNKennung),
                Haltepunkt:                   convertHaltepunktToInt(Haltepunkt),
                Richtungstext:                Richtungstext ?? '',
                AnkunftszeitSoll:             AnkunftszeitSoll  ?? null,
                'AnkunftszeitVerspätung':     AnkunftszeitVerspätung  ?? null,
                AbfahrtszeitSoll:             AbfahrtszeitSoll  ?? null,
                'AbfahrtszeitVerspätung':     AbfahrtszeitVerspätung  ?? null,
            }],
            format: 'JSONEachRow',
        });
    } catch (error) {
        throw error;
    }
}

/**
 * @param {Number}        VGNKennung
 * @param {String}        VAGKennung
 * @param {String}        Haltestellenname
 * @param {Number}        Latitude
 * @param {Number}        Longitude
 * @param {String}        Produkt
 */
const insertOrUpdateHaltestelle = async (VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkt) => {
    const { Produkt_Bus, Produkt_UBahn, Produkt_Tram, Produkt_SBahn, Produkt_RBahn } = convertProducttoBool(Produkt);
    try {
        await client.insert({
            table: 'haltestellen',
            values: [{
                VGNKennung:      parseInt(VGNKennung),
                VAGKennung:      VAGKennung.split(',').map(s => s.trim()),
                Haltestellenname: Haltestellenname,
                Latitude:        parseFloat(Latitude),
                Longitude:       parseFloat(Longitude),
                Produkt_Bus:     Produkt_Bus,
                Produkt_UBahn:   Produkt_UBahn,
                Produkt_Tram:    Produkt_Tram,
                Produkt_SBahn:   Produkt_SBahn,
                Produkt_RBahn:   Produkt_RBahn,
            }],
            format: 'JSONEachRow',
        });
    } catch (error) {
        throw error;
    }
}

module.exports = {
    insertOrUpdateHaltestelle,
    insertOrUpdateFahrtEntry,
}
