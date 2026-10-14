const express = require('ultimate-express');
const { limiter } = require('@middleware/limiter');
const { monitorRedis, findAllMetricKeys, getValuesFromKeys, calculateRateAndAverageResponseTimeAndReset, findAllMetricListKeys, countStatusCodesByKey, findAllErrorListKeys, findAllTripKeys, getGpsVehicleValues } = require('@lib/redis');
const { Keys, Metric, MetricList, ErrorList, RedisInfo, LiveMap, LiveGPS } = require('@config/metrics');
const { getLiveMapMetrics } = require('@lib/live_map/metrics');
const { summarizeGpsVehicles } = require('@lib/live_gps/metrics');
const router = new express.Router();

/* Plugin info*/
const PluginName = 'Metrics'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

const metricsScanTime = 2; // Scan for metrics every 2 seconds
let metricsFirstScan = false;
const metricsTempObject = {};

const fallbackMetric = (...parts) => {
    let name = parts.join('_').replace(/[^a-zA-Z0-9_:]/g, '_');
    if (!/^[a-zA-Z_:]/.test(name)) name = `_${name}`;

    return {
        Metric: `VAGStats_${name}`,
        Type: 'gauge',
        Help: `Automatically exposed metric ${parts.join('.')}`
    };
};

const updateMetrics = async () => {
    const allMetricKeys = await findAllMetricKeys();
    const allMetricListKeys = await findAllMetricListKeys();
    const allErrorListKeys = await findAllErrorListKeys();
    const allTripKeys = await findAllTripKeys();
    metricsTempObject.allMetricValues = await getValuesFromKeys("METRIC:", allMetricKeys);
    metricsTempObject.ratesAndAverages = await calculateRateAndAverageResponseTimeAndReset(allMetricListKeys, metricsScanTime);
    metricsTempObject.statusCodeCounts = await countStatusCodesByKey(allErrorListKeys);
    metricsTempObject.RedisInfo = await monitorRedis() ?? {};
    metricsTempObject.keys = {
        allMetricKeys: allMetricKeys.length,
        allMetricListKeys: allMetricListKeys.length,
        allErrorListKeys: allErrorListKeys.length,
        allTripKeys: allTripKeys.length
    }
    metricsFirstScan = true;
}

updateMetrics();

setInterval(() => {
    updateMetrics()
}, metricsScanTime * 1000);

router.get('/', limiter(), async (req, res) => {
    if(!metricsFirstScan) {
        return res.status(503).send('Metrics are not ready yet');
    }
    // Read fresh VMI snapshots on every scrape, so expiry is respected even
    // when the collector stops. Use the same reader as GPS map mode, unfiltered.
    const liveGpsMetrics = summarizeGpsVehicles(await getGpsVehicleValues({}));
    let metrics = [];

    for (const [key, value] of Object.entries(metricsTempObject.keys)) {
        const metric = Keys[key] || fallbackMetric('Keys', key);
        metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
        metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

        metrics.push(`${metric.Metric} ${value}`);
    }

    for (const [key, value] of Object.entries(metricsTempObject.allMetricValues)) {
        const metric = Metric[key] || fallbackMetric('Metric', key);
        metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
        metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

        metrics.push(`${metric.Metric} ${value}`);
    }

    for (const [key, value] of Object.entries(metricsTempObject.ratesAndAverages)) {
        for (const [sub_key, sub_value] of Object.entries(value)) {
            const metric = MetricList[key]?.[sub_key] || fallbackMetric('MetricList', key, sub_key);
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

            metrics.push(`${metric.Metric} ${sub_value}`);
        }
    }

    for (const [key, value] of Object.entries(metricsTempObject.statusCodeCounts)) {
        for (const [sub_key, sub_value] of Object.entries(value)) {
            
            const metric = ErrorList[key]?.[sub_key] || fallbackMetric('ErrorList', key, sub_key);
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

            metrics.push(`${metric.Metric} ${sub_value}`);
        }
    }

    for (const [key, value] of Object.entries(metricsTempObject.RedisInfo)) {
        for (const [sub_key, sub_value] of Object.entries(value)) {
            
            const metric = RedisInfo[key]?.[sub_key] || fallbackMetric('RedisInfo', key, sub_key);
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

            metrics.push(`${metric.Metric} ${sub_value}`);
        }
    }

    for (const [definitions, snapshot] of [[LiveMap, getLiveMapMetrics()], [LiveGPS, liveGpsMetrics]]) {
        for (const [key, value] of Object.entries(snapshot.totals)) {
            const metric = definitions[key];
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);
            metrics.push(`${metric.Metric} ${value}`);
        }

        for (const [key, metric] of Object.entries(definitions)) {
            if (!metric.ProductMetric) continue;
            metrics.push(`# HELP ${metric.ProductMetric} ${metric.Help} by product`);
            metrics.push(`# TYPE ${metric.ProductMetric} ${metric.Type}`);
            for (const [product, counts] of Object.entries(snapshot.byProduct)) {
                metrics.push(`${metric.ProductMetric}{product="${product}"} ${counts[key]}`);
            }
        }
    }

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.join('\n'));

});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};
