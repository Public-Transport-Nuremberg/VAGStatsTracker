const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('ultimate-express');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const load = (relativePath, mocks = {}, env = {}) => {
    const filename = path.join(root, relativePath);
    const actualRequire = createRequire(filename);
    const module = { exports: {} };
    vm.compileFunction(fs.readFileSync(filename, 'utf8'),
        ['module', 'exports', 'require', 'process', 'console', '__dirname'], { filename })(
        module, module.exports,
        (name) => Object.hasOwn(mocks, name) ? mocks[name] : actualRequire(name),
        { env }, console, path.dirname(filename));
    return module.exports;
};

test('LOW_MEMORY_MODE is opt-in and empty banner text has a default', () => {
    for (const value of [undefined, '', 'false', '0', '1']) {
        assert.equal(load('config/lowMemory.js', {}, { LOW_MEMORY_MODE: value }).lowMemoryMode, false);
    }
    for (const value of ['true', 'TRUE', ' true ']) {
        const config = load('config/lowMemory.js', {}, { LOW_MEMORY_MODE: value, LOW_MEMORY_TEXT: ' ' });
        assert.equal(config.lowMemoryMode, true);
        assert.ok(config.lowMemoryText.length > 0);
    }
});

for (const enabled of [true, false]) {
    test(`statistics HTTP routes with LOW_MEMORY_MODE=${enabled}`, async () => {
        const config = load('config/lowMemory.js', {}, {
            LOW_MEMORY_MODE: String(enabled), LOW_MEMORY_TEXT: 'Statistik pausiert',
        });
        const guard = load('middleware/lowMemory.js', { '@config/lowMemory': config });
        let databaseCalls = 0;
        let limiterCalls = 0;
        const rows = async () => { databaseCalls++; return []; };
        const summary = async () => { databaseCalls++; return { rows: [], result: [], summary: {} }; };
        const mocks = {
            '@middleware/lowMemory': guard,
            '@middleware/limiter': { limiter: () => (req, res, next) => { limiterCalls++; next(); } },
            '@middleware/cacheRequest': {},
            '@config/linesWithStops': { U1: [] },
            '@lib/clickhouse': {
                statistics: { getAvgDelayByLine: rows, percentageDelayByProductWeek: summary,
                    percentageDelayByProductMonth: summary, getDelayHistogram: summary },
                heatmap: { getDay: rows, getTimeFrame: rows },
                views: { topList: { delayByStops: rows, delayByLines: rows, delayByVehicles: rows } },
                vehicle: { allGPS: rows },
            },
            '@lib/haltestellen_cache': { StopObjectStore: {} },
            'oepnv-nuremberg': { openvgn: class {} },
            '@lib/api_trace': { traceVgnClient: (client) => client },
        };
        const app = express({ threads: 0 });
        app.set('catch async errors', true);
        for (const name of ['statistics', 'heatmap', 'toplists']) {
            app.use(`/api/v1/${name}`, load(`api/${name}.js`, mocks).router);
        }
        await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${app.address().port}/api/v1`;
        try {
            const routes = [
                '/statistics/delay/avrage/line?line=U1',
                '/statistics/delay/percentage/week/product',
                '/statistics/delay/percentage/month/product',
                '/statistics/delay/histogram?startDate=2026-11-01&endDate=2026-11-02',
                '/heatmap?at=2026-11-01',
                '/heatmap?from=2026-11-01&to=2026-11-02',
                ...['by_stops', 'by_lines', 'by_vehicles'].map((list) => `/toplists/delay/${list}?at=2026-11-01`),
                '/toplists/vehicle/distance/2026-11-01',
            ];
            for (const route of routes) {
                const response = await fetch(origin + route);
                assert.equal(response.status, enabled ? 503 : 200, route);
                if (enabled) {
                    assert.equal(response.headers.get('cache-control'), 'no-store');
                    assert.deepEqual(await response.json(), { code: 'LOW_MEMORY_MODE', message: config.lowMemoryText });
                } else {
                    await response.json();
                }
            }
            assert.equal(databaseCalls, enabled ? 0 : routes.length);
            assert.equal(limiterCalls, enabled ? 0 : routes.length);
            const lines = await fetch(`${origin}/statistics/lines`);
            assert.equal(lines.status, 200);
            assert.deepEqual(await lines.json(), ['U1']);
        } finally {
            app.close();
        }
    });
}

test('homepage uses shared configuration and escapes banner text', () => {
    const template = fs.readFileSync(path.join(root, 'views/index.ejs'), 'utf8');
    for (const enabled of [true, false]) {
        const config = load('config/lowMemory.js', {}, {
            LOW_MEMORY_MODE: String(enabled), LOW_MEMORY_TEXT: '<script>alert(1)</script> & Hinweis',
        });
        const { getContextObject } = load('lib/template/index.js', {
            '@src/app': {}, '@config/lowMemory': config,
            child_process: { execSync: () => Buffer.from('abcdef0123456789') },
        });
        const html = ejs.render(template, getContextObject());
        assert.equal(html.includes('role="status"'), enabled);
        assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Hinweis'), enabled);
        assert.equal(html.includes('<script>alert(1)</script>'), false);
    }
});
