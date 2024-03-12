const HyperExpress = require('hyper-express');
const { limiter } = require('@middleware/limiter');
const { monitorRedis, findAllMetricKeys, getValuesFromKeys, calculateRateAndAverageResponseTimeAndReset, findAllMetricListKeys, countStatusCodesByKey, findAllErrorListKeys } = require('@lib/redis');
const { Metric, MetricList, ErrorList, RedisInfo } = require('@config/metrics');
const router = new HyperExpress.Router();

/* Plugin info*/
const PluginName = 'Metrics'; //This plugins name
const PluginRequirements = []; //Put your Requirements and version here <Name, not file name>|Version
const PluginVersion = '0.0.1'; //This plugins version

const metricsScanTime = 10; // Scan for metrics every 5 seconds
let metricsFirstScan = false;
const metricsTempObject = {};

const updateMetrics = async () => {
    const allMetricKeys = await findAllMetricKeys();
    const allMetricListKeys = await findAllMetricListKeys();
    const allErrorListKeys = await findAllErrorListKeys();
    metricsTempObject.allMetricValues = await getValuesFromKeys(allMetricKeys);
    metricsTempObject.ratesAndAverages = await calculateRateAndAverageResponseTimeAndReset(allMetricListKeys, metricsScanTime);
    metricsTempObject.statusCodeCounts = await countStatusCodesByKey(allErrorListKeys);
    metricsTempObject.RedisInfo = await monitorRedis();
    metricsFirstScan = true;
}

updateMetrics();

setInterval(() => {
    updateMetrics()
}, metricsScanTime * 1000);

router.get('', limiter(), async (req, res) => {
    if(!metricsFirstScan) {
        res.status(503).send('Metrics are not ready yet');
    }
    let metrics = [];

    for (const [key, value] of Object.entries(metricsTempObject.allMetricValues)) {
        const metric = Metric[key];
        metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
        metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

        metrics.push(`${metric.Metric} ${value}`);
    }

    for (const [key, value] of Object.entries(metricsTempObject.ratesAndAverages)) {
        for (const [sub_key, sub_value] of Object.entries(value)) {
            const metric = MetricList[key][sub_key];
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

            metrics.push(`${metric.Metric} ${sub_value}`);
        }
    }

    for (const [key, value] of Object.entries(metricsTempObject.statusCodeCounts)) {
        for (const [sub_key, sub_value] of Object.entries(value)) {
            
            const metric = ErrorList[key][sub_key];
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

            metrics.push(`${metric.Metric} ${sub_value}`);
        }
    }

    for (const [key, value] of Object.entries(metricsTempObject.RedisInfo)) {
        for (const [sub_key, sub_value] of Object.entries(value)) {
            
            const metric = RedisInfo[key][sub_key];
            metrics.push(`# HELP ${metric.Metric} ${metric.Help}`);
            metrics.push(`# TYPE ${metric.Metric} ${metric.Type}`);

            metrics.push(`${metric.Metric} ${sub_value}`);
        }
    }

    res.send(metrics.join('\n'));

});

module.exports = {
    router: router,
    PluginName: PluginName,
    PluginRequirements: PluginRequirements,
    PluginVersion: PluginVersion,
};