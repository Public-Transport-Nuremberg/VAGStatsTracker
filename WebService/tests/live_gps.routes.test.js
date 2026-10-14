const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('application GPS/PULS HTTP routes and encoded history identities', { timeout: 30000 }, async () => {
    const server = spawn(process.execPath, [path.join(__dirname, 'helpers/live_gps_server.js')], {
        env: { ...process.env, GPS_MAP_FIXTURE_PORT: '18762' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
        const startup = await new Promise((resolve, reject) => {
            let output = '';
            const timeout = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output.slice(-1000)}`)), 15000);
            server.once('error', (error) => { clearTimeout(timeout); reject(error); });
            server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}`)); });
            server.stdout.on('data', (chunk) => {
                output += chunk;
                if (output.includes('GPS browser fixture')) { clearTimeout(timeout); resolve(output); }
            });
            server.stderr.on('data', (chunk) => { output += chunk; });
        });
        const day = /day=(\d{4}-\d{2}-\d{2})/.exec(startup)[1];
        const origin = 'http://127.0.0.1:18762';
        const get = (url) => fetch(origin + url);
        const gps = await (await get('/api/v1/live/map?source=gps&line=E5')).json();
        assert.equal(gps.__meta.source, 'gps');
        assert.equal(Object.values(gps).filter((item) => item.PositionSource === 'gps').length, 1);
        assert.equal(gps['fixture-puls'], undefined);
        const metricResponse = await get('/api/v1/metrics');
        assert.equal(metricResponse.status, 200);
        assert.match(metricResponse.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
        const metrics = await metricResponse.text();
        assert.match(metrics, /^LiveGPS_Vehicles 1$/m);
        assert.match(metrics, /^LiveGPS_VehiclesByProduct\{product="Bus"\} 1$/m);
        assert.match(metrics, /^LiveGPS_VehiclesByProduct\{product="Tram"\} 0$/m);
        assert.equal((await (await get('/api/v1/live/map')).json())['fixture-puls'].Fahrzeugnummer, 625);
        assert.equal(Object.keys(await (await get('/api/v1/live/map?source=gps&line=U1')).json()).length, 1);
        assert.equal((await get('/api/v1/live/map?source=invalid')).status, 400);
        assert.equal((await get('/api/v1/live/map?source=gps&pos1=11,49')).status, 400);
        const history = await (await get(`/api/v1/vehicle/gps/history/${day}/BUS-A%2F01?operator=A%26B%2BX`)).json();
        assert.equal(history.vehicleId, 'BUS-A/01', 'decode route escapes exactly once');
        assert.equal(history.operator, 'A&B+X');
        assert.equal(history.points.length, 5);
        assert.equal((await (await get(`/api/v1/vehicle/gps/history/${day}/BUS%252F01`)).json()).vehicleId, 'BUS%2F01');
        assert.equal((await get(`/api/v1/vehicle/gps/history/${day}/%ZZ`)).status, 400);
        assert.equal((await get('/api/v1/vehicle/gps/history/2026-02-30/00625')).status, 400);
        assert.equal((await get(`/api/v1/vehicle/gps/history/${day}/x?identity=object`)).status, 400);
        assert.equal((await get(`/vehicleHistoryGPS/${day}/BUS-A%2F01?operator=VAN`)).status, 200);
    } finally {
        if (server.exitCode === null && server.signalCode === null) {
            const exited = new Promise((resolve) => server.once('exit', resolve));
            server.kill();
            await exited;
        }
    }
});
