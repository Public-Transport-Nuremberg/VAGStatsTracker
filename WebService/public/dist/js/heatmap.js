const getYesterdaysDate = () => {
    const date = new Date();
    date.setDate(date.getDate() - 1);

    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();

    return `${yyyy}-${mm}-${dd}`;
}

updateLegend = (minValue, maxValue) => {
    // Update the legend's gradient bar to match the heatmap's color scale
    const legendBar = document.getElementById('legend-bar');
    legendBar.style.background = 'linear-gradient(to right, blue, red)';

    // Update min and max labels
    document.getElementById('legend-min').textContent = minValue.toString();
    document.getElementById('legend-max').textContent = maxValue.toString();
}

const map = new ol.Map({
    target: 'map',
    layers: [
        new ol.layer.Tile({
            source: new ol.source.OSM()
        })
    ],
    view: new ol.View({
        center: ol.proj.fromLonLat([11.1131575166207, 49.487582179245]),
        zoom: 13
    })
});

const heatmapLayer = new ol.layer.Heatmap({
    source: new ol.source.Vector(),
    blur: parseInt(15, 10),
    radius: parseInt(25, 10),
});

map.addLayer(heatmapLayer);

let queryString = window.location.search;

// If queryString is empty, fetch yesterday's data ?at=yyyy-mm-dd
queryString === '' ? queryString = `?at=${getYesterdaysDate()}` : queryString;

fetch(`/api/v1/heatmap${queryString}`)
    .then(function (response) {
        return response.json();
    })
    .then(function (data) {
        const minDelay = Math.min(...data.map(item => Math.max(item.avg_delay, 1)));
        const maxDelay = Math.max(...data.map(item => Math.max(item.avg_delay, 1)));
        updateLegend(minDelay, maxDelay);
        const features = data.map(function (point) {
            const delay = Math.max(point.avg_delay, 1);
            const normalizedWeight = (delay - minDelay) / (maxDelay - minDelay);
            const feature = new ol.Feature({
                geometry: new ol.geom.Point(ol.proj.fromLonLat([point.longitude, point.latitude])),
                weight: normalizedWeight * normalizedWeight * normalizedWeight
            });
            return feature;
        });

        heatmapLayer.getSource().addFeatures(features);
    })
    .catch(function (error) {
        console.log('Error fetching or parsing data:', error);
    });