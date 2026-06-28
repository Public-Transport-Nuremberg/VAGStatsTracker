require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@clickhouse/client');

const ch = createClient({
    url: `http://${process.env.CH_HOST}:${process.env.CH_PORT || 8123}`,
    username: process.env.CH_USER || 'default',
    password: process.env.CH_PASSWORD || '',
    database: process.env.CH_DATABASE || 'default',
    request_timeout: 120_000,
});

const migrationsDir = path.join(__dirname, 'migrations');

const createMigrationsTable = async () => {
    await ch.exec({
        query: `
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id String,
                file String DEFAULT '',
                checksum String DEFAULT '',
                applied_at DateTime DEFAULT now()
            ) ENGINE = ReplacingMergeTree(applied_at)
            ORDER BY id
        `,
    });

    await ch.exec({ query: "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS file String DEFAULT '' AFTER id" });
    await ch.exec({ query: "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum String DEFAULT '' AFTER file" });
}

const getAppliedMigrations = async () => {
    const rs = await ch.query({
        query: 'SELECT id FROM schema_migrations FINAL',
        format: 'JSONEachRow',
    });
    const rows = await rs.json();
    return new Set(rows.map(row => row.id));
}

const loadMigrations = () => {
    return fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.js'))
        .sort()
        .map(file => {
            const fullPath = path.join(migrationsDir, file);
            const migration = require(fullPath);
            return {
                id: migration.id || path.basename(file, '.js'),
                file,
                checksum: crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex'),
                up: migration.up,
            };
        });
}

const validateMigration = (migration) => {
    if (!migration.id) throw new Error(`Migration ${migration.file} has no id`);
    if (typeof migration.up !== 'function') throw new Error(`Migration ${migration.file} has no up(client) function`);
}

const markApplied = async (migration) => {
    await ch.insert({
        table: 'schema_migrations',
        values: [{
            id: migration.id,
            file: migration.file,
            checksum: migration.checksum,
        }],
        format: 'JSONEachRow',
    });
}

const main = async () => {
    console.log('=== ClickHouse schema migrations ===');
    console.log(`  CH: ${process.env.CH_HOST}:${process.env.CH_PORT || 8123}/${process.env.CH_DATABASE || 'default'}`);

    await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await createMigrationsTable();

    const applied = await getAppliedMigrations();
    const migrations = loadMigrations();
    let appliedCount = 0;

    for (const migration of migrations) {
        validateMigration(migration);

        if (applied.has(migration.id)) {
            console.log(`  - ${migration.id} already applied`);
            continue;
        }

        console.log(`  > applying ${migration.id}`);
        await migration.up(ch);
        await markApplied(migration);
        appliedCount += 1;
        console.log(`  ✓ applied ${migration.id}`);
    }

    console.log(`\nDone. Applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}.`);
}

main()
    .catch(err => {
        console.error('\nMigration failed:', err);
        process.exit(1);
    })
    .finally(() => ch.close());
