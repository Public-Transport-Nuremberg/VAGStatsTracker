(() => {
  const tokenInput = document.getElementById('token');
  const connectButton = document.getElementById('connect');
  const filterInput = document.getElementById('filter');
  const searchInput = document.getElementById('search');
  const summary = document.getElementById('summary');
  const popupElement = document.getElementById('popup');
  let stops = [];
  let state = {};
  let timer = null;

  const source = new ol.source.Vector();
  const layer = new ol.layer.Vector({ source });
  const map = new ol.Map({
    target: 'discoveryMap',
    layers: [new ol.layer.Tile({ source: new ol.source.OSM() }), layer],
    view: new ol.View({ center: ol.proj.fromLonLat([11.08, 49.45]), zoom: 11 }),
  });
  const popup = new ol.Overlay({ element: popupElement, positioning: 'bottom-center', offset: [0, -10], stopEvent: true });
  map.addOverlay(popup);

  const colors = {
    candidate: '#2563eb', covered: '#059669', error: '#dc2626', discovered: '#7e22ce',
    running: '#ea580c', unknown: '#64748b',
  };
  const styles = new Map();
  const getColor = (stop) => {
    if (stop.lastRequest?.state === 'running') return colors.running;
    if (stop.lastRequest?.state === 'error') return colors.error;
    if (Number(stop.lastRequest?.newTrips) > 0) return colors.discovered;
    if (stop.candidate) return colors.candidate;
    if (stop.mentioned) return colors.covered;
    return colors.unknown;
  };
  const getStyle = (stop) => {
    const color = getColor(stop);
    if (!styles.has(color)) {
      styles.set(color, new ol.style.Style({
        image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color }), stroke: new ol.style.Stroke({ color: '#fff', width: 1 }) }),
      }));
    }
    return styles.get(color);
  };

  const escapeHtml = (value) => String(value ?? '-').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
  const formatDate = (value) => value ? new Date(value).toLocaleString() : 'Nie';
  const eligibilityLabel = {
    candidate: 'Discovery-Kandidat',
    'covered-by-trips': 'In aktueller Fahrten-Antwort erwähnt',
    'known-not-candidate': 'Gelernte Haltestelle, aktuell kein Kandidat',
    'not-learned': 'Noch nicht aus getTrip gelernt',
  };

  const matchesFilter = (stop) => {
    const filter = filterInput.value;
    const query = searchInput.value.trim().toLowerCase();
    if (query && !`${stop.Haltestellenname} ${stop.VGNKennung} ${stop.VAGKennung}`.toLowerCase().includes(query)) return false;
    if (filter === 'candidate') return stop.candidate;
    if (filter === 'scheduled') return Boolean(stop.scheduledAt);
    if (filter === 'error') return stop.lastRequest?.state === 'error';
    if (filter === 'discovered') return Number(stop.lastRequest?.newTrips) > 0;
    if (filter === 'never') return !stop.lastRequest;
    return true;
  };

  const render = () => {
    source.clear();
    const visible = stops.filter(matchesFilter);
    for (const stop of visible) {
      const longitude = Number(stop.Longitude);
      const latitude = Number(stop.Latitude);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      const feature = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([longitude, latitude])), stop });
      feature.setStyle(getStyle(stop));
      source.addFeature(feature);
    }
    summary.textContent = `${visible.length}/${stops.length} Stops · ${state.candidates ?? 0} Kandidaten · ${state.tripsFound ?? 0} neue Fahrten · ${state.running ? 'Scan läuft' : 'Scan inaktiv'} · ${state.completedAt ? `Stand ${formatDate(state.completedAt)}` : 'noch kein Scan'}`;
  };

  const load = async () => {
    const response = await fetch('/api/v1/departureDiscovery/stops', {
      headers: { Authorization: `Bearer ${tokenInput.value.trim()}` },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    stops = payload.stops;
    state = payload.state || {};
    render();
  };

  const connect = async () => {
    clearInterval(timer);
    try {
      await load();
      sessionStorage.setItem('apiTraceToken', tokenInput.value.trim());
      timer = setInterval(() => load().catch((error) => { summary.textContent = `Live-Fehler: ${error.message}`; }), 5000);
    } catch (error) {
      summary.textContent = `Verbindung fehlgeschlagen: ${error.message}`;
    }
  };

  map.on('singleclick', (event) => {
    const feature = map.forEachFeatureAtPixel(event.pixel, (candidate) => candidate);
    if (!feature) { popupElement.hidden = true; popup.setPosition(undefined); return; }
    const stop = feature.get('stop');
    const last = stop.lastRequest || {};
    popupElement.innerHTML = `
      <strong>${escapeHtml(stop.Haltestellenname)}</strong>
      <dl class="mt-3">
        <dt>VGN / VAG</dt><dd>${escapeHtml(stop.VGNKennung)} / ${escapeHtml(stop.VAGKennung)}</dd>
        <dt>Status</dt><dd>${escapeHtml(eligibilityLabel[stop.eligibility] || stop.eligibility)}</dd>
        <dt>Nächster geplanter Request</dt><dd>${escapeHtml(formatDate(stop.scheduledAt))}</dd>
        <dt>Letzter Request</dt><dd>${escapeHtml(formatDate(last.requestedAt))}</dd>
        <dt>Ergebnis</dt><dd>${escapeHtml(last.state || 'Noch nie')} · HTTP ${escapeHtml(last.statusCode)} · ${escapeHtml(last.durationMs)} ms</dd>
        <dt>Abfahrten / neue Fahrten</dt><dd>${escapeHtml(last.departures ?? '-')} / ${escapeHtml(last.newTrips ?? '-')}</dd>
        ${last.error ? `<dt>Fehler</dt><dd>${escapeHtml(last.error)}</dd>` : ''}
      </dl>`;
    popupElement.hidden = false;
    popup.setPosition(event.coordinate);
  });

  filterInput.addEventListener('change', render);
  searchInput.addEventListener('input', render);
  connectButton.addEventListener('click', connect);
  tokenInput.value = sessionStorage.getItem('apiTraceToken') || '';
  if (tokenInput.value) connect();
})();
