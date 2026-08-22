const express = require('ultimate-express');
const { verifyRequest } = require('@middleware/verifyRequest');
const { StopObjectStore } = require('@lib/haltestellen_cache');
const { getDepartureDiscoveryDiagnostics } = require('@lib/redis');

const router = new express.Router();
const PluginName = 'Departure Discovery Diagnostics';
const PluginRequirements = [];
const PluginVersion = '1.0.0';
const normalizeProduct = (product) => String(product || '').replace(/[\s-]/g, '').toLowerCase();

router.get('/stops', verifyRequest('api.departureDiscovery.read'), async (req, res) => {
    const diagnostics = await getDepartureDiscoveryDiagnostics();
    const configuredProducts = new Set((diagnostics.state.configuredProducts || []).map(normalizeProduct));
    const stops = StopObjectStore.filterByQuery({}).map((stop) => {
        const stopId = String(stop.VGNKennung);
        const candidate = diagnostics.candidates.has(stopId);
        const mentioned = diagnostics.mentioned.has(stopId);
        const known = diagnostics.known.has(stopId);
        const stopProducts = String(stop.Produkte || '').split(',').map(normalizeProduct);
        const productMatches = configuredProducts.size === 0
            || stopProducts.some((product) => configuredProducts.has(product));
        let eligibility = 'not-learned';
        if (candidate) eligibility = 'candidate';
        else if (mentioned) eligibility = 'covered-by-trips';
        else if (known) eligibility = 'known-not-candidate';
        else if (!productMatches) eligibility = 'product-filtered';

        return {
            VGNKennung: stop.VGNKennung,
            VAGKennung: stop.VAGKennung,
            Haltestellenname: stop.Haltestellenname,
            Latitude: stop.Latitude,
            Longitude: stop.Longitude,
            Produkte: stop.Produkte,
            known,
            mentioned,
            candidate,
            productMatches,
            eligibility,
            scheduledAt: diagnostics.schedule[stopId]
                ? new Date(diagnostics.schedule[stopId]).toISOString()
                : null,
            lastRequest: diagnostics.requests[stopId] || null,
        };
    });

    res.json({ state: diagnostics.state, stops });
});

module.exports = { router, PluginName, PluginRequirements, PluginVersion };
