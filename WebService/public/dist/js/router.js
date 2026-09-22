const state = {
    from: null,
    to: null,
    suggestions: { from: [], to: [] },
    searchControllers: { from: null, to: null },
    validFrom: null,
    validUntil: null,
};

const elements = {
    form: document.getElementById('journeyForm'),
    fromInput: document.getElementById('fromStation'),
    toInput: document.getElementById('toStation'),
    fromSuggestions: document.getElementById('fromSuggestions'),
    toSuggestions: document.getElementById('toSuggestions'),
    fromSelection: document.getElementById('fromSelection'),
    toSelection: document.getElementById('toSelection'),
    departure: document.getElementById('departureTime'),
    previousDay: document.getElementById('previousDay'),
    today: document.getElementById('today'),
    nextDay: document.getElementById('nextDay'),
    availableDates: document.getElementById('availableDates'),
    maxWalk: document.getElementById('maxWalk'),
    maxTransfers: document.getElementById('maxTransfers'),
    allowTightTransfers: document.getElementById('allowTightTransfers'),
    swap: document.getElementById('swapStations'),
    submit: document.getElementById('searchButton'),
    status: document.getElementById('searchStatus'),
    results: document.getElementById('journeyResults'),
    historyMeta: document.getElementById('historyMeta'),
    liveRegion: document.querySelector('[aria-live]'),
};

const productLabels = {
    ubahn: 'U-Bahn',
    tram: 'Tram',
    bus: 'Bus',
    sbahn: 'S-Bahn',
    rbahn: 'Regionalbahn',
};

const transportPresentation = (leg) => {
    const line = String(leg.line || '').trim();
    const normalizedLine = line.toUpperCase().replace(/\s+/g, '');
    if (leg.product === 'ubahn') {
        const colors = { U1: '#005CA9', U2: '#E3000B', U3: '#008A4B' };
        return { symbol: 'U', color: colors[normalizedLine] || '#005CA9', text: '#ffffff' };
    }
    if (leg.product === 'bus') return { symbol: 'B', color: '#E3000B', text: '#ffffff' };
    if (leg.product === 'tram') return { symbol: 'T', color: '#7A1E78', text: '#ffffff' };
    if (leg.product === 'sbahn') return { symbol: 'S', color: '#78BE20', text: '#173300' };
    if (leg.product === 'rbahn') {
        const symbol = normalizedLine.startsWith('RE') ? 'RE' : normalizedLine.startsWith('RB') ? 'RB' : 'R';
        return { symbol, color: '#78BE20', text: '#173300' };
    }
    return { symbol: '•', color: '#475569', text: '#ffffff' };
};

const errorLabels = {
    DATE_OUTSIDE_GTFS_RANGE: 'Für diese Abfahrtszeit liegen keine Fahrplandaten vor.',
    UNKNOWN_FROM_STATION: 'Die Starthaltestelle ist im Routing-Datensatz nicht bekannt.',
    UNKNOWN_TO_STATION: 'Die Zielhaltestelle ist im Routing-Datensatz nicht bekannt.',
    NO_PLATFORM_FOR_PRODUCTS: 'Für die gewählten Verkehrsmittel gibt es an Start oder Ziel keinen passenden Steig.',
    ROUTER_TIMEOUT: 'Die Verbindungssuche hat zu lange gedauert.',
    ROUTER_UNAVAILABLE: 'Der Routing-Dienst ist derzeit nicht erreichbar.',
};

const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}[character]));

const debounce = (callback, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => callback(...args), wait);
    };
};

const pickerElements = (kind) => ({
    input: elements[`${kind}Input`],
    suggestions: elements[`${kind}Suggestions`],
    selection: elements[`${kind}Selection`],
});

const setSelectedStation = (kind, station) => {
    const picker = pickerElements(kind);
    state[kind] = station;
    picker.input.value = station?.Haltestellenname || '';
    picker.selection.textContent = station
        ? `VGN ${station.VGNKennung} · ${station.Produkte || 'Produkte unbekannt'}`
        : 'Haltestelle auswählen – der passende Steig wird automatisch ermittelt.';
    picker.suggestions.classList.add('hidden');
    picker.input.setAttribute('aria-expanded', 'false');
};

const renderSuggestions = (kind, stations) => {
    const picker = pickerElements(kind);
    state.suggestions[kind] = stations.slice(0, 12);
    picker.suggestions.replaceChildren();

    for (const [index, station] of state.suggestions[kind].entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'flex w-full items-center justify-between gap-4 border-b border-slate-100 px-3 py-2 text-left last:border-0 hover:bg-slate-50 focus:bg-blue-50 focus:outline-none';
        button.dataset.index = String(index);
        button.setAttribute('role', 'option');

        const description = document.createElement('span');
        const name = document.createElement('span');
        name.className = 'block text-sm font-semibold text-slate-950';
        name.textContent = station.Haltestellenname || 'Unbekannte Haltestelle';
        const products = document.createElement('span');
        products.className = 'block text-xs text-slate-500';
        products.textContent = station.Produkte || 'Produkte unbekannt';
        description.append(name, products);

        const id = document.createElement('span');
        id.className = 'font-mono text-xs text-slate-500';
        id.textContent = station.VGNKennung;
        button.append(description, id);
        picker.suggestions.append(button);
    }

    const hasResults = state.suggestions[kind].length > 0;
    picker.suggestions.classList.toggle('hidden', !hasResults);
    picker.input.setAttribute('aria-expanded', String(hasResults));
};

const searchStations = async (kind) => {
    const picker = pickerElements(kind);
    const query = picker.input.value.trim();
    if (query.length < 2) {
        renderSuggestions(kind, []);
        return;
    }

    state.searchControllers[kind]?.abort();
    const controller = new AbortController();
    state.searchControllers[kind] = controller;
    try {
        const params = new URLSearchParams({ Haltestellenname: `%${query}%` });
        const response = await fetch(`/api/v1/stops/search?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Haltestellensuche fehlgeschlagen');
        const stations = await response.json();
        renderSuggestions(kind, Array.isArray(stations) ? stations : []);
    } catch (error) {
        if (error.name !== 'AbortError') renderSuggestions(kind, []);
    }
};

const localDateTimeValue = (date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
};

const updateDateButtons = () => {
    const selected = elements.departure.value.slice(0, 10);
    const today = localDateTimeValue(new Date()).slice(0, 10);
    elements.previousDay.disabled = Boolean(state.validFrom && selected <= state.validFrom);
    elements.nextDay.disabled = Boolean(state.validUntil && selected >= state.validUntil);
    elements.today.disabled = Boolean((state.validFrom && today < state.validFrom) || (state.validUntil && today > state.validUntil));
};

const setDepartureDay = (date) => {
    const next = localDateTimeValue(date);
    const day = next.slice(0, 10);
    if (state.validFrom && day < state.validFrom) return;
    if (state.validUntil && day > state.validUntil) return;
    elements.departure.value = next;
    updateDateButtons();
};

const shiftDepartureDay = (days) => {
    const selected = new Date(elements.departure.value);
    if (Number.isNaN(selected.getTime())) return;
    selected.setDate(selected.getDate() + days);
    setDepartureDay(selected);
};

const loadAvailableDates = async () => {
    try {
        const response = await fetch('/api/v1/router/health');
        if (!response.ok) return;
        const data = await response.json();
        state.validFrom = data.gtfs?.valid_from || null;
        state.validUntil = data.gtfs?.valid_until || null;
        if (state.validFrom) elements.departure.min = `${state.validFrom}T00:00`;
        if (state.validUntil) elements.departure.max = `${state.validUntil}T23:59`;
        if (state.validFrom && state.validUntil) {
            elements.availableDates.textContent = `Fahrplan verfügbar: ${new Date(`${state.validFrom}T12:00:00`).toLocaleDateString('de-DE')} – ${new Date(`${state.validUntil}T12:00:00`).toLocaleDateString('de-DE')}`;
        }
        const selected = elements.departure.value.slice(0, 10);
        if (state.validFrom && selected < state.validFrom) {
            elements.departure.value = `${state.validFrom}T12:00`;
        } else if (state.validUntil && selected > state.validUntil) {
            elements.departure.value = `${state.validUntil}T12:00`;
        }
        updateDateButtons();
    } catch {
        elements.availableDates.textContent = '';
    }
};

const formatTime = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '–' : date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
};

const formatDuration = (seconds) => {
    const minutes = Math.max(0, Math.round(Number(seconds) / 60));
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours} Std. ${minutes % 60} Min.` : `${minutes} Min.`;
};

const legDuration = (leg) => {
    const explicit = Number(leg.duration_seconds);
    if (Number.isFinite(explicit)) return explicit;
    const departure = new Date(leg.scheduled_departure).getTime();
    const arrival = new Date(leg.scheduled_arrival).getTime();
    return Number.isFinite(departure) && Number.isFinite(arrival) ? Math.max(0, (arrival - departure) / 1000) : 0;
};

const formatDelay = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return '–';
    const minutes = Math.round(value / 60);
    return `${minutes > 0 ? '+' : ''}${minutes} Min.`;
};

const formatProbability = (value) => {
    if (value === null || value === undefined || value === '') return 'Keine Daten';
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number * 100)} %` : 'Keine Daten';
};

const stopLabel = (stop) => stop?.name || stop?.stop_id || 'Unbekannter Halt';

const platformLabel = (stop) => {
    const id = String(stop?.stop_id || '');
    if (!id) return '';
    const platform = id.includes(':') ? id.split(':').pop() : id;
    return platform ? `Steig ${platform}` : '';
};

const reliabilityHTML = (leg) => {
    const reliability = leg.reliability || {};
    if (!reliability.statistics_available) {
        return '<p class="mt-3 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-500">Keine passenden historischen Daten für diesen Fahrtabschnitt.</p>';
    }

    const departure = reliability.departure;
    const arrival = reliability.arrival;
    return `
        <dl class="mt-3 grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <div><dt class="text-slate-500">Ø Abfahrt</dt><dd class="mt-1 font-semibold text-slate-900">${formatDelay(departure?.mean_seconds)}</dd></div>
          <div><dt class="text-slate-500">Ø Ankunft</dt><dd class="mt-1 font-semibold text-slate-900">${formatDelay(arrival?.mean_seconds)}</dd></div>
          <div><dt class="text-slate-500">P90 Ankunft</dt><dd class="mt-1 font-semibold text-slate-900">${formatDelay(arrival?.p90_seconds)}</dd></div>
          <div><dt class="text-slate-500">≥ 5 Min.</dt><dd class="mt-1 font-semibold text-slate-900">${formatProbability(arrival?.probability_over_300s)}</dd></div>
          <div><dt class="text-slate-500">Ausfall</dt><dd class="mt-1 font-semibold text-slate-900">${formatProbability(reliability.cancellation_probability)}</dd></div>
          <div><dt class="text-slate-500">Stichprobe</dt><dd class="mt-1 font-semibold text-slate-900">${escapeHTML(arrival?.samples ?? departure?.samples ?? '–')}</dd></div>
        </dl>`;
};

const intermediateStopsHTML = (leg) => {
    const stops = Array.isArray(leg.intermediate_stops) ? leg.intermediate_stops : [];
    if (!stops.length) return '';
    return `
      <details class="route-intermediate mt-3">
        <summary>${stops.length} Zwischenhalt${stops.length === 1 ? '' : 'e'}</summary>
        <ol class="mt-2 space-y-1.5 border-l border-slate-200 pl-4">
          ${stops.map((entry) => {
        const stop = entry.stop || entry;
        const platform = platformLabel(stop);
        const arrival = formatTime(entry.scheduled_arrival);
        const departure = formatTime(entry.scheduled_departure);
        const time = arrival === departure ? arrival : `${arrival}–${departure}`;
        return `<li class="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs text-slate-600">
              <time class="font-mono font-semibold text-slate-700">${time}</time>
              <span>${escapeHTML(stopLabel(stop))}${platform ? ` <span class="text-slate-400">· ${escapeHTML(platform)}</span>` : ''}</span>
            </li>`;
    }).join('')}
        </ol>
      </details>`;
};

const flagChipsHTML = (flags) => {
    if (!Array.isArray(flags)) return '';
    return flags
        .filter((flag) => flag.type !== 'NO_STATISTICS')
        .map((flag) => {
            const warning = flag.severity === 'warning' || flag.severity === 'critical';
            return `<span class="rounded-md border px-2 py-1 text-xs font-semibold ${warning ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600'}">${escapeHTML(flag.type)}</span>`;
        })
        .join('');
};

const transferFlagsHTML = (transfer) => {
    const chips = flagChipsHTML(transfer?.flags);
    if (!chips) return '';
    const next = transfer?.next_service;
    const cadence = Number(next?.cadence_seconds);
    const headway = Number(next?.headway_seconds);
    const destination = next?.fallback_destination || next?.to;
    const arrival = next?.fallback_destination_arrival || next?.scheduled_arrival;
    const fallbackIsComplete = Boolean(next?.fallback_destination_arrival);
    const presentation = next ? transportPresentation(next) : null;
    const symbolWidth = presentation?.symbol.length > 1 ? ' route-symbol-wide' : '';
    const serviceText = next
        ? `<div class="route-fallback">
             <p class="font-semibold text-green-900">Alternative, falls der Anschluss verpasst wird</p>
             <div class="mt-1 flex flex-wrap items-center gap-2">
               <span class="route-symbol${symbolWidth}" style="--route-color:${presentation.color};--route-text:${presentation.text}">${escapeHTML(presentation.symbol)}</span>
               <span class="route-line-badge" style="--route-color:${presentation.color};--route-text:${presentation.text}">${escapeHTML(next.line || '')}</span>
               <strong>${formatTime(next.scheduled_departure)}</strong>
               <span>${escapeHTML(stopLabel(next.from))}</span>
               <span aria-hidden="true">→</span>
               ${arrival ? `<strong>${formatTime(arrival)}</strong>` : ''}
               <span>${escapeHTML(stopLabel(destination))}</span>
             </div>
             <p class="mt-1 text-slate-600">${Number.isFinite(cadence) ? `${escapeHTML(next.line)} fährt etwa alle ${formatDuration(cadence)}` : `Nächste Fahrt in ${formatDuration(headway)}`}${next.success_probability !== null && next.success_probability !== undefined ? ` · <strong class="text-green-700">${formatProbability(next.success_probability)} erreichbar</strong>` : ''}${fallbackIsComplete ? '' : ' · Alternative gilt bis zum nächsten Umstieg'}</p>
           </div>`
        : '';
    return `<div class="route-transfer-flags"><span class="font-semibold text-amber-900">Dieser Umstieg:</span>${chips}${serviceText}</div>`;
};

const legHTML = (leg, transfer) => {
    const walking = leg.type === 'walk';
    const fromPlatform = platformLabel(leg.from);
    const toPlatform = platformLabel(leg.to);
    if (walking) {
        return `
          <li class="route-walk flex-wrap">
            <span class="route-walk-icon" aria-hidden="true">↳</span>
            <span class="font-medium">Fußweg ${formatDuration(legDuration(leg))}</span>
            <span class="min-w-0 truncate text-slate-400">${escapeHTML(stopLabel(leg.from))} → ${escapeHTML(stopLabel(leg.to))}</span>
            <time class="ml-auto whitespace-nowrap font-mono text-slate-400">${formatTime(leg.scheduled_departure)}–${formatTime(leg.scheduled_arrival)}</time>
            ${transferFlagsHTML(transfer)}
          </li>`;
    }
    const presentation = transportPresentation(leg);
    const label = productLabels[leg.product] || leg.product || 'Fahrt';
    const symbolWidth = presentation.symbol.length > 1 ? ' route-symbol-wide' : '';
    return `
      <li class="relative border-l-2 pb-5 pl-5 last:pb-0" style="border-color:${presentation.color}">
        <span class="absolute -left-2 top-0 h-3.5 w-3.5 rounded-full border-2 border-white" style="background:${presentation.color}"></span>
        ${transferFlagsHTML(transfer)}
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="route-symbol${symbolWidth}" style="--route-color:${presentation.color};--route-text:${presentation.text}" aria-label="${escapeHTML(label)}">${escapeHTML(presentation.symbol)}</span>
              ${leg.line ? `<span class="route-line-badge" style="--route-color:${presentation.color};--route-text:${presentation.text}">${escapeHTML(leg.line)}</span>` : ''}
              <span class="text-xs font-medium text-slate-500">${escapeHTML(label)}</span>
            </div>
            ${leg.direction ? `<p class="mt-1 text-xs text-slate-500">Richtung ${escapeHTML(leg.direction)}</p>` : ''}
          </div>
          <span class="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">${formatDuration(legDuration(leg))}</span>
        </div>
        <div class="mt-2 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <time class="font-mono font-semibold">${formatTime(leg.scheduled_departure)}</time>
          <span>${escapeHTML(stopLabel(leg.from))}${fromPlatform ? ` <span class="text-slate-500">· ${escapeHTML(fromPlatform)}</span>` : ''}</span>
          <time class="font-mono font-semibold">${formatTime(leg.scheduled_arrival)}</time>
          <span>${escapeHTML(stopLabel(leg.to))}${toPlatform ? ` <span class="text-slate-500">· ${escapeHTML(toPlatform)}</span>` : ''}</span>
        </div>
        ${intermediateStopsHTML(leg)}
        ${reliabilityHTML(leg)}
      </li>`;
};

const flagsHTML = (flags) => {
    const chips = flagChipsHTML(flags);
    return chips ? `<div class="mt-4 flex flex-wrap gap-2">${chips}</div>` : '';
};

const journeyLegsHTML = (journey) => {
    const legs = Array.isArray(journey.legs) ? journey.legs : [];
    const transfers = Array.isArray(journey.transfer_reliability) ? journey.transfer_reliability : [];
    return legs.map((leg, legIndex) => {
        let transfer;
        if (leg.type === 'walk') {
            transfer = transfers.find((item) => item.incoming_leg < legIndex && item.outgoing_leg > legIndex);
        } else {
            transfer = transfers.find((item) => {
                if (item.outgoing_leg !== legIndex) return false;
                return !legs.slice(item.incoming_leg + 1, item.outgoing_leg).some((itemLeg) => itemLeg.type === 'walk');
            });
        }
        return legHTML(leg, transfer);
    }).join('');
};

const journeyLineHTML = (journey) => {
    const modeClasses = {
        bus: 'route-mode-bus',
        sbahn: 'route-mode-sbahn',
        rbahn: 'route-mode-rbahn',
        tram: 'route-mode-tram',
        ubahn: 'route-mode-ubahn',
        other: 'route-mode-other',
    };
    const transitLegs = (Array.isArray(journey.legs) ? journey.legs : [])
        .filter((leg) => leg.type !== 'walk');
    if (!transitLegs.length) {
        return '<span class="text-sm font-semibold text-slate-600">Nur Fußweg</span>';
    }
    return transitLegs.map((leg, index) => {
        const product = ['bus', 'sbahn', 'rbahn', 'tram', 'ubahn'].includes(leg.product)
            ? leg.product
            : 'other';
        const label = leg.line || transportPresentation(leg).symbol;
        const modeLabel = productLabels[leg.product] || leg.product || 'Fahrt';
        return `${index ? '<span class="route-chain-arrow" aria-hidden="true">→</span>' : ''}
          <span class="route-mode-chip ${modeClasses[product]}" aria-label="${escapeHTML(`${modeLabel} ${label}`)}">${escapeHTML(label)}</span>`;
    }).join('');
};

const journeyHTML = (journey, index) => {
    const success = journey.reliability?.estimated_journey_success_probability;
    const transfer = journey.reliability?.minimum_transfer_probability;
    const hasReliability = success !== null && success !== undefined;
    return `
      <article class="vag-card overflow-hidden">
        <details class="route-journey">
          <summary class="route-journey-summary">
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase text-slate-500">Verbindung ${index + 1}</p>
              <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                <h2 class="text-xl font-semibold text-slate-950">${formatTime(journey.scheduled_departure)} – ${formatTime(journey.scheduled_arrival)}</h2>
                <div class="route-chain">${journeyLineHTML(journey)}</div>
              </div>
              <p class="mt-1 text-sm text-slate-600">${formatDuration(journey.duration_seconds)} · ${escapeHTML(journey.transfers)} Umstieg${journey.transfers === 1 ? '' : 'e'}</p>
            </div>
            <div class="ml-auto flex items-center gap-3">
              <div class="rounded-lg ${hasReliability ? 'bg-green-50 text-green-800' : 'bg-slate-100 text-slate-600'} px-4 py-2 text-right">
                <p class="text-xs font-semibold uppercase">Erfolgschance</p>
                <p class="text-lg font-bold">${formatProbability(success)}</p>
                ${transfer !== null && transfer !== undefined ? `<p class="text-xs">Schwächster Umstieg: ${formatProbability(transfer)}</p>` : ''}
              </div>
              <span class="route-journey-toggle" aria-hidden="true"></span>
              <span class="sr-only route-open-label">Details anzeigen</span>
              <span class="sr-only route-close-label">Details schließen</span>
            </div>
          </summary>
          <div class="border-t border-slate-200 bg-white px-5 pt-1">
            ${flagsHTML(journey.flags)}
          </div>
          <ol class="p-5">${journeyLegsHTML(journey)}</ol>
        </details>
      </article>`;
};

const performanceHTML = (metadata = {}) => {
    const timings = metadata.timings_ms || {};
    const definitions = [
        ['endpoint_resolution', 'Haltestellen & Optionen'],
        ['routing_search', 'Routensuche'],
        ['diversification', 'Alternativen auswählen'],
        ['statistics_selection', 'Statistik laden'],
        ['scoring', 'Zuverlässigkeit bewerten'],
        ['total', 'Server gesamt'],
        ['browser_round_trip', 'Browser bis Antwort'],
    ];
    const available = definitions.filter(([key]) => Number.isFinite(Number(timings[key])));
    if (!available.length) return '';
    const formatMs = (value) => `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;
    return `
      <details class="vag-card p-3 text-xs text-slate-600">
        <summary class="cursor-pointer font-semibold text-slate-700">Berechnungsdetails · Server ${formatMs(timings.total)} · Browser ${formatMs(timings.browser_round_trip)}</summary>
        <dl class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          ${available.map(([key, label]) => `<div class="rounded-md bg-slate-50 px-3 py-2"><dt>${label}</dt><dd class="mt-1 font-mono font-semibold text-slate-950">${formatMs(timings[key])}</dd></div>`).join('')}
          <div class="rounded-md bg-slate-50 px-3 py-2"><dt>Kandidaten / Ergebnisse</dt><dd class="mt-1 font-mono font-semibold text-slate-950">${escapeHTML(metadata.candidate_count ?? '–')} / ${escapeHTML(metadata.result_count ?? '–')}</dd></div>
        </dl>
      </details>`;
};

const showStatus = (message, mode = 'idle') => {
    elements.status.textContent = message;
    elements.status.className = 'vag-panel text-center text-sm';
    elements.status.classList.add(mode === 'error' ? 'text-vag-red' : 'text-slate-500');
    elements.status.classList.remove('hidden');
    elements.results.classList.add('hidden');
    elements.historyMeta.classList.add('hidden');
};

const showHistoryMeta = (snapshot = {}) => {
    const from = snapshot.statistics_history_from;
    const until = snapshot.statistics_history_until;
    elements.historyMeta.textContent = from && until
        ? `Zuverlässigkeitswerte aus historischen Fahrten vom ${new Date(`${from}T12:00:00`).toLocaleDateString('de-DE')} bis ${new Date(`${until}T12:00:00`).toLocaleDateString('de-DE')}.`
        : 'Für diesen Reisetag ist kein zeitlich passender historischer Statistikstand verfügbar.';
    elements.historyMeta.classList.remove('hidden');
};

const submitJourney = async (event) => {
    event.preventDefault();
    if (!state.from || !state.to) {
        showStatus('Bitte Start und Ziel aus der Vorschlagsliste auswählen.', 'error');
        return;
    }
    if (String(state.from.VGNKennung) === String(state.to.VGNKennung)) {
        showStatus('Start und Ziel müssen unterschiedlich sein.', 'error');
        return;
    }

    const products = [...document.querySelectorAll('input[name="product"]:checked')].map((input) => input.value);
    if (!products.length) {
        showStatus('Bitte mindestens ein Verkehrsmittel auswählen.', 'error');
        return;
    }

    const departure = new Date(elements.departure.value);
    if (Number.isNaN(departure.getTime())) {
        showStatus('Bitte eine gültige Abfahrtszeit wählen.', 'error');
        return;
    }
    const departureDay = elements.departure.value.slice(0, 10);
    if ((state.validFrom && departureDay < state.validFrom) || (state.validUntil && departureDay > state.validUntil)) {
        showStatus(`Bitte einen Reisetag im verfügbaren Fahrplanzeitraum wählen${state.validFrom && state.validUntil ? ` (${state.validFrom} bis ${state.validUntil})` : ''}.`, 'error');
        return;
    }

    elements.submit.disabled = true;
    elements.submit.textContent = 'Suche läuft…';
    elements.liveRegion.setAttribute('aria-busy', 'true');
    showStatus('Verbindung wird berechnet…');

    const browserStarted = performance.now();
    try {
        const response = await fetch('/api/v1/router/journeys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                from: { station_id: state.from.VGNKennung },
                to: { station_id: state.to.VGNKennung },
                departure: departure.toISOString(),
                profile: 'fastest',
                options: {
                    max_walk_seconds: Number(elements.maxWalk.value),
                    max_transfers: Number(elements.maxTransfers.value),
                    max_results: 5,
                    allow_tight_transfers: elements.allowTightTransfers.checked,
                    products,
                },
            }),
        });
        const data = await response.json().catch(() => ({}));
        data.metadata = data.metadata || {};
        data.metadata.timings_ms = data.metadata.timings_ms || {};
        data.metadata.timings_ms.browser_round_trip = performance.now() - browserStarted;
        if (!response.ok) {
            const code = data.error || data.message || 'ROUTING_FAILED';
            throw new Error(errorLabels[code] || `Verbindungssuche fehlgeschlagen (${code}).`);
        }

        const journeys = Array.isArray(data.journeys) ? data.journeys : [];
        if (!journeys.length) {
            showStatus('Keine passende Verbindung gefunden. Zeit, Verkehrsmittel oder Fußweg anpassen.');
            return;
        }

        elements.results.innerHTML = performanceHTML(data.metadata) + journeys.map(journeyHTML).join('');
        elements.results.classList.remove('hidden');
        elements.status.classList.add('hidden');
        showHistoryMeta(data.snapshot);
    } catch (error) {
        showStatus(error.message || 'Verbindungssuche fehlgeschlagen.', 'error');
    } finally {
        elements.submit.disabled = false;
        elements.submit.textContent = 'Verbindung suchen';
        elements.liveRegion.setAttribute('aria-busy', 'false');
    }
};

for (const kind of ['from', 'to']) {
    const picker = pickerElements(kind);
    const debouncedSearch = debounce(() => searchStations(kind), 180);
    picker.input.addEventListener('input', () => {
        state[kind] = null;
        picker.selection.textContent = 'Bitte eine Haltestelle aus der Liste auswählen.';
        debouncedSearch();
    });
    picker.suggestions.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-index]');
        if (!button) return;
        setSelectedStation(kind, state.suggestions[kind][Number(button.dataset.index)]);
    });
}

document.addEventListener('click', (event) => {
    for (const kind of ['from', 'to']) {
        const picker = pickerElements(kind);
        if (!picker.input.closest('.station-picker').contains(event.target)) {
            picker.suggestions.classList.add('hidden');
            picker.input.setAttribute('aria-expanded', 'false');
        }
    }
});

elements.swap.addEventListener('click', () => {
    const from = state.from;
    setSelectedStation('from', state.to);
    setSelectedStation('to', from);
});
elements.previousDay.addEventListener('click', () => shiftDepartureDay(-1));
elements.nextDay.addEventListener('click', () => shiftDepartureDay(1));
elements.today.addEventListener('click', () => {
    const selected = new Date(elements.departure.value);
    const now = new Date();
    now.setHours(Number.isNaN(selected.getTime()) ? 12 : selected.getHours(), Number.isNaN(selected.getTime()) ? 0 : selected.getMinutes(), 0, 0);
    setDepartureDay(now);
});
elements.departure.addEventListener('change', updateDateButtons);
elements.form.addEventListener('submit', submitJourney);

const initialDeparture = new Date(Date.now() + 5 * 60 * 1000);
initialDeparture.setSeconds(0, 0);
elements.departure.value = localDateTimeValue(initialDeparture);
updateDateButtons();
loadAvailableDates();
