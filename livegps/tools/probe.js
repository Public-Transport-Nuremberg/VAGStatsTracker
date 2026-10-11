const { openvgn } = require('oepnv-nuremberg');
const { withWatchdog } = require('../lib/collector');
const { normalizeObservation } = require('../lib/observations');

// One read-only API request. No Redis or ClickHouse writes, and no ENV credentials.
withWatchdog(() => new openvgn().getVehicles(), 10000).then((response) => {
    if (!Array.isArray(response?.Vehicles)) throw new Error(response?.message || 'Invalid VMI response');
    const normalized = response.Vehicles.map((vehicle) => normalizeObservation(vehicle));
    console.log(JSON.stringify({
        received: normalized.length, operators: [...new Set(normalized.map(({ payload }) => payload.operator))],
        validPositions: normalized.filter(({ payload }) => payload.latitude !== null).length,
        timestamped: normalized.filter(({ sourceMs }) => sourceMs !== null).length,
    }, null, 2));
    process.exit(0);
}).catch((error) => { console.error(error.message); process.exit(1); });
