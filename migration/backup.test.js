const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { createClient } = require('@clickhouse/client');
const { parseOptions, buildConfig, backup } = require('./backup');

const config = { database: 'vagstats', output: '/var/lib/clickhouse/backup/test.zip' };

test('validates CLI configuration and generates unique server-side archive paths', () => {
    const env = { CH_HOST: 'localhost', CH_DATABASE: 'vagstats', CH_PASSWORD: 'secret' };
    const first = buildConfig(parseOptions([]), env);
    const second = buildConfig(parseOptions([]), env);
    assert.notEqual(first.output, second.output);
    assert.match(first.output, /^\/var\/lib\/clickhouse\/backup\/vagstats-.*\.zip$/);
    assert.equal(first.client.password, 'secret');
    assert.equal(buildConfig(parseOptions(['--database', 'other']), env).database, 'other');
    assert.throws(() => parseOptions(['--unknown']), /Unknown option/);
    assert.throws(() => buildConfig({}, {}), /CH_HOST/);
    assert.throws(() => buildConfig({}, { CH_HOST: 'localhost' }), /CH_DATABASE/);
    assert.throws(() => buildConfig({}, { ...env, CH_PORT: 'invalid' }), /CH_PORT/);
    for (const output of ['local.zip', '/backup/test.sql', '/backup/../test.zip', '/backup/\ntest.zip']) {
        assert.throws(() => buildConfig({ output }, env), /--output/);
    }
});

test('uses the real HTTP client and waits until the asynchronous backup completes', async t => {
    const requests = [];
    const states = ['CREATING_BACKUP', 'CREATING_BACKUP', 'BACKUP_CREATED'];
    const server = http.createServer(async (req, res) => {
        let query = '';
        for await (const chunk of req) query += chunk;
        requests.push({ query, url: req.url });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'backup-id', status: states.shift(), error: '' }) + '\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}`, database: 'vagstats' });
    t.after(async () => {
        await client.close();
        await new Promise(resolve => server.close(resolve));
    });
    const logs = [];
    let waits = 0;
    const result = await backup(client, config, { log: line => logs.push(line), wait: async () => { waits++; } });
    assert.equal(result.id, 'backup-id');
    assert.equal(waits, 2);
    assert.match(requests[0].query, /^BACKUP DATABASE `vagstats` TO File\('\/var\/lib\/clickhouse\/backup\/test.zip'\) ASYNC\s+FORMAT JSONEachRow$/);
    assert.equal(new URL(requests[1].url, 'http://localhost').searchParams.get('param_id'), 'backup-id');
    assert.match(logs.at(-1), /RESTORE DATABASE `vagstats` FROM File/);
});

function fakeClient(rows) {
    return { query: async () => ({ json: async () => rows.shift() }) };
}

test('reports server backup failures without logging success', async () => {
    const logs = [];
    await assert.rejects(backup(fakeClient([
        [{ id: 'failed', status: 'CREATING_BACKUP' }],
        [{ id: 'failed', status: 'BACKUP_FAILED', error: 'Not enough disk space' }],
    ]), config, { log: line => logs.push(line), wait: async () => {} }), /BACKUP_FAILED: Not enough disk space/);
    assert.equal(logs.some(line => line.startsWith('Backup complete')), false);
});

test('does not claim success for missing IDs, vanished jobs or unexpected states', async () => {
    const options = { log: () => {}, wait: async () => {} };
    await assert.rejects(backup(fakeClient([[]]), config, options), /backup ID/);
    await assert.rejects(backup(fakeClient([[{ id: 'id', status: 'CREATING_BACKUP' }], []]), config, options), /disappeared/);
    await assert.rejects(backup(fakeClient([[{ id: 'id', status: 'UNKNOWN' }]]), config, options), /UNKNOWN/);
});

test('quotes database identifiers and archive paths', async () => {
    let query;
    await backup({ query: async params => {
        query = params.query;
        return { json: async () => [{ id: 'id', status: 'BACKUP_CREATED' }] };
    } }, { database: 'db`\\name', output: "/backup/it's.zip" }, { log: () => {} });
    assert.ok(query.includes('`db\\`\\\\name`'));
    assert.ok(query.includes("File('/backup/it\\'s.zip')"));
});
