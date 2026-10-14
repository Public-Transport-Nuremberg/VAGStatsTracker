const PRODUCTS = ['Bus', 'UBahn', 'Tram', 'SBahn', 'Zug', 'RBahn', 'Unknown'];

const emptyCounts = () => ({ Vehicles: 0, IdentifiedVehicles: 0, UnidentifiedVehicles: 0 });

// Input comes from readGpsVehicleValues, which also supplies the GPS map and
// validates source timestamps, GEO expiry, coordinates and vehicle identity.
const summarizeGpsVehicles = (vehicles) => {
    const totals = emptyCounts();
    const byProduct = Object.fromEntries(PRODUCTS.map((product) => [product, emptyCounts()]));

    for (const vehicle of Object.values(vehicles)) {
        if (vehicle?.PositionSource !== 'gps') continue;
        const product = PRODUCTS.includes(vehicle.Produkt) ? vehicle.Produkt : 'Unknown';
        const identityMetric = typeof vehicle.VehicleIdentifier === 'string' && vehicle.VehicleIdentifier !== ''
            ? 'IdentifiedVehicles' : 'UnidentifiedVehicles';
        totals.Vehicles++;
        totals[identityMetric]++;
        byProduct[product].Vehicles++;
        byProduct[product][identityMetric]++;
    }

    return { totals, byProduct };
};

module.exports = { summarizeGpsVehicles };
