const { createHash, randomUUID } = require('node:crypto');

const DERIVED_FIELDS = new Set(['Latitude', 'Longitude', 'LatitudePrevious', 'LongitudePrevious']);
const REDIS_MAX_LATITUDE = 85.05112878;

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => value === undefined || value === null || String(value).trim() === '' ? null : String(value);
const number = (value) => (typeof value === 'number' || typeof value === 'string')
    && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
        || hour > 23 || minute > 59 || second > 59) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
}

const clickhouseDate = (ms) => ms === null ? null : new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

function position(latitude, longitude) {
    const lat = number(latitude);
    const lon = number(longitude);
    return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { latitude: lat, longitude: lon } : { latitude: null, longitude: null };
}

function normalizeObservation(vehicle, fetchedAt = Date.now()) {
    if (!vehicle || Array.isArray(vehicle) || typeof vehicle !== 'object') throw new Error('VMI vehicle must be an object');
    if (!Number.isFinite(fetchedAt)) throw new Error('Invalid fetchedAt');
    const raw = Object.fromEntries(Object.entries(vehicle).filter(([key]) => !DERIVED_FIELDS.has(key)));
    const rawJson = canonicalJson(raw);
    const payloadHash = hash(rawJson);
    const operator = text(raw.Operator);
    const id = text(raw.ID);
    const journeyId = text(raw.JourneyIdentifier);
    const day = text(raw.DayOfOperation);
    const vehicleId = text(raw.VehicleIdentifier);
    const anonymous = id === null && journeyId === null;
    const identity = id !== null ? ['object', operator, id]
        : journeyId !== null ? ['journey', operator, day, journeyId] : ['anonymous', payloadHash];
    const entityKey = hash(canonicalJson(identity));
    // With no physical vehicle identifier, keep the observation as its own map object.
    const vehicleKey = vehicleId !== null ? hash(canonicalJson(['vehicle', operator, vehicleId])) : `object-${entityKey}`;
    const current = position(vehicle.Latitude, vehicle.Longitude);
    const previous = position(vehicle.LatitudePrevious, vehicle.LongitudePrevious);
    const sourceMs = timestamp(raw.Timestamp);
    const previousMs = timestamp(raw.TimestampPrevious);
    const mot = number(raw.MOTCode);
    const isAtStop = typeof raw.IsAtStop === 'boolean' ? raw.IsAtStop : null;
    const realtimeAvailable = number(raw.RealtimeAvailable);
    const payload = {
        source: 'vmi', entityKey, vehicleKey, anonymous, id, operator, journeyId,
        dayOfOperation: day, vehicleId, ...current,
        latitudePrevious: previous.latitude, longitudePrevious: previous.longitude,
        timestamp: sourceMs === null ? null : new Date(sourceMs).toISOString(),
        timestampPrevious: previousMs === null ? null : new Date(previousMs).toISOString(),
        fetchedAt: new Date(fetchedAt).toISOString(), delaySeconds: number(raw.Delay),
        motCode: mot !== null && Number.isInteger(mot) && mot >= -2147483648 && mot <= 2147483647 ? mot : null,
        product: text(raw.ProductIdentifier), line: text(raw.LineText), direction: text(raw.DirectionText),
        currentStop: text(raw.CurrentStop), nextStop: text(raw.NextStop), isAtStop,
        realtimeAvailable, realtime: realtimeAvailable === null ? null : realtimeAvailable === 1,
        avmLineId: text(raw.AVMLineID), distance: number(raw.Distance), raw,
    };
    const row = {
        observation_id: randomUUID(), source: 'vmi', entity_key: entityKey, anonymous: Number(anonymous),
        object_id: id, operator, journey_id: journeyId, day_of_operation: day, vehicle_id: vehicleId,
        timestamp: clickhouseDate(sourceMs), timestamp_previous: clickhouseDate(previousMs),
        fetched_at: clickhouseDate(fetchedAt), ...current,
        latitude_previous: previous.latitude, longitude_previous: previous.longitude,
        delay_seconds: payload.delaySeconds, mot_code: payload.motCode, product: payload.product,
        line: payload.line, direction: payload.direction, current_stop: payload.currentStop,
        next_stop: payload.nextStop, is_at_stop: isAtStop === null ? null : Number(isAtStop),
        realtime_available: realtimeAvailable, avm_line_id: payload.avmLineId, distance: payload.distance,
        payload_hash: payloadHash, raw_json: rawJson,
    };
    return { entityKey, vehicleKey, payloadHash, payload, row, sourceMs, fetchedAt };
}

function geoExpiry(observation, ttlSeconds) {
    const { sourceMs, fetchedAt, payload } = observation;
    if (sourceMs === null || sourceMs > fetchedAt || sourceMs + ttlSeconds * 1000 <= fetchedAt
        || payload.latitude === null || payload.longitude === null || Math.abs(payload.latitude) > REDIS_MAX_LATITUDE) return 0;
    return sourceMs + ttlSeconds * 1000;
}

module.exports = { canonicalJson, normalizeObservation, geoExpiry, clickhouseDate };
