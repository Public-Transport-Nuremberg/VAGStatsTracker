const PRODUCTS = ['Bus', 'UBahn', 'Tram', 'SBahn', 'RBahn', 'Unknown'];

const emptyCounts = () => ({
    Trips: 0,
    EstimatedGPSTrips: 0,
    StopFallbackTrips: 0,
    MissingPositionTrips: 0,
});

const summarizeLiveMapPositions = (locations, positionsUpdated = 0, refreshedAt = 0, duration = 0) => {
    const totals = {
        ...emptyCounts(),
        PositionsUpdated: positionsUpdated,
        LastRefreshTimestamp: refreshedAt / 1000,
        RefreshDurationMilliseconds: duration,
    };
    const byProduct = Object.fromEntries(PRODUCTS.map((product) => [product, emptyCounts()]));

    for (const location of locations) {
        const product = PRODUCTS.includes(location.product) ? location.product : 'Unknown';
        const validPosition = location.latitude !== null && location.longitude !== null
            && location.latitude !== '' && location.longitude !== ''
            && Number.isFinite(Number(location.latitude))
            && Number.isFinite(Number(location.longitude))
            && Math.abs(Number(location.latitude)) <= 85.05112878
            && Math.abs(Number(location.longitude)) <= 180;
        const positionMetric = !validPosition ? 'MissingPositionTrips'
            : location.estimatedGps ? 'EstimatedGPSTrips' : 'StopFallbackTrips';

        totals.Trips++;
        totals[positionMetric]++;
        byProduct[product].Trips++;
        byProduct[product][positionMetric]++;
    }

    return { totals, byProduct };
};

let snapshot = summarizeLiveMapPositions([]);

const recordLiveMapPositions = (locations, positionsUpdated, refreshedAt, duration) => {
    snapshot = summarizeLiveMapPositions(locations, positionsUpdated, refreshedAt, duration);
};

const getLiveMapMetrics = () => snapshot;

module.exports = { summarizeLiveMapPositions, recordLiveMapPositions, getLiveMapMetrics };
