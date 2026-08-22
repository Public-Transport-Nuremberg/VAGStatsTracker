(() => {
  const elements = Object.fromEntries([
    'token', 'connect', 'toggle', 'status', 'count', 'bytes', 'liveState',
    'filter', 'limit', 'refresh', 'logs',
  ].map((id) => [id, document.getElementById(id)]));
  let status = null;
  let logs = [];
  let timer = null;
  let pollCount = 0;

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
  };

  const request = async (path, options = {}) => {
    const token = elements.token.value.trim();
    const response = await fetch(`/api/v1/apiTrace${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (!response.ok) {
      let detail = response.statusText;
      try { detail = (await response.json()).message || detail; } catch {}
      throw new Error(`${response.status}: ${detail}`);
    }
    return response.json();
  };

  const renderStatus = () => {
    elements.status.textContent = status?.enabled ? 'Aktiv' : 'Inaktiv';
    elements.status.className = status?.enabled ? 'text-emerald-700' : 'text-slate-700';
    elements.count.textContent = status?.count ?? '-';
    elements.bytes.textContent = status ? `${formatBytes(status.bytes)} / ${formatBytes(status.maxBytes)}` : '-';
    elements.toggle.textContent = status?.enabled ? 'Logging ausschalten' : 'Logging einschalten';
    elements.toggle.disabled = !status;
    elements.refresh.disabled = !status;
  };

  const renderLogs = () => {
    const query = elements.filter.value.trim().toLowerCase();
    const visible = query ? logs.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query)) : logs;
    elements.logs.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'p-6 text-center text-slate-500';
      empty.textContent = 'Keine passenden Trace-Einträge.';
      elements.logs.append(empty);
      return;
    }
    for (const entry of visible) {
      const row = document.createElement('div');
      row.className = 'trace-grid trace-row text-sm';
      const values = [
        new Date(entry.timestamp).toLocaleString(),
        entry.phase,
        entry.service,
        entry.operation,
      ];
      for (const value of values) {
        const cell = document.createElement('span');
        cell.textContent = value || '-';
        row.append(cell);
      }
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.className = 'cursor-pointer font-mono text-xs';
      summary.textContent = `${entry.requestId || '-'}${entry.durationMs !== undefined ? ` · ${entry.durationMs} ms` : ''}`;
      const pre = document.createElement('pre');
      pre.className = 'trace-json mt-2 rounded bg-slate-950 p-3 text-xs text-slate-100';
      pre.textContent = JSON.stringify(entry.request || entry.response || entry.error || {}, null, 2);
      details.append(summary, pre);
      row.append(details);
      elements.logs.append(row);
    }
  };

  const refresh = async () => {
    const [newStatus, payload] = await Promise.all([
      request('/status'),
      request(`/logs?limit=${encodeURIComponent(elements.limit.value)}`),
    ]);
    status = newStatus;
    logs = payload.logs;
    renderStatus();
    renderLogs();
  };

  const pollLive = async () => {
    const newestTimestamp = logs.length > 0 ? new Date(logs[0].timestamp).getTime() : 0;
    const payload = await request(`/logs?limit=1000&after=${newestTimestamp}`);
    if (payload.logs.length > 0) {
      const byId = new Map(logs.map((entry) => [entry.id, entry]));
      for (const entry of payload.logs) byId.set(entry.id, entry);
      logs = [...byId.values()]
        .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp))
        .slice(0, Number(elements.limit.value));
      renderLogs();
    }
    pollCount++;
    if (pollCount % 5 === 0) {
      status = await request('/status');
      renderStatus();
    }
  };

  const connect = async () => {
    clearInterval(timer);
    try {
      await refresh();
      sessionStorage.setItem('apiTraceToken', elements.token.value.trim());
      elements.liveState.textContent = 'Live: verbunden (1 s)';
      pollCount = 0;
      timer = setInterval(() => pollLive().catch((error) => {
        elements.liveState.textContent = `Live: Fehler (${error.message})`;
      }), 1000);
    } catch (error) {
      status = null;
      renderStatus();
      elements.status.textContent = error.message;
      elements.liveState.textContent = 'Live: aus';
    }
  };

  elements.token.value = sessionStorage.getItem('apiTraceToken') || '';
  elements.connect.addEventListener('click', connect);
  elements.refresh.addEventListener('click', () => refresh().catch((error) => { elements.liveState.textContent = `Live: Fehler (${error.message})`; }));
  elements.filter.addEventListener('input', renderLogs);
  elements.limit.addEventListener('change', () => refresh().catch(() => {}));
  elements.toggle.addEventListener('click', async () => {
    status = await request('/status', { method: 'POST', body: JSON.stringify({ enabled: !status.enabled }) });
    renderStatus();
  });
  if (elements.token.value) connect();
})();
