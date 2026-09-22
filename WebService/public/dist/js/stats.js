(() => {
  const element = (id) => document.getElementById(id);
  const integer = new Intl.NumberFormat('de-DE');
  const decimal = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const bytes = (value) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = Number(value) || 0;
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
    return `${decimal.format(amount)} ${units[unit]}`;
  };
  const duration = (minutes) => {
    const value = Number(minutes) || 0;
    if (value < 60) return `${integer.format(value)} Min.`;
    if (value < 1440) return `${decimal.format(value / 60)} Std.`;
    return `${decimal.format(value / 1440)} Tage`;
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
  const card = (label, value, note) => `
    <article class="vag-card p-4">
      <p class="text-xs font-semibold uppercase text-slate-500">${label}</p>
      <p class="mt-1 text-2xl font-semibold text-vag-blue">${value}</p>
      <p class="mt-1 text-xs text-slate-500">${note}</p>
    </article>`;

  const render = (data) => {
    const today = data.today;
    element('dailyStats').innerHTML = [
      card('Fahrten', integer.format(today.trips), `${integer.format(today.lines)} Linien heute erfasst`),
      card('Halte', integer.format(today.stopObservations), `an ${integer.format(today.stops)} Haltestellen`),
      card('Fahrzeuge', integer.format(today.vehicles), 'mit bekannter Fahrzeugnummer'),
      card('Pünktlich', `${decimal.format(today.onTimePercent)} %`, 'Abfahrt zwischen 1 Min. früh und 3 Min. spät'),
      card('Ø Verspätung', `${decimal.format(today.averageDelaySeconds)} Sek.`, 'je erfasster Abfahrt'),
      card('Verspätung gesammelt', duration(today.delayMinutes), 'nur positive Abfahrtsverspätung'),
      card('Meiste Fahrten', today.busiestLine ? escapeHtml(today.busiestLine) : '—', today.busiestLine ? `${integer.format(today.busiestLineTrips)} Fahrten` : 'noch keine Daten'),
      card('Ausfälle', integer.format(today.cancelledTrips), 'heute markierte Fahrten'),
    ].join('');

    const totals = data.totals;
    const totalRatio = totals.compressedBytes ? totals.uncompressedBytes / totals.compressedBytes : 0;
    element('databaseName').textContent = data.database ? `Datenbank: ${data.database}` : 'Aktuelle Datenbank';
    element('storageTotals').textContent = `${integer.format(totals.rows)} Zeilen · ${bytes(totals.compressedBytes)} komprimiert${totalRatio ? ` · ${decimal.format(totalRatio)}× Faktor` : ''}`;
    element('tableStats').innerHTML = data.tables.map((table) => {
      const ratio = table.compressedBytes ? table.uncompressedBytes / table.compressedBytes : 0;
      return `<tr class="hover:bg-slate-50">
        <th class="px-4 py-3 font-mono font-semibold text-slate-900">${escapeHtml(table.name)}</th>
        <td class="px-4 py-3 text-slate-500">${escapeHtml(table.engine)}</td>
        <td class="px-4 py-3 text-right tabular-nums">${integer.format(table.rows)}</td>
        <td class="px-4 py-3 text-right tabular-nums">${bytes(table.compressedBytes)}</td>
        <td class="px-4 py-3 text-right tabular-nums">${table.uncompressedBytes ? bytes(table.uncompressedBytes) : '—'}</td>
        <td class="px-4 py-3 text-right tabular-nums">${ratio ? `${decimal.format(ratio)}×` : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td class="px-4 py-6 text-center text-slate-500" colspan="6">Keine Tabellen gefunden.</td></tr>';
    element('status').textContent = `Stand: ${new Date(data.generatedAt).toLocaleString('de-DE')}`;
  };

  const load = async () => {
    element('refresh').disabled = true;
    element('status').textContent = 'Statistiken werden geladen …';
    try {
      const response = await fetch('/api/v1/databaseStats/');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
    } catch (error) {
      element('status').textContent = `Statistiken konnten nicht geladen werden (${error.message}).`;
    } finally {
      element('refresh').disabled = false;
    }
  };

  element('refresh').addEventListener('click', load);
  load();
})();
