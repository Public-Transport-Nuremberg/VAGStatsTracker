const state = {
	selectedStation: null,
	lastSuggestions: [],
	refreshTimer: null,
	departures: [],
	seenDepartureKeys: new Set(),
	isLoading: false,
	isLoadingMore: false,
	hasMore: true,
	expandedTrips: new Map(),
};

const PAGE_SIZE = 30;

const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
}[char]));

const elements = {
	search: document.getElementById("stationSearch"),
	results: document.getElementById("stationResults"),
	product: document.getElementById("productFilter"),
	gps: document.getElementById("gpsButton"),
	refresh: document.getElementById("refreshButton"),
	title: document.getElementById("boardTitle"),
	meta: document.getElementById("boardMeta"),
	status: document.getElementById("boardStatus"),
	body: document.getElementById("departuresBody"),
	stationName: document.getElementById("stationName"),
	stationVgn: document.getElementById("stationVgn"),
	stationVag: document.getElementById("stationVag"),
	stationProducts: document.getElementById("stationProducts"),
	stationDistance: document.getElementById("stationDistance"),
};

const setStatus = (label, mode = "idle") => {
	elements.status.textContent = label;
	elements.status.className = "inline-flex h-8 items-center rounded-md border px-3 text-xs font-semibold";

	if (mode === "loading") elements.status.classList.add("border-blue-200", "bg-blue-50", "text-vag-blue");
	else if (mode === "error") elements.status.classList.add("border-red-200", "bg-red-50", "text-vag-red");
	else if (mode === "live") elements.status.classList.add("border-green-200", "bg-green-50", "text-vag-green");
	else elements.status.classList.add("border-slate-200", "bg-slate-100", "text-slate-600");
};

const debounce = (fn, wait) => {
	let timeout = null;
	return (...args) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => fn(...args), wait);
	};
};

const lineColor = (departure) => {
	if (departure.Produkt === "UBahn") {
		if (departure.Linienname === "U1") return "#005CA9";
		if (departure.Linienname === "U2") return "#E3000B";
		return "#008A4B";
	}
	if (departure.Produkt === "Tram") return "#7C3AED";
	if (departure.Produkt === "Bus") return "#E3000B";
	return "#111827";
};

const formatTime = (value) => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatDelay = (departure) => {
	const actual = new Date(departure.AbfahrtszeitIst);
	const planned = new Date(departure.AbfahrtszeitSoll);
	if (Number.isNaN(actual.getTime()) || Number.isNaN(planned.getTime())) return "";
	const minutes = Math.round((actual - planned) / 60000);
	if (minutes === 0) return '<span class="text-slate-500">+0</span>';
	const color = minutes > 0 ? "text-vag-red" : "text-vag-green";
	return `<span class="${color} font-semibold">${minutes > 0 ? "+" : ""}${minutes}</span>`;
};

const formatPlatform = (value, fallback = "-") => {
	const platform = String(value ?? "").trim();
	if (!platform) return fallback;
	if (platform.includes(":")) return platform.split(":").pop() || fallback;
	return platform;
};

const formatDistance = (meters) => {
	const value = Number(meters);
	if (!Number.isFinite(value)) return "-";
	if (value >= 1000) return `${(value / 1000).toFixed(1)} km`;
	return `${Math.round(value)} m`;
};

const badge = (label, title, tone = "slate") => {
	const tones = {
		blue: "border-blue-200 bg-blue-50 text-vag-blue",
		green: "border-green-200 bg-green-50 text-vag-green",
		red: "border-red-200 bg-red-50 text-vag-red",
		slate: "border-slate-200 bg-slate-100 text-slate-700",
	};
	return `<span class="inline-flex h-6 min-w-6 items-center justify-center rounded-md border px-1.5 text-xs font-semibold ${tones[tone] || tones.slate}" title="${escapeHTML(title || label)}">${label}</span>`;
};

const featureEmojis = {
	Klimatisierung: "❄️",
	Rollstuhlplaetze: "♿",
	Gas: "⛽",
	Diesel: "⛽️",
	CNG: "🍃",
	Elektro: "🔋",
};

const featureBadges = (departure) => {
	const features = departure.FeatureData || {};
	const badges = [];

	if (features.airConditioning) badges.push(badge(featureEmojis.Klimatisierung, `Klimatisierung: ${features.airConditioning}`, features.airConditioning === "ohne" ? "slate" : "blue"));
	if (features.fuelType && featureEmojis[features.fuelType]) badges.push(badge(featureEmojis[features.fuelType], `Kraftstoffart: ${features.fuelType}`, features.fuelType === "Elektro" || features.fuelType === "CNG" ? "green" : "slate"));
	if (features.wheelchairSpaces !== null && features.wheelchairSpaces !== undefined) badges.push(badge(featureEmojis.Rollstuhlplaetze, `${features.wheelchairSpaces} Rollstuhlplätze`, Number(features.wheelchairSpaces) > 0 ? "green" : "red"));
	if (features.accessibleDoors) badges.push(badge("↕", `${features.accessibleDoors} Türen mit Aufstellfläche`, "green"));
	if (features.vehicleInfo === "Langzug" || features.vehicleInfo === "Kurzzug") badges.push(badge(escapeHTML(features.vehicleInfo), "Zuglänge", "slate"));
	if (!badges.length && features.vehicleInfo) badges.push(badge("i", features.vehicleInfo));

	return badges.join("");
};

const getDepartureKey = (departure) => [
	departure.Fahrtnummer,
	departure.Linienname,
	departure.Richtungstext || departure.Richtung,
	departure.Haltepunkt,
	departure.AbfahrtszeitSoll,
].map((value) => value ?? "").join("|");

const getDepartureTime = (departure) => {
	const date = new Date(departure.AbfahrtszeitIst || departure.AbfahrtszeitSoll);
	return Number.isNaN(date.getTime()) ? null : date;
};

const getNextTimeDelay = () => {
	const lastDeparture = state.departures[state.departures.length - 1];
	const lastDepartureTime = lastDeparture ? getDepartureTime(lastDeparture) : null;
	if (!lastDepartureTime) return null;

	const minutesFromNow = Math.ceil((lastDepartureTime.getTime() - Date.now()) / 60000);
	return Math.max(0, Math.min(1440, minutesFromNow + 1));
};

const tripTimeHTML = (label, value, delay) => {
	if (!value) return "";
	return `<span class="text-xs text-slate-500">${label} ${formatTime(value)} ${Number.isFinite(Number(delay)) ? formatSecondsToMinutes(delay) : ""}</span>`;
};

const formatSecondsToMinutes = (seconds) => {
	const minutes = Math.round(Number(seconds) / 60);
	if (!Number.isFinite(minutes)) return "";
	if (minutes === 0) return '<span class="text-slate-400">+0</span>';
	return `<span class="${minutes > 0 ? "text-vag-red" : "text-vag-green"} font-semibold">${minutes > 0 ? "+" : ""}${minutes}</span>`;
};

const renderTripDetails = (departure) => {
	const key = getDepartureKey(departure);
	const tripState = state.expandedTrips.get(key);
	if (!tripState) return "";

	if (tripState.loading) {
		return '<div class="px-4 py-4 text-sm text-slate-500">Fahrt wird geladen...</div>';
	}

	if (tripState.error) {
		return `<div class="px-4 py-4 text-sm text-vag-red">${escapeHTML(tripState.error)}</div>`;
	}

	const fahrt = tripState.data?.Fahrt || {};
	const stops = fahrt.Fahrtverlauf || [];
	return `
		<div class="bg-slate-50 px-4 py-4">
			<div class="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
				<h3 class="text-sm font-semibold text-slate-950">Fahrt ${escapeHTML(fahrt.Fahrtnummer || departure.Fahrtnummer)} nach ${escapeHTML(fahrt.Richtungstext || departure.Richtungstext || "-")}</h3>
				<span class="text-xs text-slate-500">${escapeHTML(stops.length)} Halte</span>
			</div>
			<ol class="divide-y divide-slate-200 overflow-hidden rounded-md border border-slate-200 bg-white">
				${stops.map((stop) => `
					<li class="grid grid-cols-[3.6rem_minmax(0,1fr)_2.25rem] items-center gap-2 px-3 py-2 text-xs sm:grid-cols-[4.5rem_minmax(0,1fr)_3rem_5rem]">
						<div class="font-mono font-semibold text-slate-700">${formatTime(stop.AbfahrtszeitIst || stop.AbfahrtszeitSoll || stop.AnkunftszeitIst || stop.AnkunftszeitSoll)}</div>
						<div class="truncate font-medium text-slate-950">${escapeHTML(stop.Haltestellenname || "-")}</div>
						<div class="text-right text-slate-700">${escapeHTML(formatPlatform(stop.HaltesteigText || stop.Haltepunkt))}</div>
						<div class="hidden text-right text-slate-500 sm:block">
							${Number.isFinite(Number(stop.Verspätung)) ? formatSecondsToMinutes(stop.Verspätung) : ""}
						</div>
					</li>
				`).join("")}
			</ol>
		</div>
	`;
};

const departureRowsHTML = (departures) => departures.map((departure) => {
	const key = getDepartureKey(departure);
	const isOpen = state.expandedTrips.has(key);

	return `
	<tr class="grid cursor-pointer grid-cols-[3.8rem_3.2rem_minmax(0,1fr)_1.8rem_3.8rem] items-center gap-2 border-b border-slate-100 px-2 py-2 align-top hover:bg-slate-50 sm:table-row sm:p-0" data-trip-row="${escapeHTML(key)}" role="button" tabindex="0" aria-expanded="${isOpen}">
		<td class="sm:table-cell sm:whitespace-nowrap sm:px-4 sm:py-3">
			<span class="block text-sm font-semibold leading-tight text-slate-950 sm:text-base">${formatTime(departure.AbfahrtszeitIst || departure.AbfahrtszeitSoll)}</span>
			<span class="block text-[11px] leading-tight text-slate-500">${formatDelay(departure)}</span>
		</td>
		<td class="sm:table-cell sm:px-4 sm:py-3">
			<span class="inline-flex min-w-10 items-center justify-center rounded-md px-1.5 py-1 text-xs font-bold text-white sm:text-sm" style="background:${lineColor(departure)}">${escapeHTML(departure.Linienname || "-")}</span>
		</td>
		<td class="min-w-0 sm:table-cell sm:px-4 sm:py-3">
			<span class="block truncate text-sm font-medium text-slate-950">${escapeHTML(departure.Richtungstext || departure.Richtung || "-")}</span>
			<span class="block truncate font-mono text-[11px] text-vag-blue">Fahrt ${escapeHTML(departure.Fahrtnummer || "-")}</span>
		</td>
		<td class="text-right text-sm font-semibold text-slate-700 sm:table-cell sm:whitespace-nowrap sm:px-4 sm:py-3 sm:text-left sm:font-normal">
			${escapeHTML(formatPlatform(departure.HaltesteigText || departure.Haltepunkt))}
		</td>
		<td class="min-w-0 sm:table-cell sm:px-4 sm:py-3">
			<span class="block truncate text-right font-mono text-[11px] text-slate-600 sm:text-left">${escapeHTML(departure.Fahrzeugnummer || "-")}</span>
			<span class="mt-1 flex justify-end gap-1 sm:justify-start">${featureBadges(departure) || '<span class="text-xs text-slate-400">-</span>'}</span>
		</td>
	</tr>
	<tr class="${isOpen ? "table-row" : "hidden"}">
		<td colspan="5" class="p-0">${renderTripDetails(departure)}</td>
	</tr>
`;
}).join("");

const renderDepartures = (departures) => {
	if (!departures.length) {
		elements.body.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500">Keine Abfahrten gefunden</td></tr>';
		return;
	}

	elements.body.innerHTML = departureRowsHTML(departures);
};

const renderStation = (station = {}) => {
	elements.stationName.textContent = station.Haltestellenname || "-";
	elements.stationVgn.textContent = station.VGNKennung || "-";
	elements.stationVag.textContent = station.VAGKennung || "-";
	elements.stationProducts.textContent = station.Produkte || "-";
	elements.stationDistance.textContent = formatDistance(station.distanz ?? station.Distance);
};

const updateUrl = (station) => {
	if (!station?.VGNKennung) return;
	const params = new URLSearchParams(window.location.search);
	params.set("VGNKennung", station.VGNKennung);
	window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
};

const requestParams = ({ timeDelay } = {}) => {
	const params = new URLSearchParams();
	const product = elements.product.value;
	if (product) params.set("Product", product);
	params.set("LimitCount", String(PAGE_SIZE));
	if (timeDelay !== undefined && timeDelay !== null) params.set("TimeDelay", String(timeDelay));
	return params;
};

const loadStationDepartures = async (station, keepUrl = true) => {
	if (!station?.VGNKennung) return;
	state.selectedStation = station;
	elements.search.value = station.Haltestellenname || "";
	elements.title.textContent = station.Haltestellenname || "Abfahrten";
	elements.meta.textContent = "Lade Abfahrten...";
	renderStation(station);
	if (keepUrl) updateUrl(station);

	const params = requestParams();
	params.set("VGNKennung", station.VGNKennung);
	await loadDepartures(`/api/v1/departures/station?${params.toString()}`, { append: false });
};

const mergeDepartures = (departures, append) => {
	if (!append) {
		state.departures = [];
		state.seenDepartureKeys.clear();
	}

	const newDepartures = [];
	departures.forEach((departure) => {
		const key = getDepartureKey(departure);
		if (state.seenDepartureKeys.has(key)) return;
		state.seenDepartureKeys.add(key);
		newDepartures.push(departure);
	});

	state.departures = append ? state.departures.concat(newDepartures) : newDepartures;
	state.departures.sort((a, b) => {
		const aTime = getDepartureTime(a)?.getTime() || 0;
		const bTime = getDepartureTime(b)?.getTime() || 0;
		return aTime - bTime;
	});

	return newDepartures;
};

const loadDepartures = async (url, { append = false } = {}) => {
	if (append && (state.isLoadingMore || state.isLoading || !state.hasMore)) return;
	if (!append && state.isLoading) return;

	state.isLoading = !append;
	state.isLoadingMore = append;
	setStatus(append ? "Mehr laden" : "Laden", "loading");
	try {
		const response = await fetch(url);
		const data = await response.json();
		if (!response.ok) throw new Error(data.info || data.message || "Request failed");

		const station = data.Station || state.selectedStation || {};
		state.selectedStation = station;
		const rawDepartures = data.Departures || [];
		const newDepartures = mergeDepartures(rawDepartures, append);
		state.hasMore = rawDepartures.length >= PAGE_SIZE && newDepartures.length > 0;
		elements.title.textContent = data.Stop || station.Haltestellenname || "Abfahrten";
		elements.meta.textContent = `${state.departures.length} Abfahrten, aktualisiert ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
		renderStation(station);
		renderDepartures(state.departures);
		setStatus("Live", "live");
	} catch (error) {
		elements.meta.textContent = error.message;
		setStatus("Fehler", "error");
	} finally {
		state.isLoading = false;
		state.isLoadingMore = false;
	}
};

const loadMoreDepartures = async () => {
	if (!state.selectedStation?.VGNKennung || !state.hasMore) return;
	const timeDelay = getNextTimeDelay();
	if (timeDelay === null) return;

	const params = requestParams({ timeDelay });
	params.set("VGNKennung", state.selectedStation.VGNKennung);
	await loadDepartures(`/api/v1/departures/station?${params.toString()}`, { append: true });
};

const findDepartureByKey = (key) => state.departures.find((departure) => getDepartureKey(departure) === key);

const toggleTripDetails = async (key) => {
	const departure = findDepartureByKey(key);
	if (!departure?.Fahrtnummer || !departure?.Produkt) return;

	const current = state.expandedTrips.get(key);
	if (current && !current.loading) {
		state.expandedTrips.delete(key);
		renderDepartures(state.departures);
		return;
	}

	state.expandedTrips.set(key, { loading: true });
	renderDepartures(state.departures);

	try {
		const params = new URLSearchParams();
		if (departure.Betriebstag) params.set("Betriebstag", departure.Betriebstag);
		const response = await fetch(`/api/v1/departures/trip/${encodeURIComponent(departure.Produkt)}/${encodeURIComponent(departure.Fahrtnummer)}?${params.toString()}`);
		const data = await response.json();
		if (!response.ok) throw new Error(data.info || data.message || "Fahrt konnte nicht geladen werden");

		state.expandedTrips.set(key, { data });
	} catch (error) {
		state.expandedTrips.set(key, { error: error.message });
	}

	renderDepartures(state.departures);
};

const renderSuggestions = (stations) => {
	state.lastSuggestions = stations;
	if (!stations.length) {
		elements.results.classList.add("hidden");
		elements.results.innerHTML = "";
		return;
	}

	elements.results.innerHTML = stations.slice(0, 12).map((station, index) => `
		<button class="flex w-full items-center justify-between gap-4 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50" type="button" data-index="${index}">
			<span>
				<span class="block text-sm font-semibold text-slate-950">${escapeHTML(station.Haltestellenname)}</span>
				<span class="block text-xs text-slate-500">${escapeHTML(station.Produkte || "-")}</span>
			</span>
			<span class="font-mono text-xs text-slate-500">${escapeHTML(station.VGNKennung)}</span>
		</button>
	`).join("");
	elements.results.classList.remove("hidden");
};

const searchStations = debounce(async () => {
	const query = elements.search.value.trim();
	if (query.length < 2) {
		renderSuggestions([]);
		return;
	}

	const response = await fetch(`/api/v1/stops/search?Haltestellenname=${encodeURIComponent(`%${query}%`)}`);
	const stations = await response.json();
	renderSuggestions(stations);
}, 180);

const locateClosestStation = () => {
	if (!navigator.geolocation) {
		setStatus("GPS fehlt", "error");
		return;
	}

	setStatus("GPS", "loading");
	navigator.geolocation.getCurrentPosition(async (position) => {
		const params = requestParams();
		params.set("Latitude", position.coords.latitude);
		params.set("Longitude", position.coords.longitude);
		params.set("Radius", "900");
		await loadDepartures(`/api/v1/departures/closest?${params.toString()}`, { append: false });
		if (state.selectedStation) {
			elements.search.value = state.selectedStation.Haltestellenname || "";
			updateUrl(state.selectedStation);
		}
	}, (error) => {
		elements.meta.textContent = error.message;
		setStatus("GPS Fehler", "error");
	}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
};

elements.search.addEventListener("input", searchStations);
elements.results.addEventListener("click", (event) => {
	const button = event.target.closest("button[data-index]");
	if (!button) return;
	const station = state.lastSuggestions[Number(button.dataset.index)];
	elements.results.classList.add("hidden");
	loadStationDepartures(station);
});
elements.body.addEventListener("click", (event) => {
	const row = event.target.closest("[data-trip-row]");
	if (!row) return;
	toggleTripDetails(row.dataset.tripRow);
});
elements.body.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" && event.key !== " ") return;
	const row = event.target.closest("[data-trip-row]");
	if (!row) return;
	event.preventDefault();
	toggleTripDetails(row.dataset.tripRow);
});
document.addEventListener("click", (event) => {
	if (!elements.results.contains(event.target) && event.target !== elements.search) {
		elements.results.classList.add("hidden");
	}
});
elements.refresh.addEventListener("click", () => loadStationDepartures(state.selectedStation));
elements.gps.addEventListener("click", locateClosestStation);
elements.product.addEventListener("change", () => loadStationDepartures(state.selectedStation));
window.addEventListener("scroll", debounce(() => {
	const scrollPosition = window.innerHeight + window.scrollY;
	const scrollHeight = document.documentElement.scrollHeight;
	if (scrollHeight - scrollPosition < 600) loadMoreDepartures();
}, 120));

const initialVgn = new URLSearchParams(window.location.search).get("VGNKennung");
if (initialVgn) {
	loadStationDepartures({ VGNKennung: initialVgn }, false);
}

state.refreshTimer = setInterval(() => {
	if (state.selectedStation) loadStationDepartures(state.selectedStation, false);
}, 30000);
