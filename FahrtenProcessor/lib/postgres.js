const db = require('pg');

const pool = new db.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
})

/**
 * Converts a product string to a integer
 * @param {String} product 
 * @returns {Number}
 */
const convertProductToInt = (product) => {
    switch (product) {
        case 'Bus':
            return 1;
        case 'UBahn':
            return 2;
        case 'Tram':
            return 3;
        case 'SBahn':
            return 4;
        case 'RBahn':
            return 5;
        default:
            return 0;
    }
}

const convertProducttoBool = (product) => {
    const productBooleans = {
        Produkt_Bus: false,
        Produkt_UBahn: false,
        Produkt_Tram: false,
        Produkt_SBahn: false,
        Produkt_RBahn: false,
    };
    if (!product) {
        return productBooleans;
    }

    switch (product.trim()) {
        case 'Bus':
            productBooleans.Produkt_Bus = true;
            break;
        case 'UBahn':
            productBooleans.Produkt_UBahn = true;
            break;
        case 'Tram':
            productBooleans.Produkt_Tram = true;
            break;
        case 'SBahn':
            productBooleans.Produkt_SBahn = true;
            break;
        case 'RBahn':
            productBooleans.Produkt_RBahn = true;
            break;
    }

    return productBooleans;
}

/**
 * Converts a line string to a gleis integer
 * @param {String} haltepunkt 
 * @returns {Number}
 */
const convertHaltepunktToInt = (haltepunkt) => {
    return haltepunkt.split(':')[1];
}

/**
 * 
 * @param {Number} Fahrtnummer 
 * @param {String} Betriebstag 
 * @param {String} Produkt 
 * @param {Number} VGNKennung 
 * @param {String} Haltepunkt 
 * @param {String} Richtungstext 
 * @param {Date} AnkunftszeitSoll 
 * @param {Number} AnkunftszeitVerspätung 
 * @param {Date} AbfahrtszeitSoll 
 * @param {Number} AbfahrtszeitVerspätung 
 */
const insertOrUpdateFahrtEntry = async (Fahrtnummer, Betriebstag, Produkt, VGNKennung, Haltepunkt, Richtungstext, AnkunftszeitSoll, AnkunftszeitVerspätung, AbfahrtszeitSoll, AbfahrtszeitVerspätung) => {
    const query = `INSERT INTO fahrten_halte (Fahrtnummer, Betriebstag, Produkt, VGNKennung, Haltepunkt, Richtungstext, AnkunftszeitSoll, AnkunftszeitVerspätung, AbfahrtszeitSoll, AbfahrtszeitVerspätung) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (Fahrtnummer, Betriebstag, Produkt, VGNKennung) DO UPDATE SET 
    Haltepunkt = $5, 
    Richtungstext = $6, 
    AnkunftszeitSoll = $7, 
    AnkunftszeitVerspätung = $8, 
    AbfahrtszeitSoll = $9, 
    AbfahrtszeitVerspätung = $10;`;
    const values = [Fahrtnummer, Betriebstag, convertProductToInt(Produkt), VGNKennung, convertHaltepunktToInt(Haltepunkt), Richtungstext, AnkunftszeitSoll, AnkunftszeitVerspätung, AbfahrtszeitSoll, AbfahrtszeitVerspätung];
    try {
        await pool.query(query, values);
    } catch (error) {
        throw error;
    }
}

/**
 * 
 * @param {Number} VGNKennung 
 * @param {Array<String>} VAGKennung 
 * @param {String} Haltestellenname 
 * @param {Number} Latitude 
 * @param {Number} Longitude 
 * @param {String} Produkt 
 */
const insertOrUpdateHaltestelle = async (VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkt) => {
    const { Produkt_Bus, Produkt_UBahn, Produkt_Tram, Produkt_SBahn, Produkt_RBahn } = convertProducttoBool(Produkt);
    const query = `INSERT INTO haltestellen (VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkt_Bus, Produkt_UBahn, Produkt_Tram, Produkt_SBahn, Produkt_RBahn) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (VGNKennung) DO UPDATE SET
    VAGKennung = $2,
    Haltestellenname = $3,
    Latitude = $4,
    Longitude = $5,
    Produkt_Bus = $6,
    Produkt_UBahn = $7,
    Produkt_Tram = $8,
    Produkt_SBahn = $9,
    Produkt_RBahn = $10;`;
    const values = [VGNKennung, VAGKennung.split(','), Haltestellenname, Latitude, Longitude, Produkt_Bus, Produkt_UBahn, Produkt_Tram, Produkt_SBahn, Produkt_RBahn];
    try {
        await pool.query(query, values);
    } catch (error) {
        throw error
    }
}

module.exports = {
    insertOrUpdateHaltestelle,
    insertOrUpdateFahrtEntry
}