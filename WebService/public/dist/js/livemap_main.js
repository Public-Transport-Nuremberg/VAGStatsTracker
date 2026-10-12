const productLabelMap = {
	UBahn: "U-Bahn",
	Tram: "Tram",
	Bus: "Bus",
	SBahn: "S-Bahn",
	Zug: "Zug",
};

let liveMapSource = new URL(window.location.href).searchParams.get("source") === "gps" ? "gps" : "puls";
let connectionVersion = 0;
let liveSocket = null;
let fallbackInterval = null;
let activeFetchController = null;
let mapMoving = false;
let viewportTimer = null;

const liveQueryString = () => {
	const extent = ol.proj.transformExtent(map.getView().calculateExtent(map.getSize()), "EPSG:3857", "EPSG:4326");
	return LiveMapHelpers.viewportQuery(window.location.search, liveMapSource, extent);
};

const updatePositionAges = () => {
	document.querySelectorAll("[data-position-timestamp]").forEach((element) => {
		const age = LiveMapHelpers.ageSeconds(Number(element.dataset.positionTimestamp));
		element.textContent = age === null ? "" : `(${age} s alt)`;
	});
};

const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
}[char]));

const formatSecondsToHTML = (seconds) => {
	if (!Number.isFinite(seconds)) return '<span title="Keine Daten">-</span>';
	const minutes = Math.round(Math.abs(seconds) / 60);
	const sign = seconds >= 0 ? "+" : "-";

	return `<span title="${Math.round(seconds)} Sek">${sign}${minutes} Min</span>`;
};

const formatOccupancy = (besetzungsgrad) => {
	switch (besetzungsgrad) {
		case "Unbekannt":
			return "Unbekannt";
		case "Schwachbesetzt":
			return "Schwach besetzt";
		case "Starkbesetzt":
			return "Stark besetzt";
		case "Ueberfuellt":
			return "Ueberfuellt";
		default:
			return "Unbekannt";
	}
};

const formatLength = (millimeters) => {
	const length = Number(millimeters);
	if (!Number.isFinite(length)) return null;
	return `${(length / 1000).toFixed(1)} m`;
};

const readDoorAccessibility = (info) => {
	const doorCount = Number(info.anzahl_tueren || info.AnzahlTueren || 6);
	const doors = [];

	for (let i = 1; i <= Math.min(Math.max(doorCount, 0), 12); i++) {
		const value = info[`tuer_${i}_mit_aufstellflaeche`];
		if (value === true || value === "ja") doors.push(`<span title="Tuer ${i}: Rollstuhlbereich">[♿]</span>`);
		else if (value === false || value === "nein") doors.push(`<span title="Tuer ${i}: Kein Rollstuhlbereich">[🚪]</span>`);
		else if (value === "nv") doors.push(`<span title="Tuer ${i}: Nicht verfuegbar">[x]</span>`);
	}

	return doors.length ? doors.join(" ") : null;
};

const vehicleSpecRows = (info) => {
	if (!info || typeof info !== "object") return "";

	const kennzeichen = getInfoValue(info, ["Kennzeichen"]);
	const stehplaetze = getInfoValue(info, ["Stehplätze", "Stehplaetze", "Stehplatze", "StehplÃ¤tze"]);
	const sitzplaetze = getInfoValue(info, ["Sitzplätze", "Sitzplaetze", "Sitzplatze", "SitzplÃ¤tze"]);
	const rollstuhlplaetze = getInfoValue(info, ["Rollstuhlplätze", "Rollstuhlplaetze", "Rollstuhlplatze", "RollstuhlplÃ¤tze"]);
	const hasBusDetails = Boolean(kennzeichen || stehplaetze || rollstuhlplaetze);

	const rows = [
		["Name", info.Name],
		["Kennzeichen", kennzeichen],
		["Stehplätze", stehplaetze],
		["Sitzplätze", hasBusDetails ? sitzplaetze : null],
		["Rollstuhlplätze", rollstuhlplaetze],
		["Plätze", info.Gesamtplaetze ? `${info.Gesamtplaetze} gesamt (${info.Sitzplaetze || "-"} Sitz / ${info.Stehplaetze4prom2 || "-"} Steh)` : null],
		["Tueren", readDoorAccessibility(info)],
	].filter(([, value]) => value !== null && value !== undefined && value !== "");

	if (rows.length === 0) return "";

	return `<dl class="lm-specs">${rows.map(([label, value]) => `
		<div>
			<dt>${escapeHTML(label)}</dt>
			<dd>${label === "Tueren" ? value : escapeHTML(value)}</dd>
		</div>
	`).join("")}</dl>`;
};

const getInfoValue = (info, keys) => {
	for (const key of keys) {
		if (info?.[key] !== undefined && info[key] !== null && info[key] !== "") return info[key];
	}
	return null;
};

const vehicleFeatureBadges = (info) => {
	if (!info || typeof info !== "object") return "";

	const emojis = {
		Klimatisierung: "❄️",
		Rollstuhlplaetze: "♿",
		Gas: "⛽",
		Diesel: "⛽️",
		CNG: "🍃",
		Elektro: "🔋",
	};

	const badges = [];
	const airConditioning = getInfoValue(info, ["Klimatisierung"]);
	const wheelchairSpaces = getInfoValue(info, ["Rollstuhlplätze", "Rollstuhlplaetze", "RollstuhlplÃ¤tze"]);
	const fuelType = getInfoValue(info, ["Kraftstoffart"]);

	if (airConditioning) {
		badges.push(`<span class="lm-feature-badge" title="${escapeHTML(airConditioning)}">${emojis.Klimatisierung}</span>`);
	}

	if (wheelchairSpaces) {
		badges.push(`<span class="lm-feature-badge" title="${escapeHTML(wheelchairSpaces)} Rollstuhlplätze">${emojis.Rollstuhlplaetze}</span>`);
	}

	if (fuelType && emojis[fuelType]) {
		badges.push(`<span class="lm-feature-badge" title="${escapeHTML(fuelType)}">${emojis[fuelType]}</span>`);
	}

	return badges.length ? `<span class="lm-feature-badges">${badges.join("")}</span>` : "";
};

const vehicleHeaderLine = (fahrzeugnummer, info) => {
	const label = info?.Name || info?.typ || `Fahrzeug ${fahrzeugnummer || "-"}`;
	return `${escapeHTML(label)}${vehicleFeatureBadges(info)}`;
};

const getVehicleInfo = (fahrzeugnummer, info) => {
	if (fahrzeugnummer === "PVU") {
		return '<p class="lm-muted">(Privat) - Keine Fahrzeugdaten verfuegbar</p>';
	}

	if (typeof info === "string") {
		return `<p class="lm-muted">(${escapeHTML(info)}) - Keine Fahrzeugdaten verfuegbar</p>`;
	}

	if (!info || typeof info !== "object") {
		return '<p class="lm-muted">Keine Fahrzeugdaten verfuegbar</p>';
	}

	return vehicleSpecRows(info);
};

const propertiesToColor = (item) => {
	switch (item.Produkt) {
		case "UBahn":
			return item.Linienname === "U1" ? "#005CA9" : item.Linienname === "U2" ? "#E3000B" : "#008A4B";
		case "Tram":
			return "#7C3AED";
		case "Bus":
			return "#E3000B";
		default:
			return "#111827";
	}
};

const calculateTiming = (p) => {
	const abfahrtszeitIst = new Date(p.AbfahrtszeitIst);
	const abfahrtszeitSoll = new Date(p.AbfahrtszeitSoll);
	const nextAnkunftszeitIst = new Date(p.nextAnkunftszeitIst);
	const nextAnkunftszeitSoll = new Date(p.nextAnkunftszeitSoll);
	const delayLast = abfahrtszeitIst - abfahrtszeitSoll;
	const expectedTravelTime = nextAnkunftszeitSoll - abfahrtszeitSoll;
	const expectedNextArrival = new Date(abfahrtszeitIst.getTime() + expectedTravelTime);
	const delayNext = nextAnkunftszeitIst - expectedNextArrival;

	return {
		abfahrtszeitSoll,
		nextAnkunftszeitSoll,
		delayLast: delayLast / 1000,
		delayNext: delayNext / 1000,
	};
};

const formatStopLine = (label, stopName, products, time, delay) => `
	<p><span>${label}</span>: ${escapeHTML(stopName || "-")} <small>${escapeHTML(products || "")}</small></p>
	<p class="lm-time">${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${formatSecondsToHTML(delay)})</p>
`;

const formatProgress = (progress) => {
	const value = Math.round(Math.max(0, Math.min(1, Number(progress) || 0)) * 100);
	return `<div class="lm-progress" title="${value}% zur naechsten Haltestelle"><span style="width: ${value}%"></span></div>`;
};

const renderVehicleCard = (p, compact = false) => {
	if (p.PositionSource === "gps") return renderGpsVehicleCard(p);
	const timing = calculateTiming(p);
	const color = propertiesToColor(p);
	const vehicleInfoHtml = getVehicleInfo(p.Fahrzeugnummer, p.FahrzeugInfo);
	const vehicleHistory = `<a class="lm-link" href="/vehicleHistory/${escapeHTML(p.Betriebstag)}/${escapeHTML(p.Fahrzeugnummer)}" target="_blank" rel="noopener noreferrer">Fahrzeughistorie</a>`;

	return `
		<article class="lm-content">
			<header class="lm-vehicle-head">
				<span class="lm-route" style="background:${color}">${escapeHTML(p.Linienname || "")}</span>
				<div>
					<h2>${escapeHTML(productLabelMap[p.Produkt] || p.Produkt)} ${escapeHTML(p.Linienname || "")} nach ${escapeHTML(p.Richtungstext || "-")}</h2>
					<p>${vehicleHeaderLine(p.Fahrzeugnummer, p.FahrzeugInfo)}</p>
				</div>
			</header>
			${formatProgress(p.PercentageToNextStop)}
			${formatStopLine("Letzter Halt", p.Haltestellenname, p.Produkte, timing.abfahrtszeitSoll, timing.delayLast)}
			${formatStopLine("Naechster Halt", p.nextHaltestellenname, p.nextProdukte, timing.nextAnkunftszeitSoll, timing.delayNext)}
			${compact ? "" : `
				<p><span>Besetzgrad</span>: ${escapeHTML(formatOccupancy(p.Besetzgrad))}</p>
				${vehicleInfoHtml ? `<section class="lm-vehicle-info">
					<h3>Fahrzeug</h3>
					${vehicleInfoHtml}
				</section>` : ""}
				${p.Fahrzeugnummer === "PVU" ? '<p class="lm-muted">Fahrzeughistorie nicht moeglich</p>' : vehicleHistory}
			`}
		</article>
	`;
};

const renderGpsVehicleCard = (p) => {
	const time = p.Timestamp ? new Date(p.Timestamp) : null;
	const timestamp = time && Number.isFinite(time.getTime()) ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Unbekannt";
	const history = typeof p.HistoryUrl === "string" && p.HistoryUrl.startsWith("/vehicleHistoryGPS/")
		? `<a class="lm-link" href="${escapeHTML(p.HistoryUrl)}" target="_blank" rel="noopener noreferrer">GPS-Fahrzeughistorie</a>` : "";
	return `
		<article class="lm-content">
			<header class="lm-vehicle-head">
				<span class="lm-route" style="background:${propertiesToColor(p)}">${escapeHTML(p.Linienname || "?")}</span>
				<div>
					<h2>${escapeHTML(productLabelMap[p.Produkt] || p.Produkt)} ${escapeHTML(p.Linienname || "?")} nach ${escapeHTML(p.Richtungstext || "-")}</h2>
					<p>Fahrzeug ${escapeHTML(p.VehicleIdentifier || "Unbekannt")} · ${escapeHTML(p.Operator || "Betreiber unbekannt")}</p>
				</div>
			</header>
			<p><span>GPS-Position</span>: ${escapeHTML(timestamp)} ${time && Number.isFinite(time.getTime())
				? `<small data-position-timestamp="${time.getTime()}">(${LiveMapHelpers.ageSeconds(time.getTime())} s alt)</small>` : ""}</p>
			<p><span>Verspätung</span>: ${formatSecondsToHTML(p.DelaySeconds)}</p>
			<p><span>Aktueller Halt</span>: ${escapeHTML(p.Haltestellenname || "-")}</p>
			<p><span>Nächster Halt</span>: ${escapeHTML(p.nextHaltestellenname || "-")}</p>
			${history}
		</article>
	`;
};

const setStatus = (label, state = "idle", tooltip = "") => {
	const status = document.getElementById("liveStatus");
	if (!status) return;
	status.textContent = label;
	status.dataset.state = state;
	if (tooltip) {
		status.dataset.tooltip = tooltip;
		status.title = tooltip;
	} else {
		delete status.dataset.tooltip;
		status.removeAttribute("title");
	}
};

const normalizeProduct = (product) => {
	if (product === "U-Bahn") return "UBahn";
	return product || "Unbekannt";
};

const formatLiveStatusTooltip = (data) => {
	const trips = data?.trips || data || {};
	const meta = data?.__meta || data?.meta || {};
	if (meta.source === "gps") {
		const counts = {};
		getLiveTrips(data).forEach((trip) => {
			const label = productLabelMap[trip.Produkt] || trip.Produkt || "Unbekannt";
			counts[label] = (counts[label] || 0) + 1;
		});
		return ["GPS-Positionen", ...Object.entries(counts).map(([label, count]) => `${label}: ${count}`)].join("\n");
	}
	const summary = {
		Bus: 0,
		Tram: 0,
		UBahn: 0,
		cancelledToday: Number(meta.cancelledToday || 0),
	};

	Object.entries(trips).forEach(([key, trip]) => {
		if (key === "__meta") return;
		const product = normalizeProduct(trip?.Produkt ?? trip?.Fahrt?.Produkt);
		if (product === "Bus") summary.Bus += 1;
		if (product === "Tram") summary.Tram += 1;
		if (product === "UBahn") summary.UBahn += 1;
	});

	return [
		`Bus: ${summary.Bus}`,
		`Tram: ${summary.Tram}`,
		`U-Bahn: ${summary.UBahn}`,
		`Heute Ausgefallen: ${summary.cancelledToday}`,
	].join("\n");
};

const getLiveTrips = (data) => {
	const trips = data?.trips || data || {};
	return Object.entries(trips)
		.filter(([key, trip]) => key !== "__meta" && hasMapPosition(trip))
		.map(([, trip]) => trip);
};

const hasMapPosition = (trip) => trip && trip.Latitude !== null && trip.Longitude !== null
	&& trip.Latitude !== "" && trip.Longitude !== ""
	&& Number.isFinite(Number(trip.Latitude)) && Number.isFinite(Number(trip.Longitude));

const classifyFuelType = (trip) => {
	const product = normalizeProduct(trip?.Produkt ?? trip?.Fahrt?.Produkt);
	if (product === "UBahn" || product === "Tram") return "electro";
	if (product !== "Bus") return "unknown";

	const fuelType = String(getInfoValue(trip?.FahrzeugInfo, ["Kraftstoffart"]) || "").toLowerCase();
	if (!fuelType) return "unknown";
	if (fuelType.includes("elektro") || fuelType.includes("electric")) return "electro";
	if (fuelType.includes("diesel")) return "diesel";
	if (fuelType.includes("gas") || fuelType.includes("cng")) return "gas";

	return "unknown";
};

const buildLiveStats = (data) => {
	const trips = getLiveTrips(data);
	const stats = {
		total: trips.length,
		ac: {
			yes: 0,
			no: 0,
		},
		engine: {
			unknown: 0,
			gas: 0,
			diesel: 0,
			electro: 0,
		},
	};

	trips.forEach((trip) => {
		const hasAc = Boolean(getInfoValue(trip?.FahrzeugInfo, ["Klimatisierung"]));
		stats.ac[hasAc ? "yes" : "no"] += 1;
		stats.engine[classifyFuelType(trip)] += 1;
	});

	return stats;
};

const renderStatLine = (rows, total) => `
	<div class="lm-stat-line" aria-label="${escapeHTML(rows.map(({ label, value }) => `${label}: ${value}`).join(", "))}">
		${rows.map(({ label, value, color, textColor }) => {
	const percent = total > 0 ? (value / total) * 100 : 0;
	return `<span title="${escapeHTML(label)}: ${value}" style="width: ${percent}%; background: ${color}; color: ${textColor || "#fff"}">${value}</span>`;
}).join("")}
	</div>
`;

const renderStatSummaryLine = (rows) => `
	<div class="lm-stat-summary">
		${rows.map(({ label, value, color, textColor }) => `<span style="--stat-color: ${color}; color: ${textColor || color}">${escapeHTML(label)} <strong>${value}</strong></span>`).join("<b>|</b>")}
	</div>
`;

const renderStatsModalContent = (stats) => `
	<div class="lm-stat-grid">
		<section class="lm-stat-section">
			<h3>AC</h3>
			${renderStatSummaryLine([
		{ label: "AC", value: stats.ac.yes, color: "#005ca9" },
		{ label: "No AC", value: stats.ac.no, color: "#e3000b" },
	])}
			${renderStatLine([
		{ label: "AC", value: stats.ac.yes, color: "#005ca9" },
		{ label: "No AC", value: stats.ac.no, color: "#e3000b" },
	], stats.total)}
		</section>
		<section class="lm-stat-section">
			<h3>Antrieb</h3>
			${renderStatSummaryLine([
		{ label: "Unknown", value: stats.engine.unknown, color: "#fff", textColor: "#0f172a" },
		{ label: "Gas", value: stats.engine.gas, color: "#facc15", textColor: "#a16207" },
		{ label: "Diesel", value: stats.engine.diesel, color: "#e3000b" },
		{ label: "Electro", value: stats.engine.electro, color: "#16a34a" },
	])}
			${renderStatLine([
		{ label: "Unknown", value: stats.engine.unknown, color: "#fff", textColor: "#0f172a" },
		{ label: "Gas", value: stats.engine.gas, color: "#facc15", textColor: "#0f172a" },
		{ label: "Diesel", value: stats.engine.diesel, color: "#e3000b" },
		{ label: "Electro", value: stats.engine.electro, color: "#16a34a" },
	], stats.total)}
		</section>
	</div>
`;

let latestLiveMapData = {};

const map = new ol.Map({
	target: "map",
	layers: [
		new ol.layer.Tile({
			source: new ol.source.OSM(),
		}),
	],
	view: new ol.View({
		center: ol.proj.fromLonLat([11.0787063802325, 49.4633775635804]),
		zoom: 13,
	}),
});

const vectorSource = new ol.source.Vector({
	features: [],
});
const vehicleFeatures = new Map();

const renderLiveMap = (data) => {
	latestLiveMapData = data || {};
	const trips = data?.trips || data || {};
	const visibleKeys = new Set();
	const added = [];
	let clusterDetached = false;
	let styleChanged = false;
	const beginSpatialChange = () => {
		if (!clusterDetached) { clusterSource.setSource(null); clusterDetached = true; }
	};
	Object.keys(trips).forEach((key) => {
		if (key === "__meta") return;
		const item = trips[key];
		if (!hasMapPosition(item)) return;
		const color = propertiesToColor(item);

		visibleKeys.add(key);
		const fingerprint = JSON.stringify(item);
		const existing = vehicleFeatures.get(key);
		if (existing?.fingerprint === fingerprint) return;
		const coordinates = ol.proj.fromLonLat([Number(item.Longitude), Number(item.Latitude)]);
		if (existing) {
			styleChanged ||= existing.feature.get("color") !== color || existing.feature.get("Linienname") !== item.Linienname;
			existing.feature.setProperties({ ...item, color }, true);
			const previous = existing.feature.getGeometry().getCoordinates();
			if (previous[0] !== coordinates[0] || previous[1] !== coordinates[1]) {
				beginSpatialChange();
				existing.feature.getGeometry().setCoordinates(coordinates);
			}
			existing.fingerprint = fingerprint;
		} else {
			const feature = new ol.Feature({ geometry: new ol.geom.Point(coordinates), ...item, color });
			feature.setId(key);
			vehicleFeatures.set(key, { feature, fingerprint });
			added.push(feature);
		}
	});
	for (const [key, { feature }] of vehicleFeatures) {
		if (!visibleKeys.has(key)) { beginSpatialChange(); vectorSource.removeFeature(feature); vehicleFeatures.delete(key); }
	}
	if (added.length) { beginSpatialChange(); vectorSource.addFeatures(added); }
	if (clusterDetached) clusterSource.setSource(vectorSource);
	else if (styleChanged) clusterLayer.changed();
	refreshActivePopup();

	const count = vectorSource.getFeatures().length;
	setStatus(`${count} Fahrzeuge im Ausschnitt${liveMapSource === "gps" ? " (GPS)" : ""}`, "live", formatLiveStatusTooltip(data));
};

const refreshLiveMap = async (version = connectionVersion) => {
	if (version !== connectionVersion || mapMoving || activeFetchController) return;
	const controller = new AbortController();
	activeFetchController = controller;
	try {
		const response = await fetch(`/api/v1/live/map${liveQueryString()}`, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		if (version === connectionVersion && !mapMoving) renderLiveMap(data);
	} catch (error) {
		if (version === connectionVersion && error.name !== "AbortError") setStatus("HTTP Fallback gestört", "error");
	} finally {
		if (activeFetchController === controller) activeFetchController = null;
	}
};

const clusterSource = new ol.source.Cluster({
	distance: window.innerWidth < 640 ? 28 : 10,
	source: vectorSource,
});

const clusterStyles = new Map();
const clusterLayer = new ol.layer.Vector({
	source: clusterSource,
	style: function (feature) {
		const features = feature.get("features");
		if (!features.length) return null;
		let color = features[0].get("color");
		const allSameColor = features.every((f) => f.get("color") === color);
		const size = features.length;

		if (!allSameColor) color = "#111827";

		const label = size === 1 ? `${features[0].get("Linienname") || ""}` : size.toString();
		const cacheKey = `${color}:${size}:${label}`;
		if (clusterStyles.has(cacheKey)) return clusterStyles.get(cacheKey);
		const style = new ol.style.Style({
			image: new ol.style.Circle({
				fill: new ol.style.Fill({ color }),
				stroke: new ol.style.Stroke({ color: "#fff", width: 2 }),
				radius: size === 1 ? 12 : 14,
			}),
			text: new ol.style.Text({
				text: label,
				fill: new ol.style.Fill({ color: "#fff" }),
				stroke: new ol.style.Stroke({ color: "#111827", width: 2 }),
				font: "bold 11px system-ui, sans-serif",
			}),
		});
		if (clusterStyles.size >= 2000) clusterStyles.clear();
		clusterStyles.set(cacheKey, style);
		return style;
	},
});

const popup = document.getElementById("popup");
const popupContent = document.getElementById("popup-content");
const closePopupButton = document.getElementById("popup-close");
let popupOverlayContainer = null;
let activePopupCoordinate = null;
let activePopupKeys = [];
let popupFingerprint = null;
let activePopupPage = 0;

const overlay = new ol.Overlay({
	element: popup,
	positioning: "bottom-center",
	stopEvent: true,
	offset: [0, -18],
});

map.addLayer(clusterLayer);
map.addOverlay(overlay);
popupOverlayContainer = popup.parentElement;

const isMobilePopup = () => window.matchMedia("(max-width: 640px)").matches;

const syncPopupHost = () => {
	if (!popup) return;

	if (isMobilePopup()) {
		if (popup.parentElement !== document.body) document.body.appendChild(popup);
		return;
	}

	if (popupOverlayContainer && popup.parentElement !== popupOverlayContainer) {
		popupOverlayContainer.appendChild(popup);
	}
};

const showPopup = (coordinate) => {
	activePopupCoordinate = coordinate;
	syncPopupHost();

	if (isMobilePopup()) {
		overlay.setPosition(undefined);
	} else {
		overlay.setPosition(coordinate);
	}

	popup.style.display = "block";
};

const hidePopup = () => {
	activePopupCoordinate = null;
	activePopupKeys = [];
	popupFingerprint = null;
	activePopupPage = 0;
	popup.style.display = "none";
};
const refreshActivePopup = () => {
	if (!activePopupKeys.length || popup.style.display !== "block") return;
	const selected = activePopupKeys.map((key) => vehicleFeatures.get(key)).filter(Boolean);
	if (!selected.length) return hidePopup();
	const fingerprint = selected.map((entry) => entry.fingerprint).join("|");
	if (fingerprint === popupFingerprint) return;
	popupFingerprint = fingerprint;
	activePopupPage = Math.min(activePopupPage, Math.floor((selected.length - 1) / 20));
	const page = selected.slice(activePopupPage * 20, (activePopupPage + 1) * 20);
	const pagination = selected.length > 20 ? `<p class="lm-muted">${activePopupPage * 20 + 1}–${Math.min((activePopupPage + 1) * 20, selected.length)} von ${selected.length} Fahrzeugen</p>
		<button type="button" class="lm-link" data-popup-page="${activePopupPage - 1}" ${activePopupPage === 0 ? "disabled" : ""}>Zurück</button>
		<button type="button" class="lm-link" data-popup-page="${activePopupPage + 1}" ${(activePopupPage + 1) * 20 >= selected.length ? "disabled" : ""}>Weiter</button>` : "";
	popupContent.innerHTML = `${selected.length > 1 ? `<h2>${selected.length} Fahrzeuge</h2>` : ""}${pagination}`
		+ page.map(({ feature }) => renderVehicleCard(feature.getProperties(), selected.length > 1)).join("<div class='lm-split'></div>");
	showPopup(selected[0].feature.getGeometry().getCoordinates());
};

map.on("singleclick", function (event) {
	let foundFeature = false;

	map.forEachFeatureAtPixel(event.pixel, function (feature) {
		foundFeature = true;
		const clusterPoints = feature.get("features");
		activePopupKeys = clusterPoints.map((point) => point.getId());
		popupFingerprint = null;
		activePopupPage = 0;
		showPopup(clusterPoints[0].getGeometry().getCoordinates());
		refreshActivePopup();
	});

	if (!foundFeature) hidePopup();
});
popupContent.addEventListener("click", (event) => {
	const button = event.target.closest("[data-popup-page]");
	if (!button || button.disabled) return;
	activePopupPage = Math.max(0, Number(button.dataset.popupPage));
	popupFingerprint = null;
	refreshActivePopup();
});

map.on("movestart", function () {
	mapMoving = true;
	clearTimeout(viewportTimer);
	++connectionVersion;
	activeFetchController?.abort();
	activeFetchController = null;
	if (!isMobilePopup()) hidePopup();
});
map.on("moveend", () => {
	mapMoving = false;
	clearTimeout(viewportTimer);
	viewportTimer = setTimeout(updateLiveMapSubscription, 200);
});

closePopupButton?.addEventListener("click", () => {
	hidePopup();
});

window.addEventListener("resize", () => {
	if (activePopupCoordinate && popup.style.display === "block") showPopup(activePopupCoordinate);
	else syncPopupHost();
});

document.getElementById("locateButton")?.addEventListener("click", () => {
	const features = vectorSource.getFeatures();
	if (features.length === 0) return;
	const extent = vectorSource.getExtent();
	map.getView().fit(extent, { padding: [80, 40, 80, 40], maxZoom: 15, duration: 250 });
});

const statsModal = document.getElementById("statsModal");
const statsModalContent = document.getElementById("statsModalContent");
const statsModalSubtitle = document.getElementById("statsModalSubtitle");

const openStatsModal = () => {
	if (!statsModal || !statsModalContent) return;
	if (liveMapSource === "gps") {
		const trips = getLiveTrips(latestLiveMapData);
		const counts = {};
		trips.forEach((trip) => {
			const label = productLabelMap[trip.Produkt] || trip.Produkt || "Unbekannt";
			counts[label] = (counts[label] || 0) + 1;
		});
		statsModalContent.innerHTML = `<section class="lm-stat-section"><h3>GPS-Positionen</h3><dl class="lm-specs">${Object.entries(counts)
			.map(([label, count]) => `<div><dt>${escapeHTML(label)}</dt><dd>${count}</dd></div>`).join("")}</dl></section>`;
		if (statsModalSubtitle) statsModalSubtitle.textContent = `${trips.length} Fahrzeuge mit GPS-Position`;
		statsModal.hidden = false;
		return;
	}
	const stats = buildLiveStats(latestLiveMapData);
	statsModalContent.innerHTML = renderStatsModalContent(stats);
	if (statsModalSubtitle) statsModalSubtitle.textContent = `${stats.total} Fahrzeuge live`;
	statsModal.hidden = false;
};

const closeStatsModal = () => {
	if (statsModal) statsModal.hidden = true;
};

document.getElementById("statsButton")?.addEventListener("click", openStatsModal);
document.getElementById("statsModalClose")?.addEventListener("click", closeStatsModal);
document.querySelectorAll("[data-stats-close]").forEach((element) => element.addEventListener("click", closeStatsModal));
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && statsModal && !statsModal.hidden) closeStatsModal();
});

const startHttpFallback = (version) => {
	if (version !== connectionVersion || fallbackInterval) return;
	setStatus("HTTP Fallback", "fallback");
	void refreshLiveMap(version);
	fallbackInterval = setInterval(() => { void refreshLiveMap(version); }, liveMapSource === "gps" ? 5000 : 1000);
};

const sendLiveMapSubscription = () => {
	if (liveSocket?.readyState !== WebSocket.OPEN) return;
	liveSocket.send(JSON.stringify({
		type: "subscribe",
		...Object.fromEntries(new URLSearchParams(liveQueryString())),
		source: liveMapSource,
		requestId: connectionVersion,
	}));
};

const updateLiveMapSubscription = () => {
	const version = ++connectionVersion;
	if (fallbackInterval) clearInterval(fallbackInterval);
	fallbackInterval = null;
	activeFetchController?.abort();
	activeFetchController = null;
	if (liveSocket && liveSocket.readyState <= WebSocket.OPEN) {
		// While connecting, the open handler sends the latest viewport.
		sendLiveMapSubscription();
	} else startHttpFallback(version);
};

const connectLiveMap = () => {
	const version = ++connectionVersion;
	if (fallbackInterval) clearInterval(fallbackInterval);
	fallbackInterval = null;
	activeFetchController?.abort();
	activeFetchController = null;
	liveSocket?.close();
	liveSocket = null;
	setStatus(liveMapSource === "gps" ? "GPS-Positionen laden..." : "Verbinde...", "idle");
	if (!("WebSocket" in window)) return startHttpFallback(version);

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/live/map/ws${liveQueryString()}`);
	liveSocket = socket;

	socket.addEventListener("open", () => {
		if (socket !== liveSocket) return;
		setStatus("WebSocket verbunden", "live");
		sendLiveMapSubscription();
	});
	socket.addEventListener("message", (event) => {
		if (socket !== liveSocket || mapMoving) return;
		try {
			const payload = JSON.parse(event.data);
			if (payload.requestId !== connectionVersion) return;
			if (payload.type === "snapshot") renderLiveMap(payload.data);
			if (payload.type === "error") setStatus(payload.message, "error");
		} catch { setStatus("Ungültige Live-Daten", "error"); }
	});
	socket.addEventListener("close", () => {
		if (socket !== liveSocket) return;
		liveSocket = null;
		setStatus("WebSocket getrennt", "fallback");
		startHttpFallback(connectionVersion);
	});
	socket.addEventListener("error", () => { if (socket === liveSocket) setStatus("WebSocket Fehler", "error"); });

	return socket;
};

const gpsModeSwitch = document.getElementById("gpsModeSwitch");
if (gpsModeSwitch) {
	gpsModeSwitch.checked = liveMapSource === "gps";
	gpsModeSwitch.addEventListener("change", () => {
		liveMapSource = gpsModeSwitch.checked ? "gps" : "puls";
		const url = new URL(window.location.href);
		if (liveMapSource === "gps") url.searchParams.set("source", "gps");
		else url.searchParams.delete("source");
		window.history.replaceState(null, "", url);
		hidePopup();
		closeStatsModal();
		latestLiveMapData = {};
		vectorSource.clear();
		vehicleFeatures.clear();
		updateLiveMapSubscription();
	});
}

const initialParameters = new URLSearchParams(window.location.search);
const initialBounds = [initialParameters.get("pos1"), initialParameters.get("pos2")].map((value) => value?.split(",").map(Number));
if (initialBounds.every((point) => point?.length === 2 && point.every(Number.isFinite)
	&& Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85.05112878)
	&& initialBounds[0][0] !== initialBounds[1][0] && initialBounds[0][1] !== initialBounds[1][1]) {
	const [first, second] = initialBounds;
	map.getView().fit(ol.proj.transformExtent([Math.min(first[0], second[0]), Math.min(first[1], second[1]),
		Math.max(first[0], second[0]), Math.max(first[1], second[1])], "EPSG:4326", "EPSG:3857"), { duration: 0 });
}
connectLiveMap();
setInterval(updatePositionAges, 1000);
