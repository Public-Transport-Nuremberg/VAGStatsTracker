#!/usr/bin/env node

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { createClient } = require('@clickhouse/client');

const HELP = `Usage: node migration/backup.js [options]

Back up the full ClickHouse database (schema and data) to a server-side ZIP.
Connection: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD, CH_DATABASE.
Existing environment variables override values from the .env file.

  --env <file>       Environment file (default: migration/.env)
  --database <name>  Override CH_DATABASE
  --output <path>    Absolute path ON THE CLICKHOUSE SERVER, ending in .zip
                    Default: /var/lib/clickhouse/backup/<database>-<UTC>-<id>.zip
  --help            Show this help without connecting

With the bundled Docker setup, archives appear in Clickhouse/backups on the host.
The script waits for BACKUP_CREATED and exits nonzero on failure.
`;

const quoteIdentifier = value => '`' + value.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
const quoteString = value => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

function parseOptions(args) {
    return parseArgs({
        args,
        options: {
            env: { type: 'string', default: path.join(__dirname, '.env') },
            database: { type: 'string' },
            output: { type: 'string' },
            help: { type: 'boolean', default: false },
        },
        allowPositionals: false,
        strict: true,
    }).values;
}

function buildConfig(options, env) {
    const database = options.database ?? env.CH_DATABASE;
    if (!env.CH_HOST?.trim()) throw new Error('CH_HOST is required. Set it in the environment or the --env file.');
    if (!database?.trim()) throw new Error('CH_DATABASE or --database is required.');
    const port = Number(env.CH_PORT || 8123);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CH_PORT must be between 1 and 65535.');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${database.replace(/[^a-zA-Z0-9_-]/g, '_')}-${timestamp}-${randomUUID()}.zip`;
    const output = options.output ?? `/var/lib/clickhouse/backup/${filename}`;
    if (!path.posix.isAbsolute(output) || !output.endsWith('.zip') || /[\x00-\x1f\x7f]/.test(output)
        || output.split('/').includes('..')) {
        throw new Error('--output must be an absolute server-side path ending in .zip, without control characters or .. segments.');
    }

    const host = env.CH_HOST.includes(':') && !env.CH_HOST.startsWith('[') ? `[${env.CH_HOST}]` : env.CH_HOST;
    return {
        database,
        output,
        client: {
            url: `http://${host}:${port}`,
            username: env.CH_USER || 'default',
            password: env.CH_PASSWORD || '',
            database,
            request_timeout: 120_000,
        },
    };
}

async function backup(client, config, { log = console.log, wait = sleep } = {}) {
    const source = `DATABASE ${quoteIdentifier(config.database)}`;
    const destination = `File(${quoteString(config.output)})`;
    log(`Backing up database ${config.database} to server file ${config.output}`);
    const result = await client.query({
        query: `BACKUP ${source} TO ${destination} ASYNC`,
        format: 'JSONEachRow',
    });
    let [state] = await result.json();
    if (!state?.id) throw new Error('ClickHouse did not return a backup ID. Check system.backups before retrying.');
    const id = state.id;
    log(`Backup ID: ${id}`);

    while (state.status === 'CREATING_BACKUP') {
        await wait(2000);
        const progress = await client.query({
            query: 'SELECT id, status, error FROM system.backups WHERE id = {id:String}',
            query_params: { id },
            format: 'JSONEachRow',
        });
        [state] = await progress.json();
        if (!state) throw new Error(`Backup ${id} disappeared from system.backups. Verify its status before retrying.`);
    }
    if (state.status !== 'BACKUP_CREATED') {
        throw new Error(`Backup ${id}: ${state.status}${state.error ? `: ${state.error}` : ''}`);
    }
    log(`Backup complete: ${config.output}`);
    log(`Restore into an empty database with ClickHouse SQL:\nRESTORE ${source} FROM ${destination};`);
    return { id, output: config.output };
}

async function main(args = process.argv.slice(2)) {
    const options = parseOptions(args);
    if (options.help) {
        console.log(HELP);
        return;
    }
    const loaded = require('dotenv').config({ path: path.resolve(options.env) });
    // Allow environment-only configuration when the default file doesn't exist.
    if (loaded.error && (options.env !== path.join(__dirname, '.env') || loaded.error.code !== 'ENOENT')) {
        throw new Error(`Cannot load environment file: ${loaded.error.message}`);
    }
    const config = buildConfig(options, process.env);
    const client = createClient(config.client);
    try {
        await backup(client, config);
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Backup failed: ${error.message}`);
        console.error('An accepted asynchronous backup may still be running; check system.backups before retrying.');
        process.exitCode = 1;
    });
}

module.exports = { parseOptions, buildConfig, backup };
