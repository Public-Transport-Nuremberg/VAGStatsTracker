(() => {
  const ids = ['sharedBanner','loginPanel','recordingPanel','token','connect','recordingHours','startRecording','stopRecording','status','count','bytes','activeRecording','shareBox','shareUrl','copyShare','recordingSelect','loadRecording','downloadRecording','filter','refresh','viewState','logs'];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const shareToken = new URLSearchParams(location.search).get('shareToken');
  let status = null;
  let entries = [];
  let loadedPayload = null;
  let recordings = [];
  let timer = null;

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB']; let value = bytes; let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
  };

  const apiRequest = async (path, options = {}) => {
    const response = await fetch(`/api/v1/apiTrace${path}`, { ...options, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${elements.token.value.trim()}`, ...(options.headers || {}) } });
    if (!response.ok) { let detail = response.statusText; try { detail = (await response.json()).message || detail; } catch {} throw new Error(`${response.status}: ${detail}`); }
    return response.json();
  };

  const compact = (value) => {
    if (value === undefined || value === null) return '-';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  };

  const transactions = () => {
    const grouped = new Map();
    for (const entry of entries) {
      const key = entry.requestId || entry.id; const item = grouped.get(key) || { requestId:key };
      if (entry.phase === 'request') item.requestEntry = entry; else item.responseEntry = entry;
      grouped.set(key, item);
    }
    return [...grouped.values()].map((item) => {
      const requestEntry = item.requestEntry || {}; const responseEntry = item.responseEntry || {}; const request = requestEntry.request || {};
      let route = `${requestEntry.service || responseEntry.service || '-'}/${requestEntry.operation || responseEntry.operation || '-'}`;
      let parameters = request.args ?? request.options ?? {};
      if (request.url) { try { const url = new URL(request.url); route = url.pathname; parameters = { query:Object.fromEntries(url.searchParams), options:request.options || {} }; } catch { route = request.url; } }
      const response = responseEntry.response;
      return { ...item, route, parameters, code:response?.status ?? response?.statusCode ?? (responseEntry.error ? 'Fehler' : '-'), timestamp:requestEntry.timestamp || responseEntry.timestamp, durationMs:responseEntry.durationMs };
    }).sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
  };

  const renderLogs = () => {
    const query = elements.filter.value.trim().toLowerCase();
    const visible = transactions().filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query));
    elements.logs.replaceChildren();
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'p-6 text-center text-slate-500'; empty.textContent = 'Keine passenden Requests.'; elements.logs.append(empty); return; }
    for (const item of visible) {
      const row = document.createElement('div'); row.className = 'trace-grid trace-row text-sm';
      [new Date(item.timestamp).toLocaleString(), item.route, compact(item.parameters), item.code].forEach((value) => { const cell = document.createElement('span'); cell.textContent = value ?? '-'; row.append(cell); });
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.className = 'cursor-pointer font-mono text-xs'; summary.textContent = `${item.requestId}${item.durationMs !== undefined ? ` · ${item.durationMs} ms` : ''}`;
      const requestTitle = document.createElement('strong'); requestTitle.className = 'mt-3 block text-xs uppercase'; requestTitle.textContent = 'Request';
      const requestPre = document.createElement('pre'); requestPre.className = 'trace-json mt-1 rounded bg-slate-950 p-3 text-xs text-slate-100'; requestPre.textContent = JSON.stringify(item.requestEntry?.request || {}, null, 2);
      const responseTitle = document.createElement('strong'); responseTitle.className = 'mt-3 block text-xs uppercase'; responseTitle.textContent = 'Response';
      const responsePre = document.createElement('pre'); responsePre.className = requestPre.className; responsePre.textContent = JSON.stringify(item.responseEntry?.response || item.responseEntry?.error || {}, null, 2);
      details.append(summary, requestTitle, requestPre, responseTitle, responsePre); row.append(details); elements.logs.append(row);
    }
  };

  const renderStatus = () => {
    const active = status?.recording; elements.status.textContent = active ? 'Aufnahme läuft' : 'Inaktiv'; elements.status.className = active ? 'text-emerald-700' : 'text-slate-700';
    elements.count.textContent = status?.count ?? '-'; elements.bytes.textContent = status ? `${formatBytes(status.bytes)} / ${formatBytes(status.maxBytes)}` : '-';
    elements.startRecording.disabled = Boolean(active); elements.stopRecording.disabled = !active;
    elements.activeRecording.textContent = active ? `Aufnahme ${active.id} · Ende ${new Date(active.endsAt).toLocaleString()}` : 'Keine aktive Aufnahme.';
  };

  const renderRecordings = () => {
    const selected = elements.recordingSelect.value; elements.recordingSelect.replaceChildren();
    for (const recording of recordings) { const option = document.createElement('option'); option.value = recording.id; option.textContent = `${new Date(recording.startedAt).toLocaleString()} · ${recording.hours} h · ${recording.state} · ${recording.entryCount ?? 0} Einträge`; elements.recordingSelect.append(option); }
    if (recordings.some((item) => item.id === selected)) elements.recordingSelect.value = selected;
    elements.loadRecording.disabled = !recordings.length; elements.downloadRecording.disabled = !recordings.length;
  };

  const refreshAdmin = async () => {
    const [newStatus, logPayload, recordingPayload] = await Promise.all([apiRequest('/status'), apiRequest('/logs?limit=1000'), apiRequest('/recordings')]);
    status = newStatus; recordings = recordingPayload.recordings;
    if (status.recording) entries = logPayload.logs.filter((entry) => entry.recordingId === status.recording.id);
    renderStatus(); renderRecordings(); renderLogs(); elements.recordingPanel.classList.remove('hidden'); elements.viewState.textContent = status.recording ? 'Live-Aufnahme' : 'Verbunden';
  };

  const connect = async () => {
    clearInterval(timer);
    try { await refreshAdmin(); sessionStorage.setItem('apiTraceToken', elements.token.value.trim()); timer = setInterval(() => refreshAdmin().catch(showError), 2000); }
    catch (error) { elements.viewState.textContent = `Verbindung fehlgeschlagen: ${error.message}`; }
  };

  const loadRecording = async (id = elements.recordingSelect.value) => {
    loadedPayload = await apiRequest(`/recordings/${encodeURIComponent(id)}`); entries = loadedPayload.entries || []; renderLogs(); elements.viewState.textContent = `Datei ${id} · ${entries.length} Einträge`;
  };
  const downloadPayload = (payload) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `api-trace-${payload.recording?.id || 'shared'}.json`; link.click(); URL.revokeObjectURL(link.href);
  };
  function showError(error) { elements.viewState.textContent = `Fehler: ${error.message}`; }
  async function loadShared() {
    const response = await fetch(`/api/v1/apiTrace/shared/${encodeURIComponent(shareToken)}`);
    if (!response.ok) throw new Error(`${response.status}: ${(await response.json()).message || response.statusText}`);
    loadedPayload = await response.json(); entries = loadedPayload.entries || []; renderLogs(); elements.viewState.textContent = `${loadedPayload.recording?.state === 'recording' ? 'Laufende' : 'Gespeicherte'} Aufnahme · ${entries.length} Einträge`;
  }

  elements.token.value = sessionStorage.getItem('apiTraceToken') || '';
  elements.connect.addEventListener('click', connect); elements.filter.addEventListener('input', renderLogs); elements.refresh.addEventListener('click', () => shareToken ? loadShared().catch(showError) : refreshAdmin().catch(showError));
  elements.startRecording.addEventListener('click', async () => { try { const result = await apiRequest('/recordings', { method:'POST', body:JSON.stringify({ hours:Number(elements.recordingHours.value) }) }); elements.shareUrl.value = `${location.origin}/api-logs?shareToken=${encodeURIComponent(result.shareToken)}`; elements.shareBox.classList.remove('hidden'); await refreshAdmin(); } catch (error) { showError(error); } });
  elements.stopRecording.addEventListener('click', async () => { try { await apiRequest('/recordings/stop', { method:'POST' }); await refreshAdmin(); } catch (error) { showError(error); } });
  elements.copyShare.addEventListener('click', () => navigator.clipboard.writeText(elements.shareUrl.value)); elements.loadRecording.addEventListener('click', () => loadRecording().catch(showError));
  elements.downloadRecording.addEventListener('click', async () => { try { if (!loadedPayload || loadedPayload.recording?.id !== elements.recordingSelect.value) await loadRecording(); downloadPayload(loadedPayload); } catch (error) { showError(error); } });
  if (shareToken) {
    elements.loginPanel.classList.add('hidden'); elements.recordingPanel.classList.add('hidden'); elements.sharedBanner.classList.remove('hidden');
    loadShared().then(() => { if (loadedPayload.recording?.state === 'recording') timer = setInterval(() => loadShared().catch(showError), 2000); }).catch(showError);
  } else if (elements.token.value) connect();
})();
