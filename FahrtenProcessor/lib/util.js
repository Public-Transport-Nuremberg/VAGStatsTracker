/**
 * Analyze the route data and return the last stop index and the progress of the current trip
 * @param {Array} routeData 
 * @param {String} currentTimestamp 
 * @returns 
 */
const toTimestamp = (value) => {
    if (value === null || value === undefined || value === '' || value === -1 || value === '-1') {
        return null;
    }
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
};

const firstTimestamp = (...values) => {
    for (const value of values) {
        const timestamp = toTimestamp(value);
        if (timestamp !== null) return timestamp;
    }
    return null;
};

const getArrivalTimestamp = (stop) => firstTimestamp(
    stop.AnkunftszeitIst,
    stop.AnkunftszeitSoll,
    stop.AbfahrtszeitIst,
    stop.AbfahrtszeitSoll
);

const getSegmentStartTimestamp = (currentStop, nextStop) => {
    const departureTimestamp = firstTimestamp(
        currentStop.AbfahrtszeitIst,
        currentStop.AbfahrtszeitSoll
    );
    const currentArrivalTimestamp = firstTimestamp(
        currentStop.AnkunftszeitIst,
        currentStop.AnkunftszeitSoll
    );
    const nextActualArrivalTimestamp = toTimestamp(nextStop.AnkunftszeitIst);
    const nextScheduledArrivalTimestamp = toTimestamp(nextStop.AnkunftszeitSoll);
    const earlyArrival = nextActualArrivalTimestamp !== null && nextScheduledArrivalTimestamp !== null
        ? Math.max(nextScheduledArrivalTimestamp - nextActualArrivalTimestamp, 0)
        : 0;

    if (departureTimestamp === null) return currentArrivalTimestamp;

    // AbfahrtIst never reports early departures. Shift it by the early arrival
    // reported for the next stop so the segment remains temporally consistent.
    const effectiveDepartureTimestamp = departureTimestamp - earlyArrival;
    return currentArrivalTimestamp === null
        ? effectiveDepartureTimestamp
        : Math.max(effectiveDepartureTimestamp, currentArrivalTimestamp);
};

const getLastStopAndProgress = (routeData, currentTimestamp) => {
    const now = new Date(currentTimestamp).getTime();
    if (!Array.isArray(routeData) || routeData.length === 0 || !Number.isFinite(now)) {
        return { lastStopIndex: -1, vgnCodes: [], progress: 0 };
    }

    let lastStopIndex = 0;
    const vgnCodes = [];

    for (let index = 0; index < routeData.length; index++) {
        const stop = routeData[index];
        const arrivalTimestamp = getArrivalTimestamp(stop);
        if (arrivalTimestamp === null || arrivalTimestamp > now) continue;

        // ArrivalIst can be earlier than the preceding AbfahrtIst. Do not stop
        // at an apparently future departure: the furthest reached stop is the
        // only reliable representation of the vehicle's actual position.
        lastStopIndex = index;
        vgnCodes.push(stop.VGNKennung);
    }

    if (lastStopIndex === routeData.length - 1) {
        return { lastStopIndex, vgnCodes, progress: 0 };
    }

    const currentSegmentStartTimestamp = getSegmentStartTimestamp(
        routeData[lastStopIndex],
        routeData[lastStopIndex + 1]
    );
    const nextArrivalTimestamp = getArrivalTimestamp(routeData[lastStopIndex + 1]);
    if (currentSegmentStartTimestamp === null || nextArrivalTimestamp === null || nextArrivalTimestamp <= currentSegmentStartTimestamp) {
        return { lastStopIndex, vgnCodes, progress: 0 };
    }

    return {
        lastStopIndex,
        vgnCodes,
        progress: Math.max(0, Math.min((now - currentSegmentStartTimestamp) / (nextArrivalTimestamp - currentSegmentStartTimestamp), 1)),
    };
}


/**
 * Filter out duplicate Fahrten from the array
 * @param {Array} alreadyTrackedStops
 * @param {Array} fahrten
 */
const removeDuplicatesAndKeepOrder = (alreadyTrackedStops, fahrten) => {
    const set1 = new Set(fahrten);
    const uniqueToArr2 = alreadyTrackedStops.filter(item => !set1.has(item));
    return uniqueToArr2;
}

module.exports = {
    getLastStopAndProgress,
    getSegmentStartTimestamp,
    removeDuplicatesAndKeepOrder
}
