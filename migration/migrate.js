/**
 * One-time migration: PostgreSQL → ClickHouse
 *
 * Setup:
 *   cd migration && npm install
 *   cp .env.example .env   # fill in PG_* and CH_* vars
 *   node migrate.js
 *
 * The script is safe to re-run — ReplacingMergeTree deduplicates on next merge.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const { createClient } = require('@clickhouse/client');

// ── Connections ───────────────────────────────────────────────────────────────

const pg = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
});

const ch = createClient({
    url: `http://${process.env.CH_HOST}:${process.env.CH_PORT || 8123}`,
    username: process.env.CH_USER || 'default',
    password: process.env.CH_PASSWORD || '',
    database: process.env.CH_DATABASE || 'default',
    // Larger insert timeout for bulk migration
    request_timeout: 120_000,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 50_000;

/** Format a pg Date object or ISO string as YYYY-MM-DD for ClickHouse Date */
const fmtDate = (d) => {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
};

/** Format a pg timestamp (Date object or ISO string) as "YYYY-MM-DD HH:MM:SS" for ClickHouse DateTime */
const fmtDateTime = (d) => {
    if (!d) return null;
    const iso = d instanceof Date ? d.toISOString() : String(d);
    // "2025-01-27T16:47:08.000Z" → "2025-01-27 16:47:08"
    return iso.slice(0, 19).replace('T', ' ');
};

const progress = (label, n, total) =>
    process.stdout.write(`  ${label}: ${n.toLocaleString()}${total ? ` / ${total.toLocaleString()}` : ''} rows\r`);

// ── Schema creation ───────────────────────────────────────────────────────────

async function createTables() {
    const ddl = [
        {
            name: 'haltestellen',
            sql: `
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
                ORDER BY VGNKennung;
            `,
        },
        {
            name: 'fahrten',
            sql: `
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
                ORDER BY (Betriebstag, Fahrtnummer, Produkt);
            `,
        },
        {
            name: 'fahrten_halte',
            sql: `
                CREATE TABLE IF NOT EXISTS fahrten_halte (
                    Fahrtnummer             Int32,
                    Betriebstag             Date,
                    Produkt                 Int8,
                    VGNKennung              Int16,
                    Haltepunkt              Int16,
                    Richtungstext           String,
                    AnkunftszeitSoll        Nullable(DateTime),
                    \`AnkunftszeitVerspätung\`  Nullable(Int16),
                    AbfahrtszeitSoll        Nullable(DateTime),
                    \`AbfahrtszeitVerspätung\`  Nullable(Int16),
                    _updated_at             DateTime DEFAULT now()
                ) ENGINE = ReplacingMergeTree(_updated_at)
                PARTITION BY toYYYYMM(Betriebstag)
                ORDER BY (Betriebstag, VGNKennung, Fahrtnummer, Produkt)
            `,
        },
    ];

    for (const { name, sql } of ddl) {
        await ch.exec({ query: sql });
        console.log(`  ✓ ${name}`);
    }
}

// ── Table migrations ──────────────────────────────────────────────────────────

async function getMaxBetriebstag(tableName) {
    try {
        const rs = await ch.query({
            query: `SELECT MAX(Betriebstag) as m FROM ${tableName}`,
            format: 'JSONEachRow',
        });

        const result = await rs.json();
        console.log(result)
        const maxDate = result[0]?.m;

        if (!maxDate || maxDate === '0000-00-00' || maxDate === '1970-01-01') {
            return '1970-01-01';
        }

        const d = new Date(maxDate);
        d.setDate(d.getDate() - 1);

        const finalDate = d.toISOString().slice(0, 10);
        console.log(`  [Debug] ClickHouse reported max date ${maxDate}, setting start to ${finalDate}`);
        return finalDate;
    } catch (err) {
        console.error(`  [Debug] Error fetching max date from ${tableName}:`, err.message);
        return '1970-01-01';
    }
}

async function migrateHaltestellen() {
    console.log('\n[1/3] haltestellen');

    // pg stores unquoted identifiers as lowercase
    const { rows } = await pg.query('SELECT * FROM haltestellen ORDER BY vgnkennung');
    if (!rows.length) { console.log('  → empty, skipping'); return; }

    await ch.insert({
        table: 'haltestellen',
        format: 'JSONEachRow',
        values: rows.map(r => ({
            VGNKennung: r.vgnkennung,
            VAGKennung: r.vagkennung || [],     // pg driver returns text[] as JS array
            Haltestellenname: r.haltestellenname,
            Latitude: r.latitude,
            Longitude: r.longitude,
            Produkt_Bus: r.produkt_bus ? 1 : 0,
            Produkt_UBahn: r.produkt_ubahn ? 1 : 0,
            Produkt_Tram: r.produkt_tram ? 1 : 0,
            Produkt_SBahn: r.produkt_sbahn ? 1 : 0,
            Produkt_RBahn: r.produkt_rbahn ? 1 : 0,
        })),
    });

    console.log(`  → migrated ${rows.length.toLocaleString()} rows`);
}

async function migrateFahrten() {
    console.log('\n[2/3] fahrten (Incremental)');

    const startDateStr = await getMaxBetriebstag('fahrten');
    console.log(`  → Looking for new data since: ${startDateStr}`);

    const { rows: [cnt] } = await pg.query(
        'SELECT COUNT(*) AS n FROM fahrten WHERE betriebstag >= $1',
        [startDateStr]
    );

    const total = parseInt(cnt.n);
    if (!total) {
        console.log('  → Everything up to date.');
        return;
    }

    console.log(`  → Found ${total.toLocaleString()} new/updated rows to migrate.`);

    let offset = 0;
    while (offset < total) {
        const { rows } = await pg.query(
            `SELECT * FROM fahrten
             WHERE betriebstag >= $1
             ORDER BY betriebstag, fahrtnummer, produkt
             LIMIT $2 OFFSET $3`,
            [startDateStr, BATCH_SIZE, offset]
        );

        if (!rows.length) break;

        await ch.insert({
            table: 'fahrten',
            format: 'JSONEachRow',
            values: rows.map(r => ({
                Fahrtnummer: r.fahrtnummer,
                Betriebstag: fmtDate(r.betriebstag),
                Produkt: r.produkt,
                Linienname: r.linienname,
                Besetzungsgrad: r.besetzungsgrad,
                Fahrzeugnummer: r.fahrzeugnummer,
                Richtung: r.richtung,
                _updated_at: fmtDateTime(new Date())
            })),
        });

        offset += rows.length;
        progress('fahrten', offset, total);
    }
    console.log(`\n  → Migration of new rows finished.`);
}

async function migrateFahrtenHalte() {
    console.log('\n[3/3] fahrten_halte (Incremental)');

    const startDateStr = await getMaxBetriebstag('fahrten_halte');
    const startDate = new Date(startDateStr);

    const { rows: [range] } = await pg.query("SELECT MAX(betriebstag) AS max FROM fahrten_halte");
    if (!range.max) return;
    const lastDay = new Date(range.max);

    const firstDayOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
    const nextMonthFirst = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1);

    let current = firstDayOfMonth(startDate);
    let totalMigrated = 0;

    console.log(`  → Resuming migration from ${fmtDate(current)}...`);

    while (current <= lastDay) {
        const monthStart = fmtDate(current);
        const monthEnd = fmtDate(new Date(nextMonthFirst(current) - 86400_000));

        const effectiveStart = fmtDate(current > startDate ? current : startDate);

        const { rows: [mc] } = await pg.query(
            "SELECT COUNT(*) AS n FROM fahrten_halte WHERE betriebstag BETWEEN $1 AND $2",
            [effectiveStart, monthEnd]
        );
        const monthCount = parseInt(mc.n);

        if (monthCount > 0) {
            let offset = 0;
            while (offset < monthCount) {
                const { rows } = await pg.query(
                    `SELECT * FROM fahrten_halte
                     WHERE betriebstag BETWEEN $1 AND $2
                     ORDER BY betriebstag, vgnkennung, fahrtnummer, produkt
                     LIMIT $3 OFFSET $4`,
                    [effectiveStart, monthEnd, BATCH_SIZE, offset]
                );

                if (!rows.length) break;

                await ch.insert({
                    table: 'fahrten_halte',
                    format: 'JSONEachRow',
                    values: rows.map(r => ({
                        Fahrtnummer: r.fahrtnummer,
                        Betriebstag: fmtDate(r.betriebstag),
                        Produkt: r.produkt,
                        VGNKennung: r.vgnkennung,
                        Haltepunkt: r.haltepunkt,
                        Richtungstext: r.richtungstext || '',
                        AnkunftszeitSoll: fmtDateTime(r.ankunftszeitsoll),
                        'AnkunftszeitVerspätung': r.ankunftszeitverspätung ?? null,
                        AbfahrtszeitSoll: fmtDateTime(r.abfahrtszeitsoll),
                        'AbfahrtszeitVerspätung': r.abfahrtszeitverspätung ?? null,
                        _updated_at: fmtDateTime(new Date())
                    })),
                });

                offset += rows.length;
                totalMigrated += rows.length;
                progress(`${monthStart}`, totalMigrated);
            }
            console.log(`  [${monthStart}] ${monthCount.toLocaleString()} rows added.`);
        }

        current = nextMonthFirst(current);
    }
    console.log(`\n  → Done! Total new rows: ${totalMigrated.toLocaleString()}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== PostgreSQL → ClickHouse migration ===');
    console.log(`  PG:  ${process.env.PG_HOST}:${process.env.PG_PORT || 5432}/${process.env.PG_DATABASE}`);
    console.log(`  CH:  ${process.env.CH_HOST}:${process.env.CH_PORT || 8123}/${process.env.CH_DATABASE}`);

    // Verify connections
    await pg.query('SELECT 1');
    console.log('  ✓ Postgres connected');
    await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    console.log('  ✓ ClickHouse connected');

    console.log('\n[0/3] Creating tables in ClickHouse');
    await createTables();

    const start = Date.now();

    await migrateHaltestellen();
    await migrateFahrten();
    await migrateFahrtenHalte();

    const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
    console.log(`\n✓ Migration complete in ${elapsed} minutes`);
    console.log('  Note: ClickHouse will deduplicate rows in the background via ReplacingMergeTree merges.');
}

main()
    .catch(err => { console.error('\n✗ Migration failed:', err); process.exit(1); })
    .finally(() => { pg.end(); ch.close(); });
