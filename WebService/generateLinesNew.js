const cheerio = require('cheerio');
const { createClient } = require('@clickhouse/client');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = createClient({
  url: `http://${process.env.CH_HOST}:${process.env.CH_PORT || 8123}`,
  username: process.env.CH_USER,
  password: process.env.CH_PASSWORD,
  database: process.env.CH_DATABASE,
});

const CONTACT_PAGE = 'https://www.vag.de/kontakt/lob-anfrage-und-beschwerde';
const API_ENDPOINT = 'https://www.vag.de/index.php?id=180&type=7070';

function cleanLineName(name) {
  name = name.replace('U-Bahn-Linie ', '').trim();
  name = name.replace('Tram-Linie ', '').trim();
  name = name.replace('Bus-Linie ', '').trim();
  return name;
}

async function getAvailableLines() {
  const response = await fetch(CONTACT_PAGE);
  const html = await response.text();
  const $ = cheerio.load(html);
  const lines = [];
  
  // Scrape the main dropdown for all available lines
  $('#powermail_field_routeselect_line option').each((_, el) => {
    const val = $(el).val();
    const name = $(el).text().trim();
    if (val && val !== "") {
      lines.push({ id: val, name: name });
    }
  });
  return lines;
}

async function getStopsForLine(line) {
  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `tx_pulslinien_show[linien]=${encodeURIComponent(line.id)}`
    });

    const html = await response.text();
    const $ = cheerio.load(html);
    const stopIds = [];

    const stopOptions = $('#stops option');
    
    for (let i = 0; i < stopOptions.length; i++) {
      const vgnid = $(stopOptions[i]).val();
      const webName = $(stopOptions[i]).text().trim();

      if (!vgnid) continue;
      
      const idNum = parseInt(vgnid);
      stopIds.push(idNum);

      // ClickHouse Validation
      const resultSet = await client.query({
        query: `SELECT Haltestellenname FROM haltestellen WHERE VGNKennung = {id:String}`,
        query_params: { id: vgnid },
        format: 'JSONEachRow',
      });
      const rows = await resultSet.json();

      if (rows.length > 0) {
        const dbName = rows[0].Haltestellenname;
        if (dbName !== webName) {
          console.warn(`[VIOLATION] Line: ${line.name} | ID: ${vgnid} | Web: "${webName}" vs CH: "${dbName}"`);
        }
      } else {
        console.log(`[NOT FOUND] ID ${vgnid} ("${webName}") missing in ClickHouse.`);
      }
    }

    return {
      "1": [...stopIds],
      "2": [...stopIds].reverse()
    };

  } catch (err) {
    console.error(`Error on line ${line.name}:`, err.message);
    return null;
  }
}

async function run() {
  try {
    const lines = await getAvailableLines();
    const finalOutput = {};

    for (const line of lines) {
      console.log(`Processing ${line.name}...`);
      const routeData = await getStopsForLine(line);
      if (routeData) {
        // Using line.name as the key (e.g., "U2", "Tram 4")
        finalOutput[cleanLineName(line.name)] = routeData;
      }
    }

    const configDir = path.join(__dirname, 'config');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);
    
    fs.writeFileSync(
      path.join(configDir, 'linesWithStops.json'),
      JSON.stringify(finalOutput)
    );

    console.log('\n--- Extraction Complete ---');
    console.log(`File saved to: ${path.join(configDir, 'linesWithStops.json')}`);
  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await client.close();
  }
}

run();