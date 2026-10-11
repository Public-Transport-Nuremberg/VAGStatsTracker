const Joi = require('joi');

const PREFIX = 'LIVEGPS:VMI:';
const MAX_HISTORY_POINTS = 100000;

function operatingDate(value) {
    if (typeof value !== 'string') return null;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value
        : /^\d{2}\.\d{2}\.\d{4}$/.test(value) ? value.split('.').reverse().join('-') : null;
    if (!iso) return null;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? iso : null;
}

function berlinDate(value) {
    if (value === null || value === undefined) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const read = (type) => parts.find((part) => part.type === type).value;
    return `${read('year')}-${read('month')}-${read('day')}`;
}

const dateSchema = Joi.string().required().custom((value, helpers) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) && operatingDate(value) ? value : helpers.error('any.invalid'));

const gpsHistorySchema = Joi.object({
    at: dateSchema,
    id: Joi.string().max(256).required(),
    operator: Joi.string().max(256).allow('').default(''),
    identity: Joi.string().valid('vehicle', 'object').default('vehicle'),
}).custom((value, helpers) => value.identity === 'object' && !/^[a-f0-9]{64}$/.test(value.id)
    ? helpers.error('any.invalid') : value);

function historyUrl(position) {
    const day = operatingDate(position.dayOfOperation) || berlinDate(position.timestamp || position.fetchedAt);
    if (!day) return null;
    const physicalVehicle = typeof position.vehicleId === 'string' && position.vehicleId !== '';
    const id = physicalVehicle ? position.vehicleId : position.entityKey;
    if (!id) return null;
    const query = new URLSearchParams();
    if (physicalVehicle) {
        if (position.operator) query.set('operator', position.operator);
    } else query.set('identity', 'object');
    return `/vehicleHistoryGPS/${day}/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`;
}

function productName(position) {
    const code = position.motCode;
    if (code === 2) return 'UBahn';
    if (code === 4) return 'Tram';
    if ([5, 6, 7, 17, 19].includes(code)) return 'Bus';
    if (code === 1) return 'SBahn';
    if ([0, 13, 14, 15, 16, 18].includes(code)) return 'Zug';
    return position.product || 'Unbekannt';
}

function toMapVehicle(position) {
    return {
        PositionSource: 'gps', GPSVehicleKey: position.vehicleKey, GPSEntityKey: position.entityKey,
        Operator: position.operator, VehicleIdentifier: position.vehicleId, JourneyIdentifier: position.journeyId,
        Fahrzeugnummer: position.vehicleId, Produkt: productName(position), Linienname: position.line || '?',
        Richtungstext: position.direction, Latitude: position.latitude, Longitude: position.longitude,
        Haltestellenname: position.currentStop, nextHaltestellenname: position.nextStop,
        Timestamp: position.timestamp, DelaySeconds: position.delaySeconds,
        Betriebstag: operatingDate(position.dayOfOperation) || berlinDate(position.timestamp || position.fetchedAt),
        HistoryUrl: historyUrl(position),
    };
}

async function readGpsVehicleValues(redis, query = {}, now = Date.now()) {
    let entries;
    const box = query.boundingBox;
    if (box) {
        const south = Math.max(box.minLatitude, -85.05112878);
        const north = Math.min(box.maxLatitude, 85.05112878);
        if (south >= north) return {};
        const radians = Math.PI / 180;
        const radius = 6372797.560856; // Redis GEO Earth radius.
        const closestLatitude = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
        const width = Math.max(1, (box.maxLongitude - box.minLongitude) * radians * radius * Math.cos(closestLatitude * radians) * 1.01);
        const height = Math.max(1, (north - south) * radians * radius * 1.01);
        const longitude = (box.minLongitude + box.maxLongitude) / 2;
        const latitude = (south + north) / 2;
        let candidates;
        try {
            candidates = await redis.geosearch(`${PREFIX}GEO`, 'FROMLONLAT', longitude, latitude,
                'BYBOX', width, height, 'm');
        } catch (error) {
            if (!/unknown command.*geosearch/i.test(error.message)) throw error;
            // Redis <6.2: use a containing circle, then the same exact box filter below.
            candidates = await redis.georadius(`${PREFIX}GEO`, longitude, latitude,
                Math.hypot(width, height) / 2, 'm');
        }
        if (!candidates.length) return {};
        const pipeline = redis.pipeline();
        candidates.forEach((member) => pipeline.zscore(`${PREFIX}GEO_EXPIRY`, member));
        const scores = await pipeline.exec();
        entries = [];
        scores.forEach(([error, score], index) => {
            if (error) throw error;
            if (score !== null && Number(score) > now) entries.push(candidates[index], score);
        });
    } else {
        entries = await redis.zrangebyscore(`${PREFIX}GEO_EXPIRY`, `(${now}`, '+inf', 'WITHSCORES');
    }
    // Expiry scores are authoritative even when GEO cleanup is delayed.
    // Only the selected viewport's active snapshots are fetched/deserialized.
    if (!entries.length) return {};
    const members = entries.filter((entry, index) => index % 2 === 0);
    const values = await redis.mget(members.map((member) => `${PREFIX}VEHICLE:${member}`));
    const lineFilter = query.Linie ? new Set(query.Linie.split(',')) : null;
    const result = {};
    values.forEach((value, index) => {
        if (!value) return;
        let position;
        try { position = JSON.parse(value); } catch { return; }
        if (position?.source !== 'vmi' || position.vehicleKey !== members[index]) return;
        const latitude = position.latitude;
        const longitude = position.longitude;
        const timestamp = position.timestamp ? Date.parse(position.timestamp) : NaN;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 85.05112878
            || Math.abs(longitude) > 180 || !Number.isFinite(timestamp) || timestamp > now) return;
        // The snapshot and its expiry must describe the same source observation.
        // A newer source timestamp is also safe if the worker refreshed between the two reads.
        const expiresAt = Number(entries[index * 2 + 1]);
        if (!Number.isFinite(expiresAt) || expiresAt <= now || timestamp >= expiresAt) return;
        if (lineFilter && !lineFilter.has(position.line)) return;
        if (box && (longitude < box.minLongitude || longitude > box.maxLongitude
            || latitude < box.minLatitude || latitude > box.maxLatitude)) return;
        result[`gps:${members[index]}`] = toMapVehicle(position);
    });
    return result;
}

const isoTimestamp = (value) => {
    if (!value) return null;
    const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

async function queryGpsHistory(client, params) {
    const selector = params.identity === 'object'
        ? 'entity_key = {id:String}'
        : "vehicle_id = {id:String} AND ifNull(operator, '') = {operator:String}";
    const result = await client.query({
        query: `
            WITH matching_fahrten AS (
                SELECT * FROM gps_fahrten FINAL WHERE source = 'vmi' AND ${selector}
            ), multiIf(
                match(ifNull(day_of_operation, ''), '^[0-9]{2}[.][0-9]{2}[.][0-9]{4}$'),
                concat(substring(day_of_operation, 7, 4), '-', substring(day_of_operation, 4, 2), '-', substring(day_of_operation, 1, 2)),
                match(ifNull(day_of_operation, ''), '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'), day_of_operation,
                '') AS normalized_day,
                toDateOrNull(normalized_day) AS parsed_day
            SELECT o.timestamp, o.fetched_at, o.latitude, o.longitude, o.delay_seconds,
                   f.line, f.direction, f.journey_id, o.current_stop, o.next_stop, f.mot_code, f.product
            FROM (
                SELECT * FROM gps_observations FINAL
                WHERE source = 'vmi' AND gps_fahrt_id IN (SELECT gps_fahrt_id FROM matching_fahrten)
            ) AS o
            INNER JOIN matching_fahrten AS f ON o.gps_fahrt_id = f.gps_fahrt_id
            WHERE 1
              AND if(ifNull(toString(parsed_day) = normalized_day, 0), parsed_day,
                     toDate(coalesce(timestamp, fetched_at), 'Europe/Berlin')) = {day:Date}
              AND isNotNull(latitude) AND isNotNull(longitude)
              AND latitude BETWEEN -85.05112878 AND 85.05112878
              AND longitude BETWEEN -180 AND 180
            ORDER BY coalesce(o.timestamp, o.fetched_at) DESC, o.fetched_at DESC, o.entity_key, o.observation_id
            LIMIT ${MAX_HISTORY_POINTS + 1}
        `,
        query_params: { id: params.id, operator: params.operator || '', day: params.at },
        format: 'JSONEachRow',
    });
    const rows = await result.json();
    return {
        source: 'vmi', date: params.at, identity: params.identity,
        vehicleId: params.identity === 'vehicle' ? params.id : null, operator: params.operator || null,
        truncated: rows.length > MAX_HISTORY_POINTS,
        points: rows.slice(0, MAX_HISTORY_POINTS).reverse().map((row) => ({
            timestamp: isoTimestamp(row.timestamp), fetchedAt: isoTimestamp(row.fetched_at),
            latitude: row.latitude, longitude: row.longitude, delaySeconds: row.delay_seconds,
            line: row.line, direction: row.direction, journeyId: row.journey_id,
            currentStop: row.current_stop, nextStop: row.next_stop, motCode: row.mot_code, product: row.product,
        })),
    };
}

module.exports = { operatingDate, berlinDate, gpsHistorySchema, historyUrl, toMapVehicle, readGpsVehicleValues, queryGpsHistory };
