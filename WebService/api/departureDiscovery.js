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
    const configuredProductNames = diagnostics.state.configuredProducts || [];
    const configuredProducts = new Set(configuredProductNames.map(normalizeProduct));
    let unscheduledCandidates = 0;
    const stops = StopObjectStore.filterByQuery({}).map((stop) => {
        const stopId = String(stop.VGNKennung);
        const candidate = diagnostics.candidates.has(stopId);
        const mentioned = diagnostics.mentioned.has(stopId);
        const known = diagnostics.known.has(stopId);
        const required = diagnostics.required.has(stopId);
        const stopProductNames = String(stop.Produkte || '').split(',').map((product) => product.trim()).filter(Boolean);
        const stopProducts = stopProductNames.map(normalizeProduct);
        const matchingProducts = stopProductNames.filter((product) => configuredProducts.has(normalizeProduct(product)));
        const productMatches = configuredProducts.size === 0
            || stopProducts.some((product) => configuredProducts.has(product));
        let eligibility = 'not-learned';
        if (candidate) eligibility = 'candidate';
        else if (known) eligibility = 'known-not-candidate';
        else if (mentioned) eligibility = 'covered-by-trips';

        const scheduledAt = diagnostics.schedule[stopId]
            ? new Date(diagnostics.schedule[stopId]).toISOString()
            : null;
        if (candidate && !scheduledAt) unscheduledCandidates++;
        const candidateReason = required
            ? 'previously-discovered-additional-trip'
            : candidate && !known
                ? 'not-primary-learned'
                : null;

        return {
            VGNKennung: stop.VGNKennung,
            VAGKennung: stop.VAGKennung,
            Haltestellenname: stop.Haltestellenname,
            Latitude: stop.Latitude,
            Longitude: stop.Longitude,
            Produkte: stop.Produkte,
            known,
            required,
            mentioned,
            candidate,
            candidateReason,
            productMatches,
            stopProducts: stopProductNames,
            configuredProducts: configuredProductNames,
            matchingProducts,
            eligibility,
            scheduledAt,
            lastRequest: diagnostics.requests[stopId] || null,
        };
    });

    res.json({ state: { ...diagnostics.state, unscheduledCandidates }, stops });
});

module.exports = { router, PluginName, PluginRequirements, PluginVersion };
