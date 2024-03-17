const { haltestellen } = require('@lib/postgres');
const { formatDBHaltestellenToPULSFormat } = require('@lib/haltestellen_utils');

class DB_Store {
    constructor() {
        if (!DB_Store.APIResponse) {
            DB_Store.APIResponse = null;
        }

        setInterval(() => {
            this.update();
        }, 1000 * 60);
    }

    /**
     * Initializes the Database
     * @returns {Promise<Boolean>}
     */
    init = async () => {
        if (DB_Store.APIResponse) {
            process.log.system('Using cached data');
            for (const station of DB_Store.APIResponse) {
                this.set(station.VGNKennung, station);
            }
            return true;
        }

        try {
            process.log.system('Fetching Haltestellen Data from API');
            const response = await fetch('https://start.vag.de/dm/api/v1/haltestellen/vgn?name=');
            const jsonData = await response.json();
            process.log.system('Haltestellen Data fetched');

            DB_Store.APIResponse = jsonData.Haltestellen;

            // `set` is a method in subclasses
            for (const station of jsonData.Haltestellen) {
                this.set(station.VGNKennung, station);
            }

            return true;
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    update = async () => {
        try {
            const allStops = await haltestellen.getAllHaltestellen();
            const result = formatDBHaltestellenToPULSFormat(allStops);
            DB_Store.APIResponse = result;
            // `set` is a method in subclasses
            for (const station of result) {
                this.set(station.VGNKennung, station);
            }

            return true;
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    /**
     * Returns all available keys
     * @returns {Array<String>}
     */
    getKeysAmount = () => {
        return DB_Store.APIResponse ? DB_Store.APIResponse.map(station => station.VGNKennung) : [];
    }

    /**
     * @typedef {Object} Haltestelle
     * @property {String} Haltestellenname
     * @property {String} VAGKennung
     * @property {Number} VGNKennung
     * @property {Number} Longitude
     * @property {Number} Latitude
     * @property {String} Produkte
     */
}

class ObjectStore extends DB_Store {
    constructor() {
        super();
        this.asyncNature = false;
        this.data = {};
    }

    /**
     * Stores a value in the database
     * @param {String} key
     * @param {Haltestelle} value
     */
    set(key, value) {
        if (!key || !value) throw new Error('Missing Parameters')
        this.data[key] = value;
    }

    /**
     * Gets a value from the database
     * @param {String} key
     * @returns {Haltestelle}
     */
    get(key) {
        if (!key) throw new Error('Missing Parameters')
        return this.data[key];
    }

    /**
     * Returns the length of the database
     * @returns {Number}
     */
    length() {
        return Object.keys(this.data).length;
    }

    /**
     * "SQL" like query
     * @param {String} pattern 
     * @param {String} attributeName 
     * @param {Object} currentResults 
     * @returns 
     */
    like(pattern, attributeName, currentResults) {
        const regexPattern = pattern.toString().split('_').join('.').split('%').join('.*');
        const regex = new RegExp(regexPattern, 'i');
        let result = [];

        const itemsToSearch = currentResults ?? Object.values(this.data);

        itemsToSearch.forEach(item => {
            const attributeValue = item[attributeName];
            if (attributeValue !== undefined && regex.test(attributeValue.toString())) {
                result.push(item);
            }
        });

        return result;
    }

    /**
     * Calculates the distance using the haversine formula
     * @param {Kooridnate} coords1 
     * @param {Kooridnate} coords2 
     * @returns {Number}
     */
    haversineDistance(coords1, coords2) {
        const radPerDeg = Math.PI / 180;
        const R = 6371000; // Earth radius in meters
        const lat1Rad = coords1.Latitude * radPerDeg;
        const lat2Rad = coords2.Latitude * radPerDeg;
        const dLat = (coords2.Latitude - coords1.Latitude) * radPerDeg;
        const dLon = (coords2.Longitude - coords1.Longitude) * radPerDeg;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Pass a object with values you want the database to be filtered by
     * @param {Object} query 
     * @returns 
     */
    filterByQuery(query) {
        let results = null;
        
        if(Object.keys(query).length === 0) return Object.values(this.data); // If the query is empty, return all values (no filtering needed)

        Object.keys(query).forEach(key => {
            results = this.like(query[key], key, results || Object.values(this.data)); // Reuse the results from the previous query
        });

        return results;
    }

    /**
     * Returns all stations in the range of the given coordinates
     * @param {Kooridnate} cordinates 
     * @param {Number} range 
     * @returns {Array<GeoHaltestelle>}
     */
    findNearbyStations(cordinates, range) {
        let result = [];
        for (let key in this.data) {
            const station = this.data[key];
            const distance = this.haversineDistance(cordinates, station);
            if (distance <= range) {
                station.distanz = distance; // Computing this anyway why not add it to the payload
                result.push(station);
            }
        }
        return result;
    }

    /**
     * Returns the async nature of the store
     */
    get getasyncNature() {
        return this.asyncNature;
    }
}

// Depricated for now, no reason to use this on Ryzen 3D CPUs
class MapStore extends DB_Store {
    constructor() {
        if (ClusterController.instance) {
            return ClusterController.instance;
        }
        super();

        ClusterController.instance = this;

        this.asyncNature = false;
        this.data = new Map();
    }

    /**
     * Stores a value in the database
     * @param {String} key
     * @param {Haltestelle} value
     */
    set(key, value) {
        if (!key || !value) throw new Error('Missing Parameters')
        this.data.set(key, value);
    }

    /**
     * Gets a value from the database (Input VGNKennung)
     * @param {Number} key
     * @returns {Haltestelle}
     */
    get(key) {
        if (!key) throw new Error('Missing Parameters')
        return this.data.get(key);
    }

    /**
     * Returns the length of the database
     * @returns {Number}
     */
    length() {
        return this.data.size
    }

    /**
     * Returns the async nature of the store
     */
    get getasyncNature() {
        return this.asyncNature;
    }
}

module.exports = {
    StopObjectStore: new ObjectStore(),
    MapStore,
}