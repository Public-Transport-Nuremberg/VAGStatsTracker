const { createClient } = require('@clickhouse/client');

const client = createClient({
  url: `http://${process.env.CH_HOST}:${process.env.CH_PORT || 8123}`,
  username: process.env.CH_USER,
  password: process.env.CH_PASSWORD,
  database: process.env.CH_DATABASE,
});

/**
 * Helpers
 */
const convertProductToInt = (product) => {
    const mapping = { 'Bus': 1, 'UBahn': 2, 'Tram': 3, 'SBahn': 4, 'RBahn': 5 };
    return mapping[product] || 0;
};

const convertProducttoBoolInt = (product) => {
    const products = {
        Produkt_Bus: 0, Produkt_UBahn: 0, Produkt_Tram: 0,
        Produkt_SBahn: 0, Produkt_RBahn: 0,
    };
    if (!product) return products;
    const key = `Produkt_${product.trim()}`;
    if (key in products) products[key] = 1; 
    return products;
};

const convertHaltepunktToInt = (haltepunkt) => {
    if (!haltepunkt || !haltepunkt.includes(':')) return 0;
    return parseInt(haltepunkt.split(':')[1], 10);
};

/**
 * Maps to 'fahrten_halte' table
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
                Fahrtnummer: parseInt(Fahrtnummer),
                Betriebstag, 
                Produkt: convertProductToInt(Produkt),
                VGNKennung: parseInt(VGNKennung),
                Haltepunkt: convertHaltepunktToInt(Haltepunkt),
                Richtungstext,
                AnkunftszeitSoll: AnkunftszeitSoll || null,
                AnkunftszeitVerspätung: AnkunftszeitVerspätung != null ? parseInt(AnkunftszeitVerspätung) : null,
                AbfahrtszeitSoll: AbfahrtszeitSoll || null,
                AbfahrtszeitVerspätung: AbfahrtszeitVerspätung != null ? parseInt(AbfahrtszeitVerspätung) : null,
                _updated_at: new Date()
            }],
            format: 'JSONEachRow',
        });
    } catch (error) {
        throw error;
    }
};

/**
 * Maps to 'haltestellen' table
 */
const insertOrUpdateHaltestelle = async (VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkt) => {
    const productBools = convertProducttoBoolInt(Produkt);
    try {
        await client.insert({
            table: 'haltestellen',
            values: [{
                VGNKennung: parseInt(VGNKennung),
                VAGKennung: VAGKennung.split(','),
                Haltestellenname,
                Latitude: parseFloat(Latitude),
                Longitude: parseFloat(Longitude),
                ...productBools,
                _updated_at: new Date()
            }],
            format: 'JSONEachRow',
        });
    } catch (error) {
        throw error;
    }
};

module.exports = {
    insertOrUpdateHaltestelle,
    insertOrUpdateFahrtEntry
};