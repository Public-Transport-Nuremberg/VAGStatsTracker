const NOW = Date.parse('2026-10-11T12:00:00Z');

function vehicle(overrides = {}) {
    return {
        ID: 'vmi-object-a', Operator: 'VAN', JourneyIdentifier: 'van:02051:_:H:j26:461',
        DayOfOperation: '11.10.2026', VehicleIdentifier: '00625', Timestamp: '2026-10-11T13:59:40+02:00',
        TimestampPrevious: '2026-10-11T13:59:00+02:00', X: '1233659.294895', Y: '5653744.548515',
        XPrevious: '1233959.857520', YPrevious: '5653142.743814', Latitude: 49.44, Longitude: 11.08,
        LatitudePrevious: 49.45, LongitudePrevious: 11.09, Delay: -82, MOTCode: 5,
        ProductIdentifier: 'BUS', LineText: 'E5', AVMLineID: '705', DirectionText: 'Kornburg',
        CurrentStop: 'AM-RAN:1', NextStop: 'FINK:1', IsAtStop: true, RealtimeAvailable: 1, Distance: 0,
        ...overrides,
    };
}

module.exports = { NOW, vehicle };
