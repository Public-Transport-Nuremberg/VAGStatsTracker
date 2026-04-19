const { createClient } = require('@clickhouse/client');
const { SQLError } = require('@lib/errors');

const client = createClient({
  url: `http://${process.env.CH_HOST}:${process.env.CH_PORT || 8123}`,
  username: process.env.CH_USER,
  password: process.env.CH_PASSWORD,
  database: process.env.CH_DATABASE,
});

/* --- --- --- --- --- Schema --- --- --- --- --- */

// Column names match the existing migrated tables (mixed-case, same as original Postgres DDL).
// All SELECT queries alias results to lowercase so downstream code is unchanged
// (Postgres always returned lowercase keys for unquoted identifiers).
const createTables = async () => {
  try {
    await createTable(`
      CREATE TABLE IF NOT EXISTS haltestellen (
        VGNKennung       Int16,
        VAGKennung       Array(String),
        Haltestellenname String,
        Latitude         Float64,
        Longitude        Float64,
        Produkt_Bus      UInt8,
        Produkt_UBahn    UInt8,
        Produkt_Tram     UInt8,
        Produkt_SBahn    UInt8,
        Produkt_RBahn    UInt8,
        _updated_at      DateTime DEFAULT now()
      ) ENGINE = ReplacingMergeTree(_updated_at)
      ORDER BY VGNKennung
    `, 'haltestellen');

    await createTable(`
      CREATE TABLE IF NOT EXISTS fahrten (
        Fahrtnummer    Int32,
        Betriebstag    Date,
        Produkt        Int8,
        Linienname     String,
        Besetzungsgrad Int8,
        Fahrzeugnummer Int32,
        Richtung       Int8,
        _updated_at    DateTime DEFAULT now()
      ) ENGINE = ReplacingMergeTree(_updated_at)
      PARTITION BY toYYYYMM(Betriebstag)
      ORDER BY (Betriebstag, Fahrtnummer, Produkt)
    `, 'fahrten');

    await createTable(`
      CREATE TABLE IF NOT EXISTS fahrten_halte (
        Fahrtnummer              Int32,
        Betriebstag              Date,
        Produkt                  Int8,
        VGNKennung               Int16,
        Haltepunkt               Int16,
        Richtungstext            String,
        AnkunftszeitSoll         Nullable(DateTime),
        \`AnkunftszeitVerspätung\` Nullable(Int16),
        AbfahrtszeitSoll         Nullable(DateTime),
        \`AbfahrtszeitVerspätung\` Nullable(Int16),
        _updated_at              DateTime DEFAULT now()
      ) ENGINE = ReplacingMergeTree(_updated_at)
      PARTITION BY toYYYYMM(Betriebstag)
      ORDER BY (Betriebstag, VGNKennung, Fahrtnummer, Produkt)
    `, 'fahrten_halte');
  } catch (error) {
    throw new SQLError(error);
  }
}

const createTable = async (query, table) => {
  try {
    await client.exec({ query });
  } catch (err) {
    process.log.error(`Table-gen: Error ${table}: ${err}`);
    throw err;
  }
}

/* --- --- --- --- --- MISC --- --- --- --- --- */

const convertProducttoBool = (product) => {
  const productBooleans = {
    Produkt_Bus: 0,
    Produkt_UBahn: 0,
    Produkt_Tram: 0,
    Produkt_SBahn: 0,
    Produkt_RBahn: 0,
  };
  if (!product) return productBooleans;

  product.split(',').forEach(type => {
    switch (type.trim()) {
      case 'Bus': productBooleans.Produkt_Bus = 1; break;
      case 'UBahn': productBooleans.Produkt_UBahn = 1; break;
      case 'Tram': productBooleans.Produkt_Tram = 1; break;
      case 'SBahn': productBooleans.Produkt_SBahn = 1; break;
      case 'RBahn': productBooleans.Produkt_RBahn = 1; break;
    }
  });

  return productBooleans;
}

/* --- --- --- --- --- Queries --- --- --- --- --- */

/* --- --- --- Haltestellen --- --- --- */

const insertOrUpdateHaltestelle = async (VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkte) => {
  const { Produkt_Bus, Produkt_UBahn, Produkt_Tram, Produkt_SBahn, Produkt_RBahn } = convertProducttoBool(Produkte);
  try {
    await client.insert({
      table: 'haltestellen',
      values: [{
        VGNKennung: parseInt(VGNKennung),
        VAGKennung: VAGKennung.split(',').map(s => s.trim()),
        Haltestellenname,
        Latitude: parseFloat(Latitude),
        Longitude: parseFloat(Longitude),
        Produkt_Bus,
        Produkt_UBahn,
        Produkt_Tram,
        Produkt_SBahn,
        Produkt_RBahn,
      }],
      format: 'JSONEachRow',
    });
  } catch (error) {
    throw error;
  }
}

// Alias all columns to lowercase — downstream code expects Postgres-style lowercase keys.
const getAllHaltestellen = async () => {
  const rs = await client.query({
    query: `
      SELECT
        VGNKennung       AS vgnkennung,
        VAGKennung       AS vagkennung,
        Haltestellenname AS haltestellenname,
        Latitude         AS latitude,
        Longitude        AS longitude,
        Produkt_Bus      AS produkt_bus,
        Produkt_UBahn    AS produkt_ubahn,
        Produkt_Tram     AS produkt_tram,
        Produkt_SBahn    AS produkt_sbahn,
        Produkt_RBahn    AS produkt_rbahn
      FROM haltestellen FINAL
    `,
    format: 'JSONEachRow',
  });
  return await rs.json();
}

/* --- --- --- HeatMap --- --- --- */

const getHeatMapDataDay = async (day) => {
  const rs = await client.query({
    query: `
      SELECT
        avg(fh.\`AbfahrtszeitVerspätung\`) AS avg_delay,
        fh.VGNKennung                     AS vgnkennung,
        h.Latitude                        AS latitude,
        h.Longitude                       AS longitude,
        fh.Betriebstag                    AS betriebstag
      FROM fahrten_halte AS fh
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE fh.Betriebstag = {day:Date}
        AND isNotNull(fh.\`AbfahrtszeitVerspätung\`)
      GROUP BY fh.VGNKennung, h.Latitude, h.Longitude, fh.Betriebstag
    `,
    query_params: { day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const getHeatMapTimeFrame = async (start, end) => {
  const rs = await client.query({
    query: `
      SELECT
        avg(fh.\`AbfahrtszeitVerspätung\`) AS avg_delay,
        fh.VGNKennung                     AS vgnkennung,
        h.Latitude                        AS latitude,
        h.Longitude                       AS longitude,
        fh.Betriebstag                    AS betriebstag
      FROM fahrten_halte AS fh
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE fh.Betriebstag BETWEEN {start:Date} AND {end:Date}
        AND isNotNull(fh.\`AbfahrtszeitVerspätung\`)
      GROUP BY fh.VGNKennung, h.Latitude, h.Longitude, fh.Betriebstag
    `,
    query_params: { start, end },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

/**
 * Generates a histogram of arrival delays with ClickHouse summary metadata.
 * @param {Date} startDate - The start date for the histogram.
 * @param {Date} endDate - The end date for the histogram.
 * @param {number} binSize - The size of each bin in seconds.
 * @param {Object} filters - Optional filters for the histogram.
 * @param {string} [filters.linienname] - Filter by line name.
 * @param {number} [filters.produkt] - Filter by product.
 * @param {string} [filters.fahrzeugnummer] - Filter by vehicle number.
 * @param {number} [filters.minDelay] - Minimum delay in seconds.
 * @param {number} [filters.maxDelay] - Maximum delay in seconds.
 */
const getDelayHistogram = async (startDate, endDate, binSize = 60, filters = {}) => {
  const { linienname, produkt, fahrzeugnummer, minDelay, maxDelay } = filters;

  let filterClauses = [
    `f.Betriebstag BETWEEN '${startDate.toISOString().split('T')[0]}' AND '${endDate.toISOString().split('T')[0]}'`
  ];

  if (linienname) filterClauses.push(`f.Linienname = '${linienname}'`);
  if (produkt !== undefined) filterClauses.push(`f.Produkt = ${produkt}`);
  if (fahrzeugnummer) filterClauses.push(`f.Fahrzeugnummer = ${fahrzeugnummer}`);
  if (minDelay !== undefined) filterClauses.push(`fh.\`AnkunftszeitVerspätung\` >= ${minDelay}`);
  if (maxDelay !== undefined) filterClauses.push(`fh.\`AnkunftszeitVerspätung\` <= ${maxDelay}`);

  const query = `
        SELECT
            floor(fh.\`AnkunftszeitVerspätung\` / ${binSize}) * ${binSize} AS bin_start,
            count() AS count
        FROM fahrten_halte AS fh
        INNER JOIN fahrten AS f 
            ON fh.Fahrtnummer = f.Fahrtnummer 
            AND fh.Betriebstag = f.Betriebstag 
            AND fh.Produkt = f.Produkt
        WHERE ${filterClauses.join(' AND ')}
          AND fh.\`AnkunftszeitVerspätung\` IS NOT NULL
        GROUP BY bin_start
        ORDER BY bin_start ASC
    `;

  try {
    const rs = await client.query({
      query: query,
      format: 'JSONEachRow',
      clickhouse_settings: {
        send_progress_in_http_headers: 1
      }
    });

    const result = await rs.json();
    const headers = rs.response_headers
    const summary = JSON.parse(headers['x-clickhouse-summary'])

    return { result, summary };
  } catch (error) {
    console.error('Histogram Query Failed:', error);
    throw error;
  }
};

/* --- --- --- TopLists --- --- --- */

const getTopListDelayByStops = async (day) => {
  const rs = await client.query({
    query: `
      SELECT
        avg(fh.\`AbfahrtszeitVerspätung\`) AS avg_delay,
        fh.VGNKennung                     AS vgnkennung,
        h.Latitude                        AS latitude,
        h.Longitude                       AS longitude,
        fh.Betriebstag                    AS betriebstag
      FROM fahrten_halte AS fh
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE fh.Betriebstag = {day:Date}
        AND isNotNull(fh.\`AbfahrtszeitVerspätung\`)
      GROUP BY fh.VGNKennung, h.Latitude, h.Longitude, fh.Betriebstag
      ORDER BY avg_delay DESC
    `,
    query_params: { day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const getTopListDelayByVehicles = async (day) => {
  const rs = await client.query({
    query: `
      SELECT
        f.Fahrzeugnummer                  AS fahrzeugnummer,
        avg(fh.\`AbfahrtszeitVerspätung\`) AS avg_delay,
        f.Betriebstag                     AS betriebstag
      FROM fahrten AS f
      INNER JOIN fahrten_halte AS fh
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      WHERE f.Betriebstag = {day:Date}
        AND isNotNull(fh.\`AbfahrtszeitVerspätung\`)
      GROUP BY f.Fahrzeugnummer, f.Betriebstag
      ORDER BY avg_delay DESC
    `,
    query_params: { day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const getTopListDelayByLines = async (day) => {
  const rs = await client.query({
    query: `
      SELECT
        f.Linienname                      AS linienname,
        avg(fh.\`AbfahrtszeitVerspätung\`) AS avg_delay,
        f.Betriebstag                     AS betriebstag
      FROM fahrten AS f
      INNER JOIN fahrten_halte AS fh
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      WHERE f.Betriebstag = {day:Date}
        AND isNotNull(fh.\`AbfahrtszeitVerspätung\`)
      GROUP BY f.Linienname, f.Betriebstag
      ORDER BY avg_delay DESC
    `,
    query_params: { day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

/* --- --- --- Statistic and MISC --- --- --- */

const getDistinctLines = async () => {
  const rs = await client.query({
    query: 'SELECT DISTINCT Linienname AS linienname FROM fahrten',
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const getavragedelayperline = async (line, days) => {
  const rs = await client.query({
    query: `
      SELECT
        fh.VGNKennung                                                AS vgnkennung,
        h.Haltestellenname                                           AS haltestellenname,
        h.Latitude                                                   AS latitude,
        h.Longitude                                                  AS longitude,
        f.Richtung                                                   AS richtung,
        ifNull(((toHour(fh.AnkunftszeitSoll) + 1) % 24), 0)        AS time_bucket,
        count(*)                                                     AS trip_count,
        ifNull(avg(fh.\`AnkunftszeitVerspätung\`), 0)               AS avg_arrival_delay,
        ifNull(avg(fh.\`AbfahrtszeitVerspätung\`), 0)               AS avg_departure_delay
      FROM fahrten_halte AS fh
      INNER JOIN fahrten AS f
        ON fh.Fahrtnummer = f.Fahrtnummer
       AND fh.Betriebstag = f.Betriebstag
       AND fh.Produkt = f.Produkt
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE f.Linienname = {line:String}
        AND fh.Betriebstag >= today() - INTERVAL {days:Int32} DAY
      GROUP BY fh.VGNKennung, h.Haltestellenname, h.Latitude, h.Longitude, f.Richtung, time_bucket
      ORDER BY fh.VGNKennung, f.Richtung, time_bucket
    `,
    query_params: { line, days: parseInt(days) },
    format: 'JSONEachRow',
  });
  return rs.json();
}

const getVehicleHistory = async (vehicle, day) => {
  const rs = await client.query({
    query: `
      SELECT
        h.Haltestellenname                                              AS haltestellenname,
        h.Latitude                                                      AS latitude,
        h.Longitude                                                     AS longitude,
        coalesce(fh.AbfahrtszeitSoll, fh.AnkunftszeitSoll)              AS zeitpunkt,
        f.Linienname                                                    AS linienname,
        f.Produkt                                                       AS produkt,
        f.Besetzungsgrad                                                AS besetzungsgrad,
        fh.AnkunftszeitSoll                                             AS ankunftszeitsoll,
        fh.\`AnkunftszeitVerspätung\`                                   AS \`ankunftszeitverspätung\`,
        fh.AbfahrtszeitSoll                                             AS abfahrtszeitsoll,
        fh.\`AbfahrtszeitVerspätung\`                                   AS \`abfahrtszeitverspätung\`
      FROM fahrten AS f
      INNER JOIN fahrten_halte AS fh
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE f.Fahrzeugnummer = {vehicle:Int32}
        AND f.Betriebstag = {day:Date}
      ORDER BY coalesce(fh.AbfahrtszeitSoll, fh.AnkunftszeitSoll)
    `,
    query_params: { vehicle: parseInt(vehicle), day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const getAllVehicleHistorysGPS = async (day) => {
  const rs = await client.query({
    query: `
      SELECT
        f.Fahrzeugnummer                                               AS fahrzeugnummer,
        h.Latitude                                                     AS latitude,
        h.Longitude                                                    AS longitude,
        coalesce(fh.AbfahrtszeitSoll, fh.AnkunftszeitSoll)            AS zeitpunkt
      FROM fahrten AS f
      INNER JOIN fahrten_halte AS fh
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE f.Betriebstag = {day:Date}
        AND f.Fahrzeugnummer NOT IN (0, -1)
      ORDER BY f.Fahrzeugnummer, zeitpunkt
    `,
    query_params: { day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const servedLinesByVehicleIDandDay = async (vehicle, day) => {
  const rs = await client.query({
    query: `
      SELECT groupUniqArray(Linienname) AS linien
      FROM fahrten
      WHERE Fahrzeugnummer = {vehicle:Int32}
        AND Betriebstag = {day:Date}
    `,
    query_params: { vehicle: parseInt(vehicle), day },
    format: 'JSONEachRow',
  });
  return await rs.json();
}

const servedStopsByVehicleIDandDay = async (vehicle, day) => {
  const rs = await client.query({
    query: `
      SELECT DISTINCT
        h.Haltestellenname AS haltestellenname,
        h.Latitude         AS latitude,
        h.Longitude        AS longitude,
        h.VGNKennung       AS vgnkennung,
        h.VAGKennung       AS vagkennung
      FROM fahrten AS f
      INNER JOIN fahrten_halte AS fh
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      INNER JOIN haltestellen AS h FINAL ON fh.VGNKennung = h.VGNKennung
      WHERE f.Fahrzeugnummer = {vehicle:Int32}
        AND f.Betriebstag = {day:Date}
    `,
    query_params: { vehicle: parseInt(vehicle), day },
    format: 'JSONEachRow',
  });

  const rows = await rs.json();
  const headers = rs.response_headers
  const summary = JSON.parse(headers['x-clickhouse-summary'])
  return [{ haltestellen: rows, summary }];
}

const percentageDelayByProductMonth = async (outer_neg_bound, outer_pos_bound, lower_inner_bound, upper_inner_bound, years) => {
  const rs = await client.query({
    query: `
      SELECT
        toStartOfMonth(fh.Betriebstag)                                                                     AS month,
        f.Produkt                                                                                          AS produkt,
        count(*)                                                                                           AS total_departures,
        countIf(fh.\`AbfahrtszeitVerspätung\` BETWEEN {onb:Int32} AND {lib:Int32}) * 100.0 / count(*)    AS percentage_early,
        countIf(fh.\`AbfahrtszeitVerspätung\` BETWEEN {lib:Int32} AND {uib:Int32}) * 100.0 / count(*)    AS percentage_on_time,
        countIf(fh.\`AbfahrtszeitVerspätung\` BETWEEN {uib:Int32} AND {opb:Int32}) * 100.0 / count(*)    AS percentage_late
      FROM fahrten_halte AS fh
      INNER JOIN fahrten AS f
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      WHERE isNotNull(fh.\`AbfahrtszeitVerspätung\`)
        AND fh.Betriebstag >= today() - INTERVAL {years:Int32} YEAR
      GROUP BY month, f.Produkt
      ORDER BY month DESC, f.Produkt
    `,
    query_params: {
      onb: outer_neg_bound, opb: outer_pos_bound,
      lib: lower_inner_bound, uib: upper_inner_bound,
      years: parseInt(years),
    },
    clickhouse_settings: { send_progress_in_http_headers: 1 },
    format: 'JSONEachRow',
  });

  const rows = await rs.json();
  const headers = rs.response_headers
  const summary = JSON.parse(headers['x-clickhouse-summary'])
  return { rows, summary };
}

const percentageDelayByProductWeek = async (outer_neg_bound, outer_pos_bound, lower_inner_bound, upper_inner_bound, years) => {
  const rs = await client.query({
    query: `
      SELECT
        toYear(fh.Betriebstag)                                                                             AS year,
        toISOWeek(fh.Betriebstag)                                                                         AS calendar_week,
        f.Produkt                                                                                          AS produkt,
        count(*)                                                                                           AS total_departures,
        countIf(fh.\`AbfahrtszeitVerspätung\` BETWEEN {onb:Int32} AND {lib:Int32}) * 100.0 / count(*)    AS percentage_early,
        countIf(fh.\`AbfahrtszeitVerspätung\` BETWEEN {lib:Int32} AND {uib:Int32}) * 100.0 / count(*)    AS percentage_on_time,
        countIf(fh.\`AbfahrtszeitVerspätung\` BETWEEN {uib:Int32} AND {opb:Int32}) * 100.0 / count(*)    AS percentage_late
      FROM fahrten_halte AS fh
      INNER JOIN fahrten AS f
        ON f.Fahrtnummer = fh.Fahrtnummer
       AND f.Betriebstag = fh.Betriebstag
       AND f.Produkt = fh.Produkt
      WHERE isNotNull(fh.\`AbfahrtszeitVerspätung\`)
        AND fh.Betriebstag >= today() - INTERVAL {years:Int32} YEAR
      GROUP BY year, calendar_week, f.Produkt
      ORDER BY year DESC, calendar_week DESC, f.Produkt
    `,
    query_params: {
      onb: outer_neg_bound, opb: outer_pos_bound,
      lib: lower_inner_bound, uib: upper_inner_bound,
      years: parseInt(years),
    },
    clickhouse_settings: { send_progress_in_http_headers: 1 },
    format: 'JSONEachRow',
  });
  
  const rows = await rs.json();
  const headers = rs.response_headers
  const summary = JSON.parse(headers['x-clickhouse-summary'])
  return { rows, summary };
}

/* --- --- --- Exports --- --- --- */

const views = {
  topList: {
    delayByStops: getTopListDelayByStops,
    delayByVehicles: getTopListDelayByVehicles,
    delayByLines: getTopListDelayByLines,
  },
}

const haltestellen = {
  insertOrUpdate: insertOrUpdateHaltestelle,
  getAllHaltestellen: getAllHaltestellen,
}

const heatmap = {
  getDay: getHeatMapDataDay,
  getTimeFrame: getHeatMapTimeFrame,
}

const statistics = {
  getDistinctLines: getDistinctLines,
  getAvgDelayByLine: getavragedelayperline,
  percentageDelayByProductMonth: percentageDelayByProductMonth,
  percentageDelayByProductWeek: percentageDelayByProductWeek,
  getDelayHistogram: getDelayHistogram,
}

const vehicle = {
  getHistory: getVehicleHistory,
  allGPS: getAllVehicleHistorysGPS,
  servedLinesByVehicleIDandDay: servedLinesByVehicleIDandDay,
  servedStopsByVehicleIDandDay: servedStopsByVehicleIDandDay,
}

module.exports = {
  createTables,
  views,
  heatmap,
  haltestellen,
  statistics,
  vehicle,
}
