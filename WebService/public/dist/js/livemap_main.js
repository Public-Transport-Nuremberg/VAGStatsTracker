const productLabelMap = {
	UBahn: "U-Bahn",
	Tram: "Tram",
	Bus: "Bus",
};

const productIconMap = {
	UBahn: "U",
	Tram: "T",
	Bus: "B",
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
	const timing = calculateTiming(p);
	const color = propertiesToColor(p);
	const vehicleInfoHtml = getVehicleInfo(p.Fahrzeugnummer, p.FahrzeugInfo);
	const vehicleHistory = `<a class="lm-link" href="/vehicleHistory/${escapeHTML(p.Betriebstag)}/${escapeHTML(p.Fahrzeugnummer)}" target="_blank" rel="noopener noreferrer">Fahrzeughistorie</a>`;

	return `
		<article class="lm-content">
			<header class="lm-vehicle-head">
				<span class="lm-route" style="background:${color}">${escapeHTML(productIconMap[p.Produkt] || "?")}${escapeHTML(p.Linienname || "")}</span>
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

const setStatus = (label, state = "idle") => {
	const status = document.getElementById("liveStatus");
	if (!status) return;
	status.textContent = label;
	status.dataset.state = state;
};

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

const renderLiveMap = (data) => {
	vectorSource.clear();

	Object.keys(data).forEach((key) => {
		const item = data[key];
		if (!Number.isFinite(Number(item.Longitude)) || !Number.isFinite(Number(item.Latitude))) return;
		const color = propertiesToColor(item);

		const marker = new ol.Feature({
			geometry: new ol.geom.Point(ol.proj.fromLonLat([Number(item.Longitude), Number(item.Latitude)])),
			...item,
			color,
		});

		vectorSource.addFeature(marker);
	});

	setStatus(`${vectorSource.getFeatures().length} Fahrzeuge live`, "live");
};

const refreshLiveMap = () => {
	const queryString = window.location.search;

	fetch(`/api/v1/live/map${queryString}`)
		.then((response) => response.json())
		.then(renderLiveMap)
		.catch(() => setStatus("HTTP Fallback gestoert", "error"));
};

const clusterSource = new ol.source.Cluster({
	distance: window.innerWidth < 640 ? 28 : 10,
	source: vectorSource,
});

const clusterLayer = new ol.layer.Vector({
	source: clusterSource,
	style: function (feature) {
		const features = feature.get("features");
		let color = features[0].get("color");
		const allSameColor = features.every((f) => f.get("color") === color);
		const size = features.length;

		if (size === 0) return new ol.style.Style({});
		if (!allSameColor) color = "#111827";

		const label = size === 1 ? `${features[0].get("Linienname") || ""}` : size.toString();

		return new ol.style.Style({
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
	},
});

const popup = document.getElementById("popup");
const popupContent = document.getElementById("popup-content");
const closePopupButton = document.getElementById("popup-close");

const overlay = new ol.Overlay({
	element: popup,
	positioning: "bottom-center",
	stopEvent: true,
	offset: [0, -18],
});

map.addLayer(clusterLayer);
map.addOverlay(overlay);

map.on("singleclick", function (event) {
	let foundFeature = false;

	map.forEachFeatureAtPixel(event.pixel, function (feature) {
		foundFeature = true;
		const clusterPoints = feature.get("features");

		if (clusterPoints.length > 1) {
			const properties = clusterPoints.map((clusterFeature) => clusterFeature.getProperties());

			popupContent.innerHTML = `
				<div class="lm-cluster">
					<h2>${properties.length} Fahrzeuge</h2>
					${properties.map((p) => renderVehicleCard(p, true)).join("<div class='lm-split'></div>")}
				</div>
			`;

			overlay.setPosition(clusterPoints[0].getGeometry().getCoordinates());
			popup.style.display = "block";
		} else {
			const p = clusterPoints[0].getProperties();
			popupContent.innerHTML = renderVehicleCard(p);
			overlay.setPosition(clusterPoints[0].getGeometry().getCoordinates());
			popup.style.display = "block";
		}
	});

	if (!foundFeature) popup.style.display = "none";
});

map.on("movestart", function () {
	popup.style.display = "none";
});

closePopupButton?.addEventListener("click", () => {
	popup.style.display = "none";
});

document.getElementById("locateButton")?.addEventListener("click", () => {
	const features = vectorSource.getFeatures();
	if (features.length === 0) return;
	const extent = vectorSource.getExtent();
	map.getView().fit(extent, { padding: [80, 40, 80, 40], maxZoom: 15, duration: 250 });
});

const startHttpFallback = () => {
	setStatus("HTTP Fallback", "fallback");
	refreshLiveMap();
	return setInterval(refreshLiveMap, 1000);
};

const connectLiveMap = () => {
	if (!("WebSocket" in window)) return startHttpFallback();

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/live/map/ws${window.location.search}`);
	let fallbackInterval = null;

	socket.addEventListener("open", () => setStatus("WebSocket verbunden", "live"));
	socket.addEventListener("message", (event) => {
		const payload = JSON.parse(event.data);
		if (payload.type === "snapshot") renderLiveMap(payload.data);
		if (payload.type === "error") setStatus(payload.message, "error");
	});
	socket.addEventListener("close", () => {
		setStatus("WebSocket getrennt", "fallback");
		if (!fallbackInterval) fallbackInterval = startHttpFallback();
	});
	socket.addEventListener("error", () => setStatus("WebSocket Fehler", "error"));

	return socket;
};

connectLiveMap();
