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

/**
 * Converts a besetzungsgrad string to an integer
 * @param {String} besetzungsgrad
 * @returns {Number}
 */
const convertBesezungsgradToInt = (besetzungsgrad) => {
    switch (besetzungsgrad) {
        case 'Unbekannt':     return 1;
        case 'Schwachbesetzt': return 2;
        case 'Starkbesetzt':  return 3;
        case 'Ueberfuellt':   return 4;
        default:
            process.log.warn('Unknown Besetzungsgrad:', besetzungsgrad);
            return 0;
    }
}

/**
 * Extracts the numeric Richtung from a string
 * @param {String} Richtung
 * @returns {Number}
 */
const convertRichtungToInt = (Richtung) => {
    if (typeof Richtung === 'string') {
        const matches = Richtung.match(/\d+/);
        return matches ? parseInt(matches[0], 10) : 0;
    }
    process.log.warn('Unknown Richtung:', Richtung);
    return 0;
}

/**
 * @param {Number} Fahrtnummer
 * @param {String} Betriebstag
 * @param {String} Produkt
 * @param {String} Linienname
 * @param {String} Besetzungsgrad
 * @param {String} Fahrzeugnummer
 * @param {String} Richtung
 */
const insertOrUpdateFahrt = async (Fahrtnummer, Betriebstag, Produkt, Linienname, Besetzungsgrad, Fahrzeugnummer, Richtung) => {
    if (Fahrzeugnummer === 'PVU') Fahrzeugnummer = 0;
    try {
        await client.insert({
            table: 'fahrten',
            values: [{
                Fahrtnummer:    parseInt(Fahrtnummer),
                Betriebstag:    Betriebstag,
                Produkt:        convertProductToInt(Produkt),
                Linienname:     Linienname,
                Besetzungsgrad: convertBesezungsgradToInt(Besetzungsgrad),
                Fahrzeugnummer: parseInt(Fahrzeugnummer),
                Richtung:       convertRichtungToInt(Richtung),
            }],
            format: 'JSONEachRow',
        });
    } catch (error) {
        throw error;
    }
};

module.exports = {
    insertOrUpdateFahrt,
}
