const test = require('node:test');
const assert = require('node:assert/strict');
const { viewportQuery, ageSeconds } = require('../public/dist/js/live_map_helpers');
test('map requests carry only the current viewport and preserve line/source selection', () => {
    const query = new URLSearchParams(viewportQuery('?source=gps&line=E5&pos1=0,0&pos2=1,1', 'gps', [11, 49, 11.2, 49.6]));
    assert.equal(query.get('line'), 'E5');
    assert.equal(query.get('source'), 'gps');
    assert.equal(query.get('pos1'), '11.000000,49.000000');
    assert.equal(query.get('pos2'), '11.200000,49.600000');
    assert.equal(new URLSearchParams(viewportQuery(query, 'puls', [10, 48, 12, 50])).has('source'), false);
    const wrapped = new URLSearchParams(viewportQuery('', 'gps', [-190, -89, 190, 89]));
    assert.equal(wrapped.get('pos1'), '-180.000000,-85.051129');
    assert.equal(wrapped.get('pos2'), '180.000000,85.051129');
});
test('position age advances independently of polling and handles invalid/future timestamps', () => {
    const timestamp = Date.parse('2026-10-11T10:00:00Z');
    assert.equal(ageSeconds(timestamp, timestamp + 19500), 19);
    assert.equal(ageSeconds(timestamp, timestamp + 20500), 20);
    assert.equal(ageSeconds(timestamp + 1000, timestamp), 0);
    assert.equal(ageSeconds('invalid', timestamp), null);
});
