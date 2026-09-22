(() => {
  const ids = ['sharedBanner','loginPanel','recordingPanel','token','connect','recordingHours','startRecording','stopRecording','status','count','bytes','activeRecording','shareBox','shareUrl','copyShare','recordingSelect','loadRecording','downloadRecording','filter','refresh','downloadCurrent','viewState','logs','traceModal','modalTitle','modalRequest','modalResponse','closeModal'];
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
      return { ...item, route, parameters, code:responseEntry.statusCode ?? response?.status ?? response?.statusCode ?? responseEntry.error?.code ?? (responseEntry.error ? 'Fehler' : '-'), timestamp:requestEntry.timestamp || responseEntry.timestamp, durationMs:responseEntry.durationMs };
    }).sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
  };

  const renderLogs = () => {
    const query = elements.filter.value.trim().toLowerCase();
    const matching = transactions().filter((item) => !query || `${item.timestamp} ${item.route} ${compact(item.parameters)} ${item.code} ${item.requestId}`.toLowerCase().includes(query));
    const visible = matching.slice(0, 250);
    elements.logs.replaceChildren();
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'p-6 text-center text-slate-500'; empty.textContent = 'Keine passenden Requests.'; elements.logs.append(empty); return; }
    for (const item of visible) {
      const row = document.createElement('div'); row.className = 'trace-grid trace-row text-sm';
      [new Date(item.timestamp).toLocaleString(), item.route, compact(item.parameters), item.code].forEach((value) => { const cell = document.createElement('span'); cell.textContent = value ?? '-'; row.append(cell); });
      const openButton = document.createElement('button'); openButton.className = 'vag-button-secondary text-xs'; openButton.type = 'button'; openButton.textContent = `Anzeigen${item.durationMs !== undefined ? ` · ${item.durationMs} ms` : ''}`;
      openButton.addEventListener('click', () => openModal(item)); row.append(openButton); elements.logs.append(row);
    }
  };

  const openModal = (item) => {
    elements.modalTitle.textContent = `${item.route} · ${item.requestId}`;
    elements.modalRequest.textContent = JSON.stringify(item.requestEntry?.request || {}, null, 2);
    elements.modalResponse.textContent = JSON.stringify(item.responseEntry?.response || item.responseEntry?.error || {}, null, 2);
    elements.traceModal.classList.remove('hidden');
  };
  const closeModal = () => elements.traceModal.classList.add('hidden');

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
    const [newStatus, recordingPayload] = await Promise.all([apiRequest('/status'), apiRequest('/recordings')]);
    status = newStatus; recordings = recordingPayload.recordings;
    if (status.recording) {
      const logPayload = await apiRequest('/logs?limit=250');
      entries = logPayload.logs.filter((entry) => entry.recordingId === status.recording.id);
    }
    elements.viewState.textContent = status.recording ? 'Live-Aufnahme' : 'Verbunden'; renderStatus(); renderRecordings(); renderLogs(); elements.recordingPanel.classList.remove('hidden'); elements.downloadCurrent.disabled = !status.recording && !loadedPayload;
  };

  const connect = async () => {
    clearInterval(timer);
    try { await refreshAdmin(); sessionStorage.setItem('apiTraceToken', elements.token.value.trim()); timer = setInterval(() => refreshAdmin().catch(showError), 2000); }
    catch (error) { elements.viewState.textContent = `Verbindung fehlgeschlagen: ${error.message}`; }
  };

  const loadRecording = async (id = elements.recordingSelect.value) => {
    loadedPayload = await apiRequest(`/recordings/${encodeURIComponent(id)}`); entries = loadedPayload.entries || []; elements.viewState.textContent = `Datei ${id} · ${entries.length} Einträge`; renderLogs(); elements.downloadCurrent.disabled = false;
  };
  const downloadPayload = (payload) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `api-trace-${payload.recording?.id || 'shared'}.json`; link.click(); URL.revokeObjectURL(link.href);
  };
  const downloadFromApi = async (path, includeAdminToken) => {
    const response = await fetch(`/api/v1/apiTrace${path}`, { headers:includeAdminToken ? { Authorization:`Bearer ${elements.token.value.trim()}` } : {} });
    if (!response.ok) throw new Error(`${response.status}: ${(await response.json()).message || response.statusText}`);
    const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const name = disposition.match(/filename="([^"]+)"/)?.[1] || 'api-trace.json';
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); URL.revokeObjectURL(link.href);
  };
  function showError(error) { elements.viewState.textContent = `Fehler: ${error.message}`; }
  async function loadShared() {
    const response = await fetch(`/api/v1/apiTrace/shared/${encodeURIComponent(shareToken)}`);
    if (!response.ok) throw new Error(`${response.status}: ${(await response.json()).message || response.statusText}`);
    loadedPayload = await response.json(); entries = loadedPayload.entries || []; elements.viewState.textContent = `${loadedPayload.recording?.state === 'recording' ? 'Laufende' : 'Gespeicherte'} Aufnahme · ${entries.length} Einträge`; renderLogs(); elements.downloadCurrent.disabled = false;
  }

  elements.token.value = sessionStorage.getItem('apiTraceToken') || '';
  elements.connect.addEventListener('click', connect); elements.filter.addEventListener('input', renderLogs); elements.refresh.addEventListener('click', () => shareToken ? loadShared().catch(showError) : refreshAdmin().catch(showError));
  elements.startRecording.addEventListener('click', async () => { try { const result = await apiRequest('/recordings', { method:'POST', body:JSON.stringify({ hours:Number(elements.recordingHours.value) }) }); elements.shareUrl.value = `${location.origin}/api-logs?shareToken=${encodeURIComponent(result.shareToken)}`; elements.shareBox.classList.remove('hidden'); await refreshAdmin(); } catch (error) { showError(error); } });
  elements.stopRecording.addEventListener('click', async () => { try { await apiRequest('/recordings/stop', { method:'POST' }); await refreshAdmin(); } catch (error) { showError(error); } });
  elements.copyShare.addEventListener('click', () => navigator.clipboard.writeText(elements.shareUrl.value)); elements.loadRecording.addEventListener('click', () => loadRecording().catch(showError));
  elements.downloadRecording.addEventListener('click', () => downloadFromApi(`/recordings/${encodeURIComponent(elements.recordingSelect.value)}?download=1`, true).catch(showError));
  elements.downloadCurrent.addEventListener('click', async () => { try { if (shareToken) await downloadFromApi(`/shared/${encodeURIComponent(shareToken)}?download=1`, false); else if (loadedPayload) downloadPayload(loadedPayload); else if (status?.recording) await downloadFromApi(`/recordings/${encodeURIComponent(status.recording.id)}?download=1`, true); } catch (error) { showError(error); } });
  elements.closeModal.addEventListener('click', closeModal); elements.traceModal.addEventListener('click', (event) => { if (event.target === elements.traceModal) closeModal(); }); document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
  if (shareToken) {
    elements.loginPanel.classList.add('hidden'); elements.recordingPanel.classList.add('hidden'); elements.sharedBanner.classList.remove('hidden');
    loadShared().then(() => { if (loadedPayload.recording?.state === 'recording') timer = setInterval(() => loadShared().catch(showError), 2000); }).catch(showError);
  } else if (elements.token.value) connect();
})();
