const megahash = require('megahash');
const Redis = require('ioredis');

class DB_Store {
    constructor() {
        if (!DB_Store.APIResponse) {
            DB_Store.APIResponse = null;
        }
    }

    /**
     * Initializes the Database
     * @returns {Promise<Boolean>}
     */
    init = async () => {
        if (DB_Store.APIResponse) {
            console.log('Using cached data');
            for (const station of DB_Store.APIResponse) {
                this.set(station.VGNKennung, station);
            }
            return true;
        }

        try {
            console.log('Fetching Data from API');
            const response = await fetch('https://start.vag.de/dm/api/v1/haltestellen/vgn?name=');
            const jsonData = await response.json();
            console.log('Data fetched');

            DB_Store.APIResponse = jsonData.Haltestellen;

            // Assuming `set` is a method defined in this class or its subclasses
            // to store the station data somewhere, you need to implement it.
            for (const station of jsonData.Haltestellen) {
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
     
    // Implement the `set` method if it's not already implemented.
    // This method should handle how you store the data.
}

class ObectStore extends DB_Store {
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
     * Returns the async nature of the store
     */
    get getasyncNature() {
        return this.asyncNature;
    }
}

class MapStore extends DB_Store {
    constructor() {
        super();
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
     * Gets a value from the database
     * @param {String} key
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

class MegaHashStore extends DB_Store {
    constructor() {
        super();
        this.asyncNature = false;
        this.data = new megahash();
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
     * Gets a value from the database
     * @param {String} key
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
        return this.data.stats().numKeys;
    }

    /**
     * Returns the async nature of the store
     */
    get getasyncNature() {
        return this.asyncNature;
    }
}

class RedisStore extends DB_Store {
    constructor() {
        super();
        this.asyncNature = true;
        this.redis = new Redis(process.redisData); // Default connects to 127.0.0.1:6379
    }

    /**
     * Stores a value in the database asynchronously.
     * @param {String} key
     * @param {Haltestelle} value
     */
    async set(key, value) {
        if (!key || !value) throw new Error('Missing Parameters');
        await this.redis.set(key, JSON.stringify(value));
    }

    /**
     * Gets a value from the database asynchronously.
     * @param {String} key
     * @returns {Promise<Haltestelle>}
     */
    async get(key) {
        if (!key) throw new Error('Missing Parameters');
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
    }

    /**
     * Returns the number of keys in the database.
     * @returns {Promise<Number>}
     */
    async length() {
        const keys = await this.redis.keys('*');
        return keys.length;
    }

    /**
     * Returns the async nature of the store
     */
    get getasyncNature() {
        return this.asyncNature;
    }
}



module.exports = {
    ObectStore,
    MapStore,
    MegaHashStore,
    RedisStore
}