(function () {
  "use strict";
  const parts = window.location.pathname.split("/");
  const at = decodeURIComponent(parts[parts.length - 2] || "");
  const id = decodeURIComponent(parts[parts.length - 1] || "");
  const query = new URLSearchParams(window.location.search);
  const requestedOperator = query.get("operator");
  const identity = query.get("identity") === "object" ? "object" : "vehicle";
  const $ = (name) => document.getElementById(name);
  const status = $("gpsStatus"), meta = $("gpsMeta"), slider = $("timeSlider"), panel = $("gpsPanel");
  const trailSource = new ol.source.Vector(), markerSource = new ol.source.Vector();
  const map = new ol.Map({ target: "map", layers: [new ol.layer.Tile({ source: new ol.source.OSM() })], view: new ol.View({ center: ol.proj.fromLonLat([11.08, 49.45]), zoom: 11 }) });
  map.addLayer(new ol.layer.Vector({ source: trailSource, style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: "#2563eb", width: 4 }) }) }));
  map.addLayer(new ol.layer.Vector({ source: markerSource }));
  let points = [], projected = [], cumulativeKm = [], vehicleId = null, responseOperator = null;
  const pointTime = (point) => point.timestamp || point.fetchedAt || null;
  const displayTime = (value) => value ? new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "medium" }) : "unbekannte Zeit";
  function isBreak(previous, current) {
    if (!previous) return false;
    if (previous.journeyId !== current.journeyId) return true;
    const previousTime = pointTime(previous), currentTime = pointTime(current);
    return Boolean(previousTime && currentTime && new Date(currentTime) - new Date(previousTime) > 300000);
  }
  function haversineKm(a, b) {
    const radians = Math.PI / 180;
    const value = Math.sin((b.latitude - a.latitude) * radians / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin((b.longitude - a.longitude) * radians / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(value)));
  }
  function prepare(raw) {
    points = raw.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
    projected = points.map((point) => ol.proj.fromLonLat([point.longitude, point.latitude]));
    cumulativeKm = [];
    points.forEach((point, index) => {
      cumulativeKm[index] = index && !isBreak(points[index - 1], point)
        ? cumulativeKm[index - 1] + haversineKm(points[index - 1], point)
        : index ? cumulativeKm[index - 1] : 0;
    });
  }
  function drawThrough(index) {
    trailSource.clear();
    let segment = [];
    for (let i = 0; i <= index; i += 1) {
      if (i && isBreak(points[i - 1], points[i])) {
        if (segment.length > 1) trailSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(segment) }));
        segment = [];
      }
      segment.push(projected[i]);
    }
    if (segment.length > 1) trailSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(segment) }));
  }
  function render(index) {
    const point = points[index];
    if (!point) return;
    drawThrough(index);
    markerSource.clear();
    const marker = new ol.Feature({ geometry: new ol.geom.Point(projected[index]) });
    marker.setStyle(new ol.style.Style({ image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: "#dc2626" }), stroke: new ol.style.Stroke({ color: "#fff", width: 2 }) }) }));
    markerSource.addFeature(marker);
    const sourceTime = point.timestamp ? `Zeit: ${displayTime(point.timestamp)}` : `Empfangszeit: ${displayTime(point.fetchedAt)}`;
    const delay = point.delaySeconds == null ? "unbekannt" : `${point.delaySeconds > 0 ? "+" : ""}${point.delaySeconds} s`;
    meta.replaceChildren();
    [sourceTime, `Linie: ${point.line || "unbekannt"}`, `Richtung: ${point.direction || "unbekannt"}`, `Betreiber: ${responseOperator || requestedOperator || "unbekannt"}`, `Fahrzeug: ${vehicleId || id}`, `Fahrt: ${point.journeyId || "unbekannt"}`, `Verspätung: ${delay}`, `Beobachtete Entfernung: ${cumulativeKm[index].toFixed(2)} km`].forEach((text) => {
      const row = document.createElement("div");
      row.textContent = text;
      meta.appendChild(row);
    });
  }
  async function load() {
    try {
      const params = new URLSearchParams({ identity });
      if (requestedOperator) params.set("operator", requestedOperator);
      const response = await fetch(`/api/v1/vehicle/gps/history/${encodeURIComponent(at)}/${encodeURIComponent(id)}?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      vehicleId = data.vehicleId; responseOperator = data.operator;
      prepare(Array.isArray(data.points) ? data.points : []);
      panel.setAttribute("aria-busy", "false");
      if (!points.length) { status.textContent = "Keine beobachteten GPS-Punkte für diesen Tag."; return; }
      slider.max = String(points.length - 1); slider.value = String(points.length - 1); slider.disabled = false;
      $("gpsStart").textContent = displayTime(pointTime(points[0]));
      $("gpsEnd").textContent = displayTime(pointTime(points[points.length - 1]));
      status.textContent = `${points.length} beobachtete Punkte · ${data.date || at}${data.truncated ? " · Hinweis: Ergebnis gekürzt" : ""}`;
      const extent = ol.extent.boundingExtent(projected);
      render(points.length - 1);
      map.getView().fit(extent, { padding: [70, 30, Math.min(panel.offsetHeight + 30, window.innerHeight / 2), 30], maxZoom: 16, duration: 250 });
    } catch (error) {
      panel.setAttribute("aria-busy", "false"); status.textContent = "GPS-Historie konnte nicht geladen werden."; console.error(error);
    }
  }
  slider.addEventListener("input", () => render(Number(slider.value)));
  load();
}());
