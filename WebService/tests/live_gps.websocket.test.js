const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

test('one WebSocket updates viewport/source, discards superseded reads and keeps streaming', {
    timeout: 30000,
    skip: typeof WebSocket !== 'function' ? 'Native WebSocket client requires Node.js 22+ or experimental WebSocket support' : false,
}, async () => {
    const server = spawn(process.execPath, [path.join(__dirname, 'helpers/live_gps_server.js')], {
        env: { ...process.env, GPS_MAP_FIXTURE_PORT: '18763', GPS_MAP_FIXTURE_VEHICLES: '1100',
            GPS_MAP_FIXTURE_QUERY_DELAY_MS: '100', LIVE_MAP_WS_INTERVAL_MS: '50' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let socket;
    const messages = [];
    const waitFor = async (predicate) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value;
            await sleep(10);
        }
        throw new Error(`WebSocket assertion timed out; received ${JSON.stringify(messages.map(({ type, requestId }) => ({ type, requestId })))}`);
    };
    const nearby = { pos1: '11,49.4', pos2: '11.2,49.5' };
    const remote = { pos1: '8.4,49.9', pos2: '8.7,50.2' };
    const count = (message) => Object.keys(message.data).filter((key) => key !== '__meta').length;
    try {
        await new Promise((resolve, reject) => {
            let output = '';
            const timeout = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output.slice(-1000)}`)), 15000);
            server.once('error', (error) => { clearTimeout(timeout); reject(error); });
            server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}`)); });
            server.stdout.on('data', (chunk) => {
                output += chunk;
                if (output.includes('GPS browser fixture')) { clearTimeout(timeout); resolve(); }
            });
            server.stderr.on('data', (chunk) => { output += chunk; });
        });
        socket = new WebSocket(`ws://127.0.0.1:18763/api/v1/live/map/ws?source=gps&${new URLSearchParams(nearby)}`);
        socket.addEventListener('message', ({ data }) => messages.push(JSON.parse(data)));
        assert.equal(count(await waitFor(() => messages.find((message) => message.type === 'snapshot'))), 10);

        socket.send(JSON.stringify({ type: 'subscribe', source: 'gps', requestId: 1, ...nearby }));
        await sleep(20); // The earlier viewport query is still in flight.
        socket.send(JSON.stringify({ type: 'subscribe', source: 'gps', requestId: 2, ...remote }));
        assert.equal(count(await waitFor(() => messages.find((message) => message.requestId === 2))), 1090);
        assert.equal(messages.some((message) => message.requestId === 1), false,
            'superseded query must not publish a snapshot');
        assert.equal(socket.readyState, WebSocket.OPEN);

        socket.send(JSON.stringify({ type: 'subscribe', source: 'gps', requestId: 3, pos1: nearby.pos1 }));
        assert.equal((await waitFor(() => messages.find((message) => message.requestId === 3))).type, 'error');
        assert.equal(socket.readyState, WebSocket.OPEN, 'bad bounds must not close the socket');

        socket.send(JSON.stringify({ type: 'subscribe', source: 'puls', requestId: 4, ...nearby }));
        const puls = await waitFor(() => messages.find((message) => message.requestId === 4 && message.type === 'snapshot'));
        assert.equal(count(puls), 1);
        assert.equal(puls.data['fixture-puls'].Fahrzeugnummer, 625);
        assert.match(JSON.stringify(puls.data), /[^\x00-\x7f]/,
            'text frames include non-ASCII vehicle metadata as valid UTF-8');
        await waitFor(() => messages.filter((message) => message.requestId === 4 && message.type === 'snapshot').length >= 2);
        assert.equal(socket.readyState, WebSocket.OPEN, 'source changes keep the connection and update streaming cadence');

        socket.send(JSON.stringify({ type: 'subscribe', source: 'puls', ...nearby }));
        const legacy = await waitFor(() => messages.find((message) => message.requestId === null && message.type === 'snapshot'));
        assert.equal(count(legacy), 1, 'subscriptions without requestId remain supported');
    } finally {
        socket?.close();
        if (server.exitCode === null && server.signalCode === null) {
            const exited = new Promise((resolve) => server.once('exit', resolve));
            server.kill();
            await exited;
        }
    }
});
