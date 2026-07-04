'use strict';

const state = {
  sessionId: '',
  records: [],
  reportRows: [],
  filter: 'all',
  search: '',
  pollTimer: null,
  validationPollTimer: null,
  mongoConfigured: false,
  exportOptions: {
    includeTv: true,
    includeMovies: true,
    includeAnime: true,
  },
};

const elements = {
  uploadForm: document.getElementById('uploadForm'),
  restoreForm: document.getElementById('restoreForm'),
  uploadPanel: document.getElementById('uploadPanel'),
  reviewPanel: document.getElementById('reviewPanel'),
  progressWrap: document.getElementById('progressWrap'),
  progressPhase: document.getElementById('progressPhase'),
  progressNumbers: document.getElementById('progressNumbers'),
  progressBar: document.getElementById('progressBar'),
  elapsedText: document.getElementById('elapsedText'),
  etaText: document.getElementById('etaText'),
  remainingText: document.getElementById('remainingText'),
  recordsBody: document.getElementById('recordsBody'),
  conversionIssuesPanel: document.getElementById('conversionIssuesPanel'),
  conversionIssuesSummary: document.getElementById('conversionIssuesSummary'),
  conversionIssuesBody: document.getElementById('conversionIssuesBody'),
  summaryStrip: document.getElementById('summaryStrip'),
  searchInput: document.getElementById('searchInput'),
  validateButton: document.getElementById('validateButton'),
  saveDbButton: document.getElementById('saveDbButton'),
  downloadButton: document.getElementById('downloadButton'),
  exportTv: document.getElementById('exportTv'),
  exportMovies: document.getElementById('exportMovies'),
  exportAnime: document.getElementById('exportAnime'),
  restoreSessionId: document.getElementById('restoreSessionId'),
  activeSessionBar: document.getElementById('activeSessionBar'),
  activeSessionIdText: document.getElementById('activeSessionIdText'),
  copyActiveSessionButton: document.getElementById('copyActiveSessionButton'),
  sessionIdText: document.getElementById('sessionIdText'),
  copySessionButton: document.getElementById('copySessionButton'),
  themeToggle: document.getElementById('themeToggle'),
  themeToggleIcon: document.getElementById('themeToggleIcon'),
  sessionMeta: document.getElementById('sessionMeta'),
  toast: document.getElementById('toast'),
  blockingOverlay: document.getElementById('blockingOverlay'),
  blockingTitle: document.getElementById('blockingTitle'),
  blockingPhase: document.getElementById('blockingPhase'),
  blockingBar: document.getElementById('blockingBar'),
  blockingElapsed: document.getElementById('blockingElapsed'),
  blockingEta: document.getElementById('blockingEta'),
  blockingRemaining: document.getElementById('blockingRemaining'),
};

elements.uploadForm.addEventListener('submit', onUpload);
elements.restoreForm.addEventListener('submit', restoreSession);
elements.searchInput.addEventListener('input', () => {
  state.search = elements.searchInput.value.trim().toLowerCase();
  renderTable();
});
elements.validateButton.addEventListener('click', validatePending);
elements.saveDbButton.addEventListener('click', () => saveConfirmedIds());
elements.downloadButton.addEventListener('click', downloadZip);
elements.copySessionButton.addEventListener('click', copySessionId);
if (elements.copyActiveSessionButton) {
  elements.copyActiveSessionButton.addEventListener('click', copySessionId);
}
elements.exportTv.addEventListener('change', syncExportOptions);
elements.exportMovies.addEventListener('change', syncExportOptions);
elements.exportAnime.addEventListener('change', syncExportOptions);
if (elements.themeToggle) {
  elements.themeToggle.addEventListener('click', toggleTheme);
}

initTheme();
initLastSession();
loadConfig();

document.querySelectorAll('.chip').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('active'));
    button.classList.add('active');
    state.filter = button.dataset.filter;
    renderTable();
  });
});

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const payload = await response.json();
    state.mongoConfigured = Boolean(payload.mongoConfigured);
  } catch {
    state.mongoConfigured = false;
  }
  renderSummary();
}

function syncExportOptions() {
  state.exportOptions = {
    includeTv: elements.exportTv.checked,
    includeMovies: elements.exportMovies.checked,
    includeAnime: elements.exportAnime.checked,
  };
  renderSummary();
}

function initTheme() {
  const savedTheme = readSavedTheme();
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(savedTheme || (prefersDark ? 'dark' : 'light'), false);
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(nextTheme, true);
}

function setTheme(theme, persist) {
  const safeTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = safeTheme;
  if (elements.themeToggleIcon) {
    elements.themeToggleIcon.textContent = safeTheme === 'dark' ? 'Light' : 'Dark';
  }
  if (elements.themeToggle) {
    elements.themeToggle.setAttribute('aria-pressed', safeTheme === 'dark' ? 'true' : 'false');
    elements.themeToggle.title = safeTheme === 'dark' ? 'Enable light mode' : 'Enable dark mode';
  }
  if (persist) {
    try {
      localStorage.setItem('theme', safeTheme);
    } catch {
      // Ignore private browsing/storage restrictions.
    }
  }
}

function readSavedTheme() {
  try {
    const theme = localStorage.getItem('theme');
    return theme === 'dark' || theme === 'light' ? theme : '';
  } catch {
    return '';
  }
}

function initLastSession() {
  try {
    const sessionId = localStorage.getItem('lastSessionId') || '';
    if (elements.restoreSessionId && sessionId) {
      elements.restoreSessionId.value = sessionId;
    }
  } catch {
    // Ignore private browsing/storage restrictions.
  }
}

function saveSessionDraft() {
  if (!state.sessionId) return;
  try {
    const draft = state.records.map((record) => ({
      id: record.id,
      currentId: record.currentId || '',
      currentType: record.currentType || defaultType(record),
      imdbWarning: record.imdbWarning || '',
    }));
    localStorage.setItem(`sessionDraft:${state.sessionId}`, JSON.stringify(draft));
  } catch {
    // Ignore private browsing/storage restrictions.
  }
}

function applySessionDraft(sessionId) {
  try {
    const raw = localStorage.getItem(`sessionDraft:${sessionId}`);
    if (!raw) return;

    const draft = new Map(JSON.parse(raw).map((record) => [record.id, record]));
    for (const record of state.records) {
      const saved = draft.get(record.id);
      if (!saved) continue;
      record.currentId = cleanId(saved.currentId) || '';
      record.currentType = saved.currentType || record.currentType;
      record.imdbWarning = saved.imdbWarning || '';
    }
  } catch {
    // Ignore invalid/old draft data.
  }
}

elements.recordsBody.addEventListener('input', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  const record = state.records.find((item) => item.id === row.dataset.id);
  if (!record) return;

  if (event.target.classList.contains('simkl-id')) {
    const parsed = parseIdInput(event.target.value);
    record.imdbWarning = parsed.imdbId;
    record.currentId = parsed.simklId;
    event.target.value = parsed.simklId;
  }
  if (event.target.classList.contains('type-select')) {
    record.currentType = event.target.value;
  }

  updateRowState(row, record);
  saveSessionDraft();
  renderSummary();
});

elements.recordsBody.addEventListener('paste', (event) => {
  const input = event.target.closest('.simkl-id');
  if (!input) return;

  const row = input.closest('tr[data-id]');
  const record = state.records.find((item) => item.id === row.dataset.id);
  if (!record) return;

  const pasted = event.clipboardData ? event.clipboardData.getData('text') : '';
  const parsed = parseIdInput(pasted);
  if (!parsed.imdbId) return;

  event.preventDefault();
  record.imdbWarning = parsed.imdbId;
  record.currentId = '';
  input.value = '';
  updateRowState(row, record);
  saveSessionDraft();
  renderSummary();
  showToast(`${parsed.imdbId} is an IMDb ID, not a SIMKL ID.`);
});

async function onUpload(event) {
  event.preventDefault();
  const form = new FormData(elements.uploadForm);
  form.set('includePlanToWatch', document.getElementById('includePlanToWatch').checked ? 'true' : 'false');
  form.set('includeRewatches', document.getElementById('includeRewatches').checked ? 'true' : 'false');

  setUploadBusy(true);
  elements.reviewPanel.classList.add('hidden');
  state.records = [];
  state.reportRows = [];
  showProgress({
    phase: 'uploading ZIP',
    done: 0,
    total: 1,
    percent: 0,
    elapsed: '00:00:00',
    eta: '--:--:--',
    remaining: 0,
  });

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      body: form,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Upload failed.');
    }
    setActiveSessionId(payload.sessionId || payload.jobId);
    pollJob(payload.jobId);
  } catch (error) {
    setUploadBusy(false);
    showToast(error.message);
  }
}

async function restoreSession(event) {
  event.preventDefault();
  const sessionId = String(elements.restoreSessionId.value || '').trim();
  if (!sessionId) {
    showToast('Paste a session ID first.');
    return;
  }

  setRestoreBusy(true);
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Session not found.');
    }
    if (payload.session) {
      loadSession(payload.session);
      showToast('Session restored.');
      return;
    }
    if (payload.job) {
      restoreJob(payload.job);
      return;
    }
    throw new Error('Session not found.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setRestoreBusy(false);
  }
}

function pollJob(jobId) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      const job = await response.json();
      if (!response.ok) {
        throw new Error(job.error || 'Job not found.');
      }

      setActiveSessionId(job.sessionId || job.id);
      showProgress(job.progress);

      if (job.status === 'error') {
        clearInterval(state.pollTimer);
        setUploadBusy(false);
        showToast(job.error || 'Processing failed.');
      }

      if (job.status === 'done') {
        clearInterval(state.pollTimer);
        setUploadBusy(false);
        loadSession(job.result);
      }
    } catch (error) {
      clearInterval(state.pollTimer);
      setUploadBusy(false);
      showToast(error.message);
    }
  }, 800);
}

function restoreJob(job) {
  state.records = [];
  state.reportRows = [];
  elements.reviewPanel.classList.add('hidden');
  setActiveSessionId(job.sessionId || job.id);
  showProgress(job.progress || {
    phase: 'processing',
    done: 0,
    total: 1,
    percent: 0,
    elapsed: '00:00:00',
    eta: '--:--:--',
    remaining: 1,
  });

  if (job.status === 'done' && job.result) {
    loadSession(job.result);
    showToast('Session restored.');
    return;
  }

  if (job.status === 'error') {
    setUploadBusy(false);
    showToast(job.error || 'This session failed during processing.');
    return;
  }

  setUploadBusy(true);
  pollJob(job.id);
  showToast('Session is still processing. Progress tracking will continue while the server is running.');
}

function loadSession(session) {
  setActiveSessionId(session.id);
  state.reportRows = Array.isArray(session.reportRows) ? session.reportRows : [];
  state.records = session.records.map((record) => ({
    ...record,
    currentId: record.inputSimklId || '',
    currentType: record.simklType || defaultType(record),
    imdbWarning: '',
  }));
  applySessionDraft(session.id);

  elements.reviewPanel.classList.remove('hidden');
  elements.sessionMeta.textContent = `${state.records.length} records | session ${session.id.slice(0, 8)}`;
  renderSummary();
  renderTable();
  renderConversionIssues();
  showToast('ZIP processed. Review the IDs before generating the backup.');
}

function setActiveSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;

  state.sessionId = id;
  if (elements.activeSessionBar) {
    elements.activeSessionBar.classList.remove('hidden');
  }
  if (elements.activeSessionIdText) {
    elements.activeSessionIdText.textContent = id;
  }
  if (elements.sessionIdText) {
    elements.sessionIdText.textContent = id;
  }
  if (elements.restoreSessionId) {
    elements.restoreSessionId.value = id;
  }
  if (elements.sessionMeta && !state.records.length) {
    elements.sessionMeta.textContent = `session ${id.slice(0, 8)} | processing`;
  }

  try {
    localStorage.setItem('lastSessionId', id);
  } catch {
    // Ignore private browsing/storage restrictions.
  }
}

async function copySessionId() {
  if (!state.sessionId) return;
  try {
    await navigator.clipboard.writeText(state.sessionId);
    showToast('Session ID copied.');
  } catch {
    showToast(`Session ID: ${state.sessionId}`);
  }
}

function renderSummary() {
  const counts = countVisualStates();
  const typeCounts = countSimklTypes();
  const metrics = [
    ['Total', state.records.length],
    ['Found', counts.found],
    ['Changed', counts.pending],
    ['Not found', counts.not_found],
    ['TV Shows', typeCounts.tv],
    ['Movies', typeCounts.movie],
    ['Anime', typeCounts.anime],
    ['Episodes', sum('watchedEpisodes')],
    ['Rewatches', sum('rewatchEntries')],
    ['Skipped TV Time rows', skippedConversionRows().length],
  ];

  elements.summaryStrip.innerHTML = metrics.map(([label, value]) => (
    `<div class="metric"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`
  )).join('');

  elements.validateButton.disabled = counts.pending === 0;
  const saveState = getSaveState();
  elements.saveDbButton.disabled = !state.mongoConfigured || saveState.saveable === 0 || saveState.blocked > 0;
  elements.saveDbButton.title = saveDbTitle(saveState);
}

function renderTable() {
  const rows = filteredRecords();
  elements.recordsBody.innerHTML = rows.map(renderRecordRow).join('');
  for (const row of elements.recordsBody.querySelectorAll('tr[data-id]')) {
    const record = state.records.find((item) => item.id === row.dataset.id);
    if (record) updateRowState(row, record);
  }
}

function renderConversionIssues() {
  if (!elements.conversionIssuesPanel || !elements.conversionIssuesBody) return;

  const skipped = skippedConversionRows();
  const warnings = state.reportRows.filter((row) => !isSkippedConversionRow(row)).length;
  const skippedText = `${skipped.length} skipped ${skipped.length === 1 ? 'row' : 'rows'}`;
  const warningText = warnings ? `, ${warnings} parsing ${warnings === 1 ? 'warning' : 'warnings'}` : '';

  elements.conversionIssuesSummary.textContent = `${skippedText}${warningText}`;

  if (!skipped.length) {
    elements.conversionIssuesBody.innerHTML = `
      <tr class="empty-issues-row">
        <td colspan="6">
          No broken TV Time rows were skipped. Everything that could be converted is shown in the review table above.
        </td>
      </tr>
    `;
    return;
  }

  elements.conversionIssuesBody.innerHTML = skipped.map(renderConversionIssueRow).join('');
}

function renderConversionIssueRow(row) {
  const titleBits = [
    row.title ? `Title: ${row.title}` : '',
    row.year ? `Year: ${row.year}` : '',
    row.season ? `S${row.season}` : '',
    row.episode ? `E${row.episode}` : '',
  ].filter(Boolean);

  return `
    <tr>
      <td>${escapeHtml(row.source || '-')}</td>
      <td>${escapeHtml(row.row || '-')}</td>
      <td>${escapeHtml(row.type || '-')}</td>
      <td>
        <strong>${escapeHtml(titleBits.join(' | ') || 'Missing usable title/episode data')}</strong>
        <span>${escapeHtml(row.details || '')}</span>
      </td>
      <td>${escapeHtml(row.reason || 'Invalid or unsupported TV Time row')}</td>
      <td>${escapeHtml(row.suggestion || 'Check this item manually before importing.')}</td>
    </tr>
  `;
}

function renderRecordRow(record) {
  const typeOptions = getTypeOptions(record).map((option) => (
    `<option value="${option.value}" ${option.value === record.currentType ? 'selected' : ''}>${option.label}</option>`
  )).join('');
  const year = record.year ? ` (${record.year})` : '';
  const simklYear = record.simklYear ? ` (${record.simklYear})` : '';
  const details = [
    record.occurrences > 1 ? `${record.occurrences} entries` : '1 entry',
    record.watchedEpisodes ? `${record.watchedEpisodes} eps` : '',
    record.rewatchEntries ? `${record.rewatchEntries} rewatches` : '',
    record.confidence ? `${record.confidence}%` : '',
  ].filter(Boolean).join(' | ');

  return `
    <tr data-id="${escapeAttr(record.id)}">
      <td><span class="status-pill"></span></td>
      <td>
        <select class="type-select" ${record.sourceType === 'movie' ? 'disabled' : ''}>
          ${typeOptions}
        </select>
      </td>
      <td class="title-cell">
        <strong>${escapeHtml(record.title)}</strong>
        <span>${escapeHtml(labelType(record.sourceType))}${escapeHtml(year)}</span>
      </td>
      <td>
        <div class="simkl-id-wrap">
          <input class="simkl-id" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(record.currentId || '')}">
        </div>
        <span class="id-warning-line hidden">
          <span class="id-warning-text"></span>
          <span class="id-warning" title="This is an IMDb ID, not a SIMKL ID. Paste it into SIMKL search to open the matching page, then copy the numeric SIMKL ID from the SIMKL URL.">!</span>
        </span>
      </td>
      <td class="simkl-name">
        <strong>${escapeHtml(record.simklTitle || '')}</strong>
        <span>${escapeHtml(labelType(record.simklType))}${escapeHtml(simklYear)}</span>
      </td>
      <td><span class="details">${escapeHtml(details)}</span></td>
    </tr>
  `;
}

function updateRowState(row, record) {
  const status = visualStatus(record);
  row.classList.remove('found', 'not-found', 'pending');
  row.classList.add(status === 'not_found' ? 'not-found' : status);
  const pill = row.querySelector('.status-pill');
  if (pill) {
    pill.textContent = status === 'found' ? 'Found' : status === 'pending' ? 'Changed' : 'No match';
  }

  const warningLine = row.querySelector('.id-warning-line');
  const warningText = row.querySelector('.id-warning-text');
  if (warningLine && warningText) {
    const hasWarning = Boolean(record.imdbWarning);
    warningLine.classList.toggle('hidden', !hasWarning);
    warningText.textContent = hasWarning ? `${record.imdbWarning} is IMDb, not SIMKL` : '';
  }
}

async function validatePending() {
  const pending = state.records.filter((record) => visualStatus(record) === 'pending' && cleanId(record.currentId));
  if (!pending.length) {
    showToast('There are no changed IDs to validate.');
    return;
  }

  showBlocking('Validating IDs in SIMKL', {
    phase: 'preparing validation',
    percent: 0,
    elapsed: '00:00:00',
    eta: '--:--:--',
    remaining: pending.length,
  });

  try {
    const response = await fetch('/api/validation-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        records: pending.map((record) => ({
          id: record.id,
          simklId: record.currentId,
          simklType: record.currentType,
        })),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Validation failed.');
    }
    await pollValidationJob(payload.jobId);
  } catch (error) {
    hideBlocking();
    showToast(error.message);
  }
}

function pollValidationJob(jobId) {
  return new Promise((resolve, reject) => {
    clearInterval(state.validationPollTimer);
    state.validationPollTimer = setInterval(async () => {
      try {
        const response = await fetch(`/api/validation-jobs/${encodeURIComponent(jobId)}`);
        const job = await response.json();
        if (!response.ok) {
          throw new Error(job.error || 'Validation job not found.');
        }

        showBlocking('Validating IDs in SIMKL', job.progress);

        if (job.status === 'error') {
          clearInterval(state.validationPollTimer);
          hideBlocking();
          reject(new Error(job.error || 'ID validation failed.'));
          return;
        }

        if (job.status === 'done') {
          clearInterval(state.validationPollTimer);
          mergeRecords((job.result && job.result.records) || []);
          saveSessionDraft();
          renderSummary();
          renderTable();
          hideBlocking();
          showToast(`${((job.result && job.result.records) || []).length} ID(s) validated.`);
          resolve();
        }
      } catch (error) {
        clearInterval(state.validationPollTimer);
        hideBlocking();
        reject(error);
      }
    }, 500);
  });
}

async function downloadZip() {
  if (!state.sessionId) return;
  syncExportOptions();
  if (!state.exportOptions.includeTv && !state.exportOptions.includeMovies && !state.exportOptions.includeAnime) {
    showToast('Select at least one type to export.');
    return;
  }

  const shouldSave = window.confirm('Save confirmed IDs to the database before generating the ZIP?\n\nOK = save to database and generate ZIP\nCancel = generate ZIP without saving');
  if (shouldSave) {
    const saved = await saveConfirmedIds({ allowNoop: true });
    if (!saved) {
      const continueDownload = window.confirm('The IDs could not be saved right now. Generate the ZIP without saving to the database?');
      if (!continueDownload) {
        return;
      }
    }
  }

  await requestDownload();
}

async function requestDownload() {
  elements.downloadButton.disabled = true;
  elements.downloadButton.textContent = 'Generating...';

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        records: state.records.map((record) => ({
          id: record.id,
          simklId: record.currentId,
          simklType: record.currentType,
        })),
        exportOptions: state.exportOptions,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Failed to generate ZIP.');
    }

    const blob = await response.blob();
    const filename = filenameFromResponse(response) || 'SimklBackup.zip';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('ZIP generated.');
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.downloadButton.disabled = false;
    elements.downloadButton.textContent = 'Generate ZIP';
    renderSummary();
  }
}

async function saveConfirmedIds(options) {
  const config = options || {};
  const saveState = getSaveState();

  if (!state.mongoConfigured) {
    showToast('MONGODB_URL is not configured in .env.');
    return false;
  }
  if (saveState.blocked > 0) {
    showToast('Some filled IDs are not green yet. Validate them before saving to the database.');
    return false;
  }
  if (saveState.saveable === 0) {
    if (!config.allowNoop) {
      showToast('There are no green IDs to save.');
    }
    return true;
  }

  elements.saveDbButton.disabled = true;
  elements.saveDbButton.textContent = 'Saving...';

  try {
    const response = await fetch('/api/db/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        records: state.records.map((record) => ({
          id: record.id,
          simklId: cleanId(record.currentId),
          simklType: record.currentType,
        })),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to save to the database.');
    }

    showToast(`${payload.saved || 0} ID(s) saved to the database.`);
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  } finally {
    elements.saveDbButton.textContent = 'Save IDs to database';
    renderSummary();
  }
}

function mergeRecords(records) {
  const byId = new Map(state.records.map((record) => [record.id, record]));
  for (const update of records) {
    const record = byId.get(update.id);
    if (!record) continue;
    Object.assign(record, update);
    record.currentId = update.inputSimklId || '';
    record.currentType = update.simklType || defaultType(update);
    record.imdbWarning = '';
  }
}

function filteredRecords() {
  return state.records.filter((record) => {
    const status = visualStatus(record);
    if (state.filter !== 'all' && status !== state.filter) return false;
    if (!state.search) return true;
    const haystack = [
      record.title,
      record.year,
      record.currentId,
      record.simklTitle,
      record.simklType,
      record.sourceType,
    ].join(' ').toLowerCase();
    return haystack.includes(state.search);
  });
}

function visualStatus(record) {
  const currentId = cleanId(record.currentId);
  if (!currentId) return 'not_found';

  const baselineId = cleanId(record.inputSimklId);
  const baselineType = record.simklType || defaultType(record);
  if (currentId !== baselineId || record.currentType !== baselineType) {
    return 'pending';
  }

  if (record.status === 'found' && cleanId(record.verifiedSimklId) === currentId) {
    return record.typeVerified === true ? 'found' : 'pending';
  }

  return 'not_found';
}

function countVisualStates() {
  return state.records.reduce((counts, record) => {
    counts[visualStatus(record)] += 1;
    return counts;
  }, { found: 0, pending: 0, not_found: 0 });
}

function countSimklTypes() {
  return state.records.reduce((counts, record) => {
    if (record.sourceType === 'movie') {
      counts.movie += 1;
    } else if (record.simklType === 'anime') {
      counts.anime += 1;
    } else {
      counts.tv += 1;
    }
    return counts;
  }, { tv: 0, movie: 0, anime: 0 });
}

function getSaveState() {
  let saveable = 0;
  let blocked = 0;
  let empty = 0;

  for (const record of state.records) {
    const rawId = String(record.currentId || '').trim();
    if (!rawId) {
      empty += 1;
      continue;
    }

    if (visualStatus(record) === 'found') {
      saveable += 1;
    } else {
      blocked += 1;
    }
  }

  return { saveable, blocked, empty };
}

function skippedConversionRows() {
  return state.reportRows.filter(isSkippedConversionRow);
}

function isSkippedConversionRow(row) {
  return row && (row.action === 'not converted' || row.action === 'not applied');
}

function saveDbTitle(saveState) {
  if (!state.mongoConfigured) {
    return 'Configure MONGODB_URL in .env and restart the server.';
  }
  if (saveState.blocked > 0) {
    return 'Some filled IDs still need SIMKL validation.';
  }
  if (saveState.saveable === 0) {
    return 'There are no green IDs to save.';
  }
  return `${saveState.saveable} green ID(s) ready to save.`;
}

function sum(property) {
  return state.records.reduce((total, record) => total + (Number(record[property]) || 0), 0);
}

function showProgress(progress) {
  const data = progress || {};
  const done = Number.isFinite(Number(data.done)) ? Number(data.done) : 0;
  const total = Math.max(1, Number.isFinite(Number(data.total)) ? Number(data.total) : 1);
  const percent = Number.isFinite(Number(data.percent)) ? Number(data.percent) : 0;
  elements.progressWrap.classList.remove('hidden');
  elements.progressPhase.textContent = data.phase || 'processing';
  elements.progressNumbers.textContent = `${done}/${total} (${percent}%)`;
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  elements.elapsedText.textContent = `Elapsed ${data.elapsed || '00:00:00'}`;
  elements.etaText.textContent = `Remaining ${data.eta || '--:--:--'}`;
  elements.remainingText.textContent = `Items left ${data.remaining || 0}`;
}

function showBlocking(title, progress) {
  const data = progress || {};
  elements.blockingOverlay.classList.remove('hidden');
  elements.blockingTitle.textContent = title || 'Working';
  elements.blockingPhase.textContent = data.phase || 'processing';
  elements.blockingBar.style.width = `${Math.max(0, Math.min(100, data.percent || 0))}%`;
  elements.blockingElapsed.textContent = `Elapsed ${data.elapsed || '00:00:00'}`;
  elements.blockingEta.textContent = `Remaining ${data.eta || '--:--:--'}`;
  elements.blockingRemaining.textContent = `Items left ${data.remaining || 0}`;
}

function hideBlocking() {
  elements.blockingOverlay.classList.add('hidden');
}

function setUploadBusy(isBusy) {
  elements.uploadForm.querySelectorAll('input, button').forEach((control) => {
    control.disabled = isBusy;
  });
}

function setRestoreBusy(isBusy) {
  elements.restoreForm.querySelectorAll('input, button').forEach((control) => {
    control.disabled = isBusy;
  });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 4200);
}

function getTypeOptions(record) {
  if (record.sourceType === 'movie') {
    return [{ value: 'movie', label: 'Movie' }];
  }
  return [
    { value: 'tv', label: 'TV Show' },
    { value: 'anime', label: 'Anime' },
  ];
}

function defaultType(record) {
  if (record.sourceType === 'movie') return 'movie';
  if (record.sourceType === 'anime') return 'anime';
  return 'tv';
}

function labelType(type) {
  if (type === 'movie') return 'Movie';
  if (type === 'anime') return 'Anime';
  return 'TV Show';
}

function cleanId(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function parseIdInput(value) {
  const text = String(value || '').trim();
  const imdbMatch = text.match(/\btt\d{5,12}\b/i);
  if (imdbMatch) {
    return {
      simklId: '',
      imdbId: imdbMatch[0].toLowerCase(),
    };
  }

  return {
    simklId: text.replace(/\D/g, ''),
    imdbId: '',
  };
}

function filenameFromResponse(response) {
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  return match ? match[1] : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
