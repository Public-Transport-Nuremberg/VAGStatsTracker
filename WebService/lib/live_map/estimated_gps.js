const VALID_LINES = new Set(['4', '5', '6', '7', '8', '10', '11', 'U1', 'U2', 'U3']);
const EARTH_RADIUS_METERS = 6371008.8;
const LINE_GEOMETRY_RETRY_MS = 60000;
const lineGeometryCache = new Map();
const lineGeometryRetryAfter = new Map();
const stopProjectionCache = new Map();

const toRadians = (degrees) => degrees * Math.PI / 180;
const clampProgress = (progress) => Math.max(0, Math.min(1, Number(progress) || 0));

const toTimestamp = (value) => {
    if (value === null || value === undefined || value === '' || value === -1 || value === '-1') {
        return null;
    }
    const timestamp = typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
};

const firstTimestamp = (...values) => {
    for (const value of values) {
        const timestamp = toTimestamp(value);
        if (timestamp !== null) return timestamp;
    }
    return null;
};

const calculateTripProgress = (trip, now = Date.now()) => {
    const storedProgress = clampProgress(trip.PercentageToNextStop);
    const departureTime = firstTimestamp(
        trip.AbfahrtszeitIst,
        trip.AbfahrtszeitSoll,
        trip.AnkunftszeitIst,
        trip.AnkunftszeitSoll
    );
    const nextArrivalTime = firstTimestamp(
        trip.nextAnkunftszeitIst,
        trip.nextAnkunftszeitSoll,
        trip.nextAbfahrtszeitIst,
        trip.nextAbfahrtszeitSoll
    );

    if (departureTime === null || nextArrivalTime === null || nextArrivalTime <= departureTime) {
        return storedProgress;
    }

    return clampProgress((Number(now) - departureTime) / (nextArrivalTime - departureTime));
};

const distanceMeters = (point1, point2) => {
    const latitude1 = toRadians(point1[1]);
    const latitude2 = toRadians(point2[1]);
    const latitudeDelta = latitude2 - latitude1;
    const longitudeDelta = toRadians(point2[0] - point1[0]);
    const a = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const prepareGeometry = (coordinates) => {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

    const points = coordinates.map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]);
    if (points.some(([longitude, latitude]) => !Number.isFinite(longitude)
        || !Number.isFinite(latitude)
        || longitude < -180
        || longitude > 180
        || latitude < -90
        || latitude > 90)) {
        return null;
    }

    const cumulativeDistances = [0];
    for (let index = 1; index < points.length; index++) {
        cumulativeDistances.push(
            cumulativeDistances[index - 1] + distanceMeters(points[index - 1], points[index])
        );
    }

    return { points, cumulativeDistances };
};

const getLineGeometry = async (vgn, line) => {
    if (!VALID_LINES.has(line)) return null;
    if ((lineGeometryRetryAfter.get(line) || 0) > Date.now()) return null;

    if (!lineGeometryCache.has(line)) {
        const geometryPromise = Promise.resolve()
            .then(() => vgn.geoLines(line))
            .then((response) => {
                if (response instanceof Error) throw response;
                const geometry = prepareGeometry(response?.Cords ?? response);
                if (!geometry) throw new Error('Invalid line geometry response');
                lineGeometryRetryAfter.delete(line);
                return geometry;
            })
            .catch((error) => {
                lineGeometryCache.delete(line);
                lineGeometryRetryAfter.set(line, Date.now() + LINE_GEOMETRY_RETRY_MS);
                process.log?.warn?.(`Failed to load geometry for line ${line}: ${error.message}`);
                return null;
            });
        lineGeometryCache.set(line, geometryPromise);
    }

    return lineGeometryCache.get(line);
};

const projectOntoGeometry = (position, geometry) => {
    const [longitude, latitude] = position;
    const longitudeScale = Math.cos(toRadians(latitude));
    let closest = null;

    for (let index = 0; index < geometry.points.length - 1; index++) {
        const start = geometry.points[index];
        const end = geometry.points[index + 1];
        const dx = (end[0] - start[0]) * longitudeScale;
        const dy = end[1] - start[1];
        const lengthSquared = (dx * dx) + (dy * dy);
        const offsetX = (longitude - start[0]) * longitudeScale;
        const offsetY = latitude - start[1];
        const fraction = lengthSquared === 0
            ? 0
            : Math.max(0, Math.min(1, ((offsetX * dx) + (offsetY * dy)) / lengthSquared));
        const projected = [
            start[0] + ((end[0] - start[0]) * fraction),
            start[1] + ((end[1] - start[1]) * fraction),
        ];
        const squaredDistance = (((longitude - projected[0]) * longitudeScale) ** 2)
            + ((latitude - projected[1]) ** 2);

        if (!closest || squaredDistance < closest.squaredDistance) {
            const segmentLength = geometry.cumulativeDistances[index + 1]
                - geometry.cumulativeDistances[index];
            closest = {
                distanceAlongLine: geometry.cumulativeDistances[index] + (segmentLength * fraction),
                squaredDistance,
            };
        }
    }

    return closest;
};

const getStopProjection = (line, position, geometry) => {
    const cacheKey = `${line}:${position[0]}:${position[1]}`;
    if (!stopProjectionCache.has(cacheKey)) {
        stopProjectionCache.set(cacheKey, projectOntoGeometry(position, geometry));
    }
    return stopProjectionCache.get(cacheKey);
};

const pointAtDistance = (geometry, distanceAlongLine) => {
    const distances = geometry.cumulativeDistances;
    let low = 0;
    let high = distances.length - 1;

    while (low < high - 1) {
        const middle = Math.floor((low + high) / 2);
        if (distances[middle] <= distanceAlongLine) low = middle;
        else high = middle;
    }

    const segmentLength = distances[low + 1] - distances[low];
    const fraction = segmentLength === 0
        ? 0
        : (distanceAlongLine - distances[low]) / segmentLength;
    const start = geometry.points[low];
    const end = geometry.points[low + 1];

    return {
        Longitude: start[0] + ((end[0] - start[0]) * fraction),
        Latitude: start[1] + ((end[1] - start[1]) * fraction),
    };
};

const estimateGpsPosition = async (vgn, line, currentStop, nextStop, progress) => {
    const normalizedLine = String(line).trim();
    if (!VALID_LINES.has(normalizedLine)) return null;

    const currentPosition = [Number(currentStop?.Longitude), Number(currentStop?.Latitude)];
    const nextPosition = [Number(nextStop?.Longitude), Number(nextStop?.Latitude)];
    if (![...currentPosition, ...nextPosition].every(Number.isFinite)) return null;

    const geometry = await getLineGeometry(vgn, normalizedLine);
    if (!geometry) return null;

    const currentProjection = getStopProjection(normalizedLine, currentPosition, geometry);
    const nextProjection = getStopProjection(normalizedLine, nextPosition, geometry);
    if (!currentProjection || !nextProjection) return null;

    const normalizedProgress = Math.max(0, Math.min(1, Number(progress) || 0));
    const estimatedDistance = currentProjection.distanceAlongLine
        + ((nextProjection.distanceAlongLine - currentProjection.distanceAlongLine) * normalizedProgress);

    return pointAtDistance(geometry, estimatedDistance);
};

module.exports = {
    VALID_LINES,
    calculateTripProgress,
    estimateGpsPosition,
    prepareGeometry,
};
