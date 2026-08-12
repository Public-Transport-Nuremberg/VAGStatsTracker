const source = new ol.source.Vector();
const styleCache = new Map();

const markerStyle = (line, estimated) => {
  const key = `${line}:${estimated}`;
  if (!styleCache.has(key)) {
    styleCache.set(key, new ol.style.Style({
      image: new ol.style.Circle({
        radius: 7,
        fill: new ol.style.Fill({ color: estimated ? '#10a34a' : '#e67e22' }),
        stroke: new ol.style.Stroke({ color: '#fff', width: 2 }),
      }),
      text: new ol.style.Text({
        text: String(line || '?'),
        offsetY: -15,
        font: 'bold 12px sans-serif',
        fill: new ol.style.Fill({ color: '#111' }),
        stroke: new ol.style.Stroke({ color: '#fff', width: 3 }),
      }),
    }));
  }
  return styleCache.get(key);
};

const map = new ol.Map({
  target: 'map',
  layers: [
    new ol.layer.Tile({ source: new ol.source.OSM() }),
    new ol.layer.Vector({ source }),
  ],
  view: new ol.View({
    center: ol.proj.fromLonLat([11.0767, 49.4521]),
    zoom: 12,
  }),
});

const statusElement = document.getElementById('status');
const urlElement = document.getElementById('url');
const detailsElement = document.getElementById('details');
const jsonElement = document.getElementById('json');
let requestController = null;

const setStatus = (message, type = '') => {
  statusElement.textContent = message;
  statusElement.className = type;
};

const loadVisibleTrips = async () => {
  const rawExtent = ol.proj.transformExtent(
    map.getView().calculateExtent(map.getSize()),
    'EPSG:3857',
    'EPSG:4326'
  );
  const extent = [
    Math.max(-180, rawExtent[0]),
    Math.max(-90, rawExtent[1]),
    Math.min(180, rawExtent[2]),
    Math.min(90, rawExtent[3]),
  ];
  const pos1 = `${extent[0]},${extent[1]}`;
  const pos2 = `${extent[2]},${extent[3]}`;
  const url = `/api/v1/live/map?pos1=${encodeURIComponent(pos1)}&pos2=${encodeURIComponent(pos2)}`;
  urlElement.textContent = url;
  setStatus(' Loading...');

  if (requestController) requestController.abort();
  requestController = new AbortController();

  try {
    const response = await fetch(url, { signal: requestController.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    const features = [];

    Object.entries(payload).forEach(([tripId, trip]) => {
      if (tripId === '__meta' || !trip) return;
      const estimated = trip.EstimatedGPS;
      const longitude = Number(estimated?.Longitude ?? trip.Longitude);
      const latitude = Number(estimated?.Latitude ?? trip.Latitude);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;

      const feature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([longitude, latitude])),
        tripId,
        trip,
      });
      feature.setStyle(markerStyle(trip.Linienname, Boolean(estimated)));
      features.push(feature);
    });

    source.clear();
    source.addFeatures(features);
    setStatus(` ${features.length} trips`, 'ok');
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(` ${error.message}`, 'error');
  }
};

map.on('moveend', loadVisibleTrips);
map.on('singleclick', (event) => {
  const feature = map.forEachFeatureAtPixel(event.pixel, (item) => item);
  if (!feature) {
    detailsElement.style.display = 'none';
    return;
  }
  jsonElement.textContent = JSON.stringify({
    tripId: feature.get('tripId'),
    ...feature.get('trip'),
  }, null, 2);
  detailsElement.style.display = 'block';
});
map.on('pointermove', (event) => {
  map.getTargetElement().style.cursor = map.hasFeatureAtPixel(event.pixel) ? 'pointer' : '';
});

document.getElementById('refresh').addEventListener('click', loadVisibleTrips);
loadVisibleTrips();
