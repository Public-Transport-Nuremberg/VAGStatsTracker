const { createClient } = require('@clickhouse/client');

const client = createClient({
  url: `http://${process.env.CH_HOST}:${process.env.CH_PORT || 8123}`,
  username: process.env.CH_USER,
  password: process.env.CH_PASSWORD,
  database: process.env.CH_DATABASE,
});

/**
 * Converts a product string to a integer
 */
const convertProductToInt = (product) => {
    switch (product) {
        case 'Bus':   return 1;
        case 'UBahn': return 2;
        case 'Tram':  return 3;
        case 'SBahn': return 4;
        case 'RBahn': return 5;
        default:      return 0;
    }
}

/**
 * Converts a besetzungsgrad string to a integer
 */
const convertBesezungsgradToInt = (besetzungsgrad) => {
    switch (besetzungsgrad) {
        case 'Unbekannt':     return 1;
        case 'Schwachbesetzt': return 2;
        case 'Starkbesetzt':  return 3;
        case 'Ueberfuellt':   return 4;
        default:
            // Assuming you have a logger attached to process, otherwise use console
            if (process.log) process.log.warn('Unknown Besetzungsgrad:', besetzungsgrad);
            return 0;
    }
}

/**
 * Seperate the richtung from the string and convert it to a integer
 */
const convertRichtungToInt = (Richtung) => {
    if (typeof Richtung === 'string') {
        const matches = Richtung.match(/\d+/);
        return matches ? parseInt(matches[0], 10) : 0;
    }
    if (process.log) process.log.warn('Unknown Richtung:', Richtung);
    return 0;
}

/**
 * Maps to 'fahrten' table
 */
const insertOrUpdateFahrt = async (Fahrtnummer, Betriebstag, Produkt, Linienname, Besetzungsgrad, Fahrzeugnummer, Richtung) => {
    // Original logic: handle "PVU" special case
    let finalFahrzeugnummer = Fahrzeugnummer === "PVU" ? 0 : parseInt(Fahrzeugnummer);

    try {
        await client.insert({
            table: 'fahrten',
            values: [{
                Fahrtnummer:    parseInt(Fahrtnummer),
                Betriebstag:    Betriebstag,
                Produkt:        convertProductToInt(Produkt),
                Linienname:     Linienname,
                Besetzungsgrad: convertBesezungsgradToInt(Besetzungsgrad),
                Fahrzeugnummer: finalFahrzeugnummer,
                Richtung:       convertRichtungToInt(Richtung),
                _updated_at:    new Date() // Required for your ReplacingMergeTree
            }],
            format: 'JSONEachRow',
        });
    } catch (error) {
        throw error;
    }
};

module.exports = {
    insertOrUpdateFahrt
}