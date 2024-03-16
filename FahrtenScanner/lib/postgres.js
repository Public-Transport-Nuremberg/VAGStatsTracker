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

/**
 * Converts a besetzungsgrad string to a integer
 * @param {String} besetzungsgrad 
 * @returns {Number}
 */
const convertBesezungsgradToInt = (besetzungsgrad) => {
    switch (besetzungsgrad) {
        case 'Unbekannt':
            return 1;
        case 'Schwachbesetzt':
            return 2;
        case 'Mittelbesetzt':
            return 3;
        case 'Starkbesetzt':
            return 4;
        default:
            process.log.warn('Unknown Besetzungsgrad:', besetzungsgrad);
            return 0;
    }
}

/**
 * Seperate the richtung from the string and convert it to a integer
 * @param {String} Richtung 
 * @returns 
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
 * 
 * @param {Number} Fahrtnummer 
 * @param {String} Betriebstag 
 * @param {String} Produkt 
 * @param {String} Linienname 
 * @param {String} Besetzungsgrad 
 * @param {String} Richtung 
 */
const insertOrUpdateFahrt = async (Fahrtnummer, Betriebstag, Produkt, Linienname, Besetzungsgrad, Richtung) => {
    const query = `INSERT INTO fahrten (Fahrtnummer, Betriebstag, Produkt, Linienname, Besetzungsgrad, Fahrzeugnummer, Richtung) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (Fahrtnummer, Betriebstag, Produkt) DO UPDATE SET Linienname = $4, Besetzungsgrad = $5, Fahrzeugnummer = $6, Richtung = $7`;
    const values = [Fahrtnummer, Betriebstag, convertProductToInt(Produkt), Linienname, convertBesezungsgradToInt(Besetzungsgrad), 0, convertRichtungToInt(Richtung)];
    try {
        await pool.query(query, values);
    } catch (error) {
        throw error
    }
};

module.exports = {
    insertOrUpdateFahrt
}