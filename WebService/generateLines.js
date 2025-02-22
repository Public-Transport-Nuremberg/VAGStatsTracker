require('dotenv').config();
require('module-alias/register')

const { Client } = require('pg');
const fs = require('node:fs');

(async function () {
  const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  });

  try {
    await client.connect();

    // Retrieve all distinct line names
    const { rows: lines } = await client.query(`
      SELECT DISTINCT Linienname
      FROM public.fahrten
      ORDER BY Linienname ASC;
    `);

    const output = {};

    // Process each line
    for (const { linienname } of lines) {
      console.log(`Processing line ${linienname}`);
      // For each line, pick the trip (Fahrt) with the most recorded stops.
      // This ensures that if some trips don't cover the full line length, we get the most complete one.
      const { rows: tripRows } = await client.query(`
        WITH latest_betriebstag AS (
          SELECT MAX(Betriebstag) AS last_day
          FROM public.fahrten
          WHERE Linienname = $1
        ),
        fahrten_with_stops AS (
          SELECT f.Fahrtnummer, f.Betriebstag, COUNT(*) AS stop_count
          FROM public.fahrten f
          JOIN public.fahrten_halte fh 
            ON f.Fahrtnummer = fh.Fahrtnummer 
          AND f.Betriebstag = fh.Betriebstag 
          AND f.Produkt = fh.Produkt
          WHERE f.Linienname = $1
            AND f.Betriebstag = (SELECT last_day FROM latest_betriebstag)
          GROUP BY f.Fahrtnummer, f.Betriebstag
        ),
        mode_stop_count AS (
          SELECT stop_count
          FROM fahrten_with_stops
          GROUP BY stop_count
          ORDER BY COUNT(*) DESC, stop_count DESC
          LIMIT 1
        )
        SELECT fws.Fahrtnummer, fws.Betriebstag, fws.stop_count
        FROM fahrten_with_stops fws
        WHERE fws.stop_count = (SELECT stop_count FROM mode_stop_count) LIMIT 1;
      `, [linienname]);

      if (tripRows.length === 0) {
        // If no trip found, assign an empty array.
        output[linienname] = [];
        continue;
      }

      const { fahrtnummer, betriebstag } = tripRows[0];

      // Now, retrieve the stops for the selected trip in the correct order.
      const { rows: stopRows } = await client.query(`
        SELECT h.VGNKennung
        FROM public.fahrten_halte fh
        JOIN public.haltestellen h 
          ON fh.VGNKennung = h.VGNKennung
        WHERE fh.Fahrtnummer = $1 
          AND fh.Betriebstag = $2
        ORDER BY fh.AbfahrtszeitSoll ASC;
      `, [fahrtnummer, betriebstag]);

      // Build the array of stop identifiers.
      const stops = stopRows.map(row => { return row.vgnkennung; });
      output[linienname] = stops;
    }

    // Output the JSON result in the format: { "LineName": [VGNKennung, ...], ... }
    fs.writeFileSync('./config/linesWithStops.json', JSON.stringify(output));

  } catch (err) {
    console.error('Error executing queries', err);
  } finally {
    await client.end();
  }
})();
