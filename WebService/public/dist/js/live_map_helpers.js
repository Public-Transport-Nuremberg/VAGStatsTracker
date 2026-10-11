(function (root, factory) {
    const helpers = factory();
    if (typeof module === 'object' && module.exports) module.exports = helpers;
    else root.LiveMapHelpers = helpers;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    function viewportQuery(search, source, extent) {
        const query = new URLSearchParams(search);
        if (source === 'gps') query.set('source', 'gps');
        else query.delete('source');
        let [west, south, east, north] = extent;
        if (west < -180 || east > 180) { west = -180; east = 180; }
        south = Math.max(-85.05112878, south);
        north = Math.min(85.05112878, north);
        query.set('pos1', `${west.toFixed(6)},${south.toFixed(6)}`);
        query.set('pos2', `${east.toFixed(6)},${north.toFixed(6)}`);
        return `?${query}`;
    }
    function ageSeconds(timestamp, now = Date.now()) {
        const ms = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
        return Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 1000)) : null;
    }
    return { viewportQuery, ageSeconds };
}));
