const db = require('pg');
const { SQLError } = require('@lib/errors');

const pool = new db.Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
})

const createTables = async () => {
  try {
    await createTable(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`, "uuid-ossp extension");
    // Create User Table
    await createTable(`CREATE TABLE IF NOT EXISTS haltestellen
  (
      VGNKennung       smallint PRIMARY KEY,
      VAGKennung       text[],
      Haltestellenname text,
      Latitude         double precision,
      Longitude        double precision,
      Produkt_Bus      boolean,
      Produkt_UBahn    boolean,
      Produkt_Tram     boolean,
      Produkt_SBahn    boolean,
      Produkt_RBahn    boolean,
      timestamptz      timestamp WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );`, "haltestellen")
    await createTable(`CREATE TABLE IF NOT EXISTS fahrten
  (
      Fahrtnummer      integer,
      Betriebstag      date,
      Produkt          smallint,
      Linienname       text,
      Besetzungsgrad   smallint,
      Fahrzeugnummer   integer,
      Richtung         smallint,
      PRIMARY KEY (Fahrtnummer, Betriebstag, Produkt)
  );`, "fahrten")
    await createTable(`CREATE TABLE IF NOT EXISTS fahrten_halte
  (
      Fahrtnummer      integer,
      Betriebstag      date,
      Produkt          smallint,
      VGNKennung       smallint,
      Haltepunkt       smallint,
      Richtungstext    text,
      AnkunftszeitSoll timestamp WITH TIME ZONE,
      AnkunftszeitVerspätung smallint,
      AbfahrtszeitSoll timestamp WITH TIME ZONE,
      AbfahrtszeitVerspätung smallint,
      FOREIGN KEY (Fahrtnummer, Betriebstag, Produkt) REFERENCES fahrten(Fahrtnummer, Betriebstag, Produkt) ON DELETE CASCADE,
      FOREIGN KEY (VGNKennung) REFERENCES haltestellen (VGNKennung) ON DELETE CASCADE,
      PRIMARY KEY (Fahrtnummer, Betriebstag, Produkt, VGNKennung)
  );`, "fahrten_halte")
    // Create Indexes
    await createTable(`create index if not exists fahrten_halte_betriebstag_vgnkennung_index
  on fahrten_halte (betriebstag desc, vgnkennung asc);`)
    await createTable(`CREATE MATERIALIZED VIEW IF NOT EXISTS delay_map AS
      SELECT (SUM(AbfahrtszeitVerspätung) / COUNT(*)) AS avg_delay, h.VGNKennung, h.Latitude, h.Longitude, Betriebstag
      FROM fahrten_halte
        INNER JOIN haltestellen h on fahrten_halte.VGNKennung = h.VGNKennung
      WHERE Betriebstag > (CURRENT_DATE - INTERVAL '31 days')
      GROUP BY h.VGNKennung, Betriebstag;`, "VIEW: delay_map")
    await createTable(`CREATE MATERIALIZED VIEW IF NOT EXISTS delay_per_vehicle AS
    SELECT
      f.Fahrzeugnummer,
      (SUM(AbfahrtszeitVerspätung) / COUNT(*)) AS avg_delay,
      f.Betriebstag
    FROM
      fahrten f
    INNER JOIN fahrten_halte fh ON f.Fahrtnummer = fh.Fahrtnummer
      AND f.Betriebstag = fh.Betriebstag
      AND f.Produkt = fh.Produkt
    WHERE
      f.Betriebstag > (CURRENT_DATE - INTERVAL '31 days')
    GROUP BY
      f.Fahrzeugnummer, f.Betriebstag;`, "VIEW: delay_per_vehicle")
    await createTable(`CREATE MATERIALIZED VIEW IF NOT EXISTS delay_per_line AS
    SELECT
      f.Linienname,
      (SUM(AbfahrtszeitVerspätung) / COUNT(*)) AS avg_delay,
      f.Betriebstag
    FROM
      fahrten f
    INNER JOIN fahrten_halte fh ON f.Fahrtnummer = fh.Fahrtnummer
      AND f.Betriebstag = fh.Betriebstag
      AND f.Produkt = fh.Produkt
    WHERE
      f.Betriebstag > (CURRENT_DATE - INTERVAL '31 days')
    GROUP BY
      f.Linienname, f.Betriebstag;`)
    await createTable(`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    puuid UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    username text UNIQUE,
    time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`, "users")
    // Create Webtoken Table
    await createTable(`CREATE TABLE IF NOT EXISTS webtokens (
      user_id integer,
      token text PRIMARY KEY,
      browser text,
      time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`, "webtokens");
  } catch (error) {
    throw new SQLError(error);
  }
}

/**
 * Create a new table
 * @param {String} query 
 * @param {String} table 
 * @returns 
 */
const createTable = (query, table) => {
  return new Promise((resolve, reject) => {
    pool.query(query, (err, result) => {
      if (err) { process.log.error(`Table-gen: Error ${table}: ${err}`) }
      if (err) reject();
      resolve(result);
    });
  })
}

/* --- --- --- --- --- MISC --- --- --- --- --- */

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
  const productTypes = product.split(',');

  productTypes.forEach(type => {
    switch (type.trim()) {
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
  });

  return productBooleans;
}

/* --- --- --- --- --- Querys --- --- --- --- --- */

/* --- --- --- Haltestellen --- --- --- */

/**
 * 
 * @param {Number} VGNKennung 
 * @param {Array<String>} VAGKennung 
 * @param {String} Haltestellenname 
 * @param {Number} Latitude 
 * @param {Number} Longitude 
 * @param {Array<String>} Produkte 
 */
const insertOrUpdateHaltestelle = async (VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkte) => {
  const { Produkt_Bus, Produkt_UBahn, Produkt_Tram, Produkt_SBahn, Produkt_RBahn } = convertProducttoBool(Produkte);
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

const getAllHaltestellen = () => {
  return new Promise((resolve, reject) => {
    pool.query(`SELECT * FROM haltestellen`, (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/* --- --- --- Views --- --- --- */

/**
 * Update the delay_map view
 */
const updateView_delay_map = () => {
  return new Promise((resolve, reject) => {
    pool.query(`REFRESH MATERIALIZED VIEW delay_map;`, (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Update the delay_per_vehicle view
 */
const updateView_delay_per_vehicle = () => {
  return new Promise((resolve, reject) => {
    pool.query(`REFRESH MATERIALIZED VIEW delay_per_vehicle;`, (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Update the delay_per_line view
 */
const updateView_delay_per_line = () => {
  return new Promise((resolve, reject) => {
    pool.query(`REFRESH MATERIALIZED VIEW delay_per_line;`, (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/* --- --- --- HeatMap --- --- --- */

/**
 * Get HeatMap Data for a specific day
 * @param {String} day 
 * @returns {Promise<Array>}
 */
const getHeatMapDataDay = (day) => {
  return new Promise((resolve, reject
  ) => {
    pool.query(`SELECT * FROM delay_map WHERE Betriebstag = $1`, [day], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/**
 * Get HeatMap Data for a specific time frame
 * @param {String} start 
 * @param {String} end 
 * @returns {Promise<Array>}
 */
const getHeatMapTimeFrame = (start, end) => {
  return new Promise((resolve, reject
  ) => {
    pool.query(`SELECT * FROM delay_map WHERE Betriebstag BETWEEN $1 AND $2`, [start, end], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/* --- --- --- TopLists --- ---- --- */

/**
 * Get TopList for delays by stops
 * @param {String} day 
 * @returns {Promise<Array>}
 */
const getTopListDelayByStops = (day) => {
  return new Promise((resolve, reject
  ) => {
    pool.query(`SELECT * FROM delay_map WHERE Betriebstag = $1 ORDER BY avg_delay DESC`, [day], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/**
 * Get TopList for delays by vehicles
 * @param {String} day
 */
const getTopListDelayByVehicles = (day) => {
  return new Promise((resolve, reject
  ) => {
    pool.query(`SELECT * FROM delay_per_vehicle WHERE Betriebstag = $1 ORDER BY avg_delay DESC`, [day], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/**
 * Get TopList for delays by lines
 * @param {String} day
 */
const getTopListDelayByLines = (day) => {
  return new Promise((resolve, reject
  ) => {
    pool.query(`SELECT * FROM delay_per_line WHERE Betriebstag = $1 ORDER BY avg_delay DESC`, [day], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/* --- --- --- Webtokens --- --- --- */

/**
 * Insert a new Webtoken
 * @param {Number} user_id
 * @param {String} token
 * @param {String} browser
 * @returns 
 */
const WebtokensCreate = (user_id, token, browser) => {
  return new Promise((resolve, reject) => {
    pool.query(`INSERT INTO webtokens (user_id, token, browser) VALUES ($1, $2, $3)`, [user_id, token, browser], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Get data from a Webtoken
 * @param {String} token 
 * @returns 
 */
const WebtokensGet = (token) => {
  return new Promise((resolve, reject) => {
    // Join the users, userssettings table with the webtokens table
    pool.query(`SELECT webtokens.user_id, webtokens.token, webtokens.browser, webtokens.time, users_settings.design, users_settings.language, users.puuid, users.username, users.user_group, users.avatar_url FROM webtokens INNER JOIN users ON webtokens.user_id = users.id INNER JOIN users_settings ON webtokens.user_id = users_settings.user_id WHERE token = $1`, [token], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/**
 * Remove a Webtoken from the database
 * @param {String} token 
 * @returns 
 */
const WebtokensDelete = (token) => {
  return new Promise((resolve, reject) => {
    pool.query(`DELETE FROM webtokens WHERE token = $1`, [token], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

const getDistinctLines = () => {
  return new Promise((resolve, reject) => {
    pool.query(`SELECT DISTINCT Linienname FROM fahrten`, (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

const getavragedelayperline = (line, days) => {
  return new Promise((resolve, reject) => {
    pool.query(`WITH time_buckets AS (
    SELECT 
      fh.VGNKennung,
      h.Haltestellenname,
      h.Latitude,
      h.Longitude,
      f.Richtung,
      CASE 
        WHEN (EXTRACT(HOUR FROM fh.AnkunftszeitSoll) + 1) = 24 THEN 0
        ELSE (EXTRACT(HOUR FROM fh.AnkunftszeitSoll) + 1)
      END AS time_bucket,
      COUNT(*) AS trip_count,
      AVG(fh.AnkunftszeitVerspätung) AS avg_arrival_delay,
      AVG(fh.AbfahrtszeitVerspätung) AS avg_departure_delay
    FROM fahrten_halte fh
    JOIN fahrten f ON fh.Fahrtnummer = f.Fahrtnummer 
      AND fh.Betriebstag = f.Betriebstag 
      AND fh.Produkt = f.Produkt
    JOIN haltestellen h ON fh.VGNKennung = h.VGNKennung
    WHERE f.Linienname = $1
      AND fh.Betriebstag >= CURRENT_DATE - ($2 || ' days')::INTERVAL
    GROUP BY fh.VGNKennung, h.Haltestellenname, h.Latitude, h.Longitude, f.Richtung, time_bucket
    ORDER BY fh.VGNKennung, f.Richtung, time_bucket
    )
    SELECT 
      VGNKennung,
      Haltestellenname,
      Latitude,
      Longitude,
      Richtung,
      time_bucket,
      trip_count,
      COALESCE(avg_arrival_delay, 0) AS avg_arrival_delay,
      COALESCE(avg_departure_delay, 0) AS avg_departure_delay
    FROM time_buckets;`, [line, days], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

const getVehicleHistory = (vehicle, days) => {
  return new Promise((resolve, reject) => {
    pool.query(`SELECT
      h.Haltestellenname,
      h.Latitude,
      h.Longitude,
      COALESCE(fh.AbfahrtszeitSoll, fh.AnkunftszeitSoll) AS Zeitpunkt
    FROM
      fahrten AS f
    JOIN
      fahrten_halte AS fh
      ON f.Fahrtnummer = fh.Fahrtnummer
      AND f.Betriebstag = fh.Betriebstag
      AND f.Produkt = fh.Produkt
    JOIN
      haltestellen AS h
      ON fh.VGNKennung = h.VGNKennung
    WHERE
      f.Fahrzeugnummer = $1 AND f.Betriebstag = $2
    ORDER BY
      COALESCE(fh.AbfahrtszeitSoll, fh.AnkunftszeitSoll);`, [vehicle, days], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  });
}

/* --- --- --- Exports --- --- --- */

const views = {
  update_delay_map: updateView_delay_map,
  update_delay_per_vehicle: updateView_delay_per_vehicle,
  update_delay_per_line: updateView_delay_per_line,
  topList: {
    delayByStops: getTopListDelayByStops,
    delayByVehicles: getTopListDelayByVehicles,
    delayByLines: getTopListDelayByLines
  }
}

const haltestellen = {
  insertOrUpdate: insertOrUpdateHaltestelle,
  getAllHaltestellen: getAllHaltestellen
}

const heatmap = {
  getDay: getHeatMapDataDay,
  getTimeFrame: getHeatMapTimeFrame
}

const statistics = {
  getDistinctLines: getDistinctLines,
  getAvgDelayByLine: getavragedelayperline
}

const vehicle = {
  getHistory: getVehicleHistory
}

const webtoken = {
  create: WebtokensCreate,
  get: WebtokensGet,
  delete: WebtokensDelete
}

module.exports = {
  createTables,
  views,
  heatmap,
  haltestellen,
  statistics,
  vehicle,
  webtoken
}