/**
 * Analyze the route data and return the last stop index and the progress of the current trip
 * @param {Array} routeData 
 * @param {String} currentTimestamp 
 * @returns 
 */
const getLastStopAndProgress = (routeData, currentTimestamp) => {
    const now = new Date(currentTimestamp);
    let lastStopIndex = -1;
    let vgnCodes = [];
    let progress = 0;

    for (let i = 0; i < routeData.length; i++) {
        const stop = routeData[i];
        let departureTime = stop.AbfahrtszeitIst ? new Date(stop.AbfahrtszeitIst) : null;

        if (departureTime && departureTime < now) {
            lastStopIndex = i;
            vgnCodes.push(stop.VGNKennung);
        } else {
            break; // Stop iteration if we found the last stop
        }
    }

    if (lastStopIndex !== -1 && lastStopIndex < routeData.length - 1) {
        const lastDepartureTime = new Date(routeData[lastStopIndex].AbfahrtszeitIst);
        const nextArrivalTime = new Date(routeData[lastStopIndex + 1].AnkunftszeitIst);

        const totalTime = nextArrivalTime - lastDepartureTime;
        const elapsedTime = now - lastDepartureTime;

        progress = elapsedTime / totalTime;
        progress = Math.max(0, Math.min(progress, 1));
    }

    return {
        lastStopIndex,
        vgnCodes,
        progress
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
    removeDuplicatesAndKeepOrder
}