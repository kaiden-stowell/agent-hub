'use strict';

let boards         = [];
let currentBoardId = localStorage.getItem('currentBoardId') || 'board-default';
let allSkills      = [];
let activeSkillId  = null;
let assignSelectedIds = new Set();
let fileBrowserPath   = '';
let userHomeDir       = '';

let ws = null;
let agents = [];
let currentDetailRunId = null;
let currentChatAgentId = null;
let chatIsStreaming     = false;

// Live output buffer for office desk screens (agentId -> string)
const agentLiveOutput = {};

// ── Board helpers ──────────────────────────────────────────────────────────
function currentBoard() { return boards.find(b => b.id === currentBoardId) || boards[0]; }
function currentCOO()   { return agents.find(a => a.protected); }

// Append ?boardId= to board-scoped GET paths
function bUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'boardId=' + currentBoardId;
}

// Add boardId to a POST/PUT body object
function bBody(obj) { return JSON.stringify({ boardId: currentBoardId, ...obj }); }

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen  = () => setWS('connected');
  ws.onclose = () => { setWS('error'); setTimeout(connectWS, 3000); };
  ws.onerror = () => setWS('error');
  ws.onmessage = e => handleWS(JSON.parse(e.data));
}

function setWS(state) {
  document.getElementById('ws-status').className = 'status-dot ' + (state === 'connected' ? 'connected' : state === 'error' ? 'error' : '');
  document.getElementById('ws-label').textContent = state === 'connected' ? 'Live' : state === 'error' ? 'Reconnecting' : 'Connecting';
}

async function handleWS({ event, data }) {
  if (event === 'board:created' || event === 'board:updated' || event === 'board:deleted') {
    await loadBoards();
  }
  if (event === 'integration:telegram') {
    if (document.getElementById('view-integrations').classList.contains('active')) loadIntegrations();
  }
  if (event === 'imessage:message') {
    appendImessageFeedItem(data);
    inboxAddMessage(data);
    if (data.type === 'out') {
      const preview = data.text.length > 80 ? data.text.slice(0, 80) + '…' : data.text;
      showToast(`<strong>${esc(data.agentName)}</strong> replied to ${esc(data.handle)}: <em>${esc(preview)}</em>`, 'info', 8000);
    }
    // Badge on nav if inbox isn't open
    if (!document.getElementById('view-inbox').classList.contains('active')) {
      bumpInboxBadge();
    }
  }
  if (event === 'run:started')   { refreshStats(); refreshActiveRuns(); if (data.agentId) agentLiveOutput[data.agentId] = ''; }
  if (event === 'run:done')      { refreshStats(); refreshActiveRuns(); loadRuns(); if (data.agentId) delete agentLiveOutput[data.agentId]; if (currentDetailRunId === data.runId) loadRunDetail(data.runId); }
  if (event === 'run:output') {
    if (currentDetailRunId === data.runId) {
      const box = document.getElementById('detail-output');
      if (box) { box.textContent += data.chunk; box.scrollTop = box.scrollHeight; }
    }
    if (data.agentId) {
      agentLiveOutput[data.agentId] = (agentLiveOutput[data.agentId] || '') + data.chunk;
      updateDeskScreen(data.agentId);
    }
  }
  if (event === 'task:done') {
    showToast(`✅ Task complete: <strong>${esc(data.title)}</strong>${data.agent_name ? ` by ${esc(data.agent_name)}` : ''}`, 'success');
  }
  if (event === 'task:created' || event === 'task:updated' || event === 'task:deleted' || event === 'task:archived') {
    renderKanban(); refreshActiveTasks();
  }
  if (event === 'agent:created' || event === 'agent:updated' || event === 'agent:deleted') {
    loadDashboard();
    if (document.getElementById('view-agents').classList.contains('active')) renderAgents();
    if (document.getElementById('view-office').classList.contains('active')) loadOfficeView();
  }
  if (event === 'run:started' || event === 'run:done' || event === 'chat:start' || event === 'chat:done') {
    if (document.getElementById('view-office').classList.contains('active')) loadOfficeView();
  }
  if (event === 'cron:created' || event === 'cron:updated' || event === 'cron:deleted' || event === 'cron:fired') {
    refreshStats();
    if (document.getElementById('view-schedules').classList.contains('active')) loadSchedules();
  }
  if (event === 'skill:created' || event === 'skill:updated' || event === 'skill:deleted') {
    allSkills = await api('/skills');
    if (document.getElementById('view-skills').classList.contains('active')) renderSkillsSidebar();
  }
  if (event === 'chat:start') {
    if (data.agentId) agentLiveOutput[data.agentId] = '';
    if (data.agentId === currentChatAgentId) {
      chatIsStreaming = true; updateChatSendBtn();
      let bubble = document.getElementById('msg-' + data.messageId);
      if (!bubble) bubble = addChatBubble({ id: data.messageId, role: 'assistant', content: '', streaming: true });
    }
  }
  if (event === 'chat:chunk') {
    if (data.agentId) {
      agentLiveOutput[data.agentId] = (agentLiveOutput[data.agentId] || '') + data.chunk;
      updateDeskScreen(data.agentId);
    }
    if (data.agentId === currentChatAgentId) {
      const bubble = document.getElementById('msg-' + data.messageId);
      if (bubble) { bubble.textContent += data.chunk; bubble.classList.add('streaming'); scrollChatToBottom(); }
    }
  }
  if (event === 'chat:done') {
    if (data.agentId) delete agentLiveOutput[data.agentId];
    if (data.agentId === currentChatAgentId) {
      chatIsStreaming = false; updateChatSendBtn();
      const bubble = document.getElementById('msg-' + data.messageId);
      if (bubble) { if (data.content) bubble.textContent = data.content; bubble.classList.remove('streaming'); }
      scrollChatToBottom();
    }
  }
}

// ── Settings / Theme ──────────────────────────────────────────────────────
const THEME_COLORS = [
  { name: 'Indigo',  accent: '#6366f1', accentH: '#818cf8' },
  { name: 'Blue',    accent: '#3b82f6', accentH: '#60a5fa' },
  { name: 'Cyan',    accent: '#06b6d4', accentH: '#22d3ee' },
  { name: 'Emerald', accent: '#10b981', accentH: '#34d399' },
  { name: 'Violet',  accent: '#8b5cf6', accentH: '#a78bfa' },
  { name: 'Rose',    accent: '#f43f5e', accentH: '#fb7185' },
  { name: 'Amber',   accent: '#f59e0b', accentH: '#fbbf24' },
  { name: 'Pink',    accent: '#ec4899', accentH: '#f472b6' },
  { name: 'Orange',  accent: '#f97316', accentH: '#fb923c' },
  { name: 'Teal',    accent: '#14b8a6', accentH: '#2dd4bf' },
];

function initTheme() {
  const saved = localStorage.getItem('themeAccent');
  if (saved) {
    const t = THEME_COLORS.find(c => c.accent === saved);
    if (t) applyTheme(t);
  }
}

function applyTheme(t) {
  const r = document.documentElement.style;
  r.setProperty('--accent', t.accent);
  r.setProperty('--accent-h', t.accentH);
  // derive glow from accent
  const hex = t.accent;
  const rr = parseInt(hex.slice(1,3),16), gg = parseInt(hex.slice(3,5),16), bb = parseInt(hex.slice(5,7),16);
  r.setProperty('--accent-glow', `rgba(${rr},${gg},${bb},0.2)`);
  localStorage.setItem('themeAccent', t.accent);
  renderSwatches();
}

function renderSwatches() {
  const el = document.getElementById('theme-swatches');
  if (!el) return;
  const current = localStorage.getItem('themeAccent') || '#6366f1';
  el.innerHTML = THEME_COLORS.map(t =>
    `<button class="theme-swatch ${t.accent === current ? 'active' : ''}" style="background:${t.accent}" onclick="applyTheme(THEME_COLORS.find(c=>c.accent==='${t.accent}'))" title="${t.name}">
      ${t.accent === current ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="#fff"><path d="M13.5 4.5l-7 7L3 8" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
    </button>`
  ).join('');
}

function openSettings() {
  document.getElementById('settings-modal').classList.remove('hidden');
  renderSwatches();
}
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden'); }

initTheme();

// ── Navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    switchView(link.dataset.view);
  });
});

function switchView(name) {
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'agents')       renderAgents();
  if (name === 'tasks')        renderKanban();
  if (name === 'activity')     loadRuns();
  if (name === 'office')       loadOfficeView();
  if (name === 'skills')       loadSkillsView();
  if (name === 'schedules')    loadSchedules();
  if (name === 'integrations') loadIntegrations();
  if (name === 'inbox')       { loadInbox(); clearInboxBadge(); }
}

// ── API ────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error || res.statusText); }
  return res.json();
}

// ── Boards ─────────────────────────────────────────────────────────────────
async function loadBoards() {
  boards = await api('/boards');
  if (!boards.find(b => b.id === currentBoardId)) {
    currentBoardId = boards[0]?.id || 'board-default';
    localStorage.setItem('currentBoardId', currentBoardId);
  }
  renderBoardSwitcher();
}

function renderBoardSwitcher() {
  const board = currentBoard();
  const el = document.getElementById('board-switcher');
  if (!el) return;
  el.innerHTML = `
    <button class="board-btn" onclick="toggleBoardMenu(event)">
      <span class="board-dot" style="background:${esc(board?.color || '#6366f1')}"></span>
      <span class="board-name">${esc(board?.name || 'Default')}</span>
      <svg class="board-caret" viewBox="0 0 10 6" fill="currentColor" width="10"><path d="M0 0l5 6 5-6z"/></svg>
    </button>
    <div class="board-menu hidden" id="board-menu">
      ${boards.map(b => `
        <div class="board-menu-item ${b.id === currentBoardId ? 'active' : ''}" onclick="switchBoard('${b.id}')">
          <span class="board-dot" style="background:${esc(b.color)}"></span>
          ${esc(b.name)}
          ${b.id === currentBoardId ? '<svg viewBox="0 0 12 12" fill="currentColor" width="12"><path d="M2 6l3 4 5-7"/></svg>' : ''}
        </div>`).join('')}
      <div class="board-menu-sep"></div>
      <div class="board-menu-item" onclick="showNewBoard()">＋ New board</div>
      ${boards.length > 1 && board?.id !== 'board-default'
        ? `<div class="board-menu-item danger" onclick="deleteCurrentBoard()">✕ Delete "${esc(board?.name)}"</div>`
        : ''}
    </div>`;
}

function toggleBoardMenu(e) {
  e.stopPropagation();
  document.getElementById('board-menu')?.classList.toggle('hidden');
}
document.addEventListener('click', () => document.getElementById('board-menu')?.classList.add('hidden'));

async function switchBoard(boardId) {
  currentBoardId = boardId;
  localStorage.setItem('currentBoardId', boardId);
  renderBoardSwitcher();
  await loadDashboard();
  const active = document.querySelector('.nav-link.active')?.dataset.view;
  if (active && active !== 'dashboard') switchView(active);
}

function showNewBoard() {
  document.getElementById('board-modal-title').textContent = 'New Board';
  document.getElementById('bf-id').value    = '';
  document.getElementById('bf-name').value  = '';
  document.getElementById('bf-color').value = '#6366f1';
  document.getElementById('board-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('bf-name').focus(), 60);
}

async function showRenameBoard() {
  const b = currentBoard();
  if (!b) return;
  document.getElementById('board-modal-title').textContent = 'Rename Board';
  document.getElementById('bf-id').value    = b.id;
  document.getElementById('bf-name').value  = b.name;
  document.getElementById('bf-color').value = b.color || '#6366f1';
  document.getElementById('board-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('bf-name').focus(), 60);
}

async function saveBoard(e) {
  e.preventDefault();
  const id    = document.getElementById('bf-id').value;
  const name  = document.getElementById('bf-name').value.trim();
  const color = document.getElementById('bf-color').value;
  if (!name) return;
  if (id) {
    await api('/boards/' + id, { method: 'PUT', body: JSON.stringify({ name, color }) });
  } else {
    const b = await api('/boards', { method: 'POST', body: JSON.stringify({ name, color }) });
    await switchBoard(b.id);
  }
  document.getElementById('board-modal').classList.add('hidden');
  await loadBoards();
}

async function deleteCurrentBoard() {
  const b = currentBoard();
  if (!b || !confirm(`Delete board "${b.name}" and all its agents, tasks, and skills? This cannot be undone.`)) return;
  try {
    await api('/boards/' + b.id, { method: 'DELETE' });
    currentBoardId = boards.find(x => x.id !== b.id)?.id || 'board-default';
    localStorage.setItem('currentBoardId', currentBoardId);
    await loadBoards();
    await loadDashboard();
  } catch(err) { alert(err.message); }
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function refreshStats() {
  const s = await api(bUrl('/stats'));
  setText('stat-agents', s.agents);
  setText('stat-running', s.running);
  setText('stat-tasks', s.tasks);
  setText('stat-crons', s.crons);
}

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  agents = await api(bUrl('/agents'));
  populateAgentSelects();
  renderDashAgents();
  await refreshStats();
  await refreshActiveRuns();
  await refreshActiveTasks();
}

function renderDashAgents() {
  const el = document.getElementById('dash-agents');
  el.innerHTML = agents.length
    ? agents.map(agentCard).join('')
    : '<div class="empty-hint">No agents — the COO can hire them for you</div>';
}

async function refreshActiveRuns() {
  const runs = await api(bUrl('/runs?status=running&limit=8'));
  const el = document.getElementById('dash-active-runs');
  el.innerHTML = runs.length ? runs.map(runRowMini).join('') : '<div class="empty-hint">No active runs</div>';
}

async function refreshActiveTasks() {
  const tasks = await api(bUrl('/tasks?status=in-progress'));
  const el = document.getElementById('dash-active-tasks');
  el.innerHTML = tasks.length ? tasks.map(taskMiniCard).join('') : '<div class="empty-hint">No tasks in progress</div>';
}

function runRowMini(r) {
  const isCOO = r.agent_id === currentCOO()?.id;
  return `<div class="run-card running" onclick="openRunDetail('${r.id}')">
    <div class="run-info">
      <div class="run-agent">${isCOO ? '👔 ' : ''}${esc(r.agent_name)}</div>
      <div class="run-prompt">${esc(r.prompt)}</div>
    </div>
    <span class="badge badge-running">running</span>
    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();stopRun('${r.id}')">Stop</button>
  </div>`;
}

function taskMiniCard(t) {
  return `<div class="task-mini-card" onclick="openEditTask('${t.id}')">
    <span class="priority-dot p-${t.priority}"></span>
    <span class="task-mini-title">${esc(t.title)}</span>
    ${t.agent_name ? `<span class="task-mini-agent">${esc(t.agent_name)}</span>` : ''}
  </div>`;
}

// ── Agent rendering ────────────────────────────────────────────────────────
function agentCard(a) {
  const isCOO   = !!a.protected;
  const tags    = JSON.parse(a.tags || '[]').map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const channels = [a.telegram_chat_id && '<span class="ch-tag">Telegram</span>', a.imessage_handle && '<span class="ch-tag">iMessage</span>'].filter(Boolean).join('');
  const model   = (a.model || '').replace('claude-', '').replace('-4-6', ' 4.6').replace('-4-5-20251001', ' 4.5');
  const statusHtml = a.status === 'running'
    ? `<div class="status-pill status-running"><div class="pulse"></div>Running</div>`
    : `<div class="status-pill status-idle">Idle</div>`;

  const agentSkills = (a.skill_ids || []).map(sid => allSkills.find(s => s.id === sid)).filter(Boolean);
  const skillChips  = agentSkills.map(s => `<span class="skill-chip">📄 ${esc(s.name)}</span>`).join('');

  const actions = isCOO
    ? `<button class="btn btn-primary btn-sm" onclick="openChat('${a.id}')">Chat with COO</button>
       <button class="btn btn-ghost btn-sm" onclick="openRunModal('${a.id}','${esc(a.name)}')">Run</button>
       <button class="btn btn-ghost btn-sm" onclick="viewAgentRuns('${a.id}')">Runs</button>`
    : `<button class="btn btn-primary btn-sm" onclick="openRunModal('${a.id}','${esc(a.name)}')">Run</button>
       <button class="btn btn-ghost btn-sm" onclick="openChat('${a.id}')">
         <svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13"><path d="M14 1H2C1.45 1 1 1.45 1 2v9c0 .55.45 1 1 1h2v3l3-3h7c.55 0 1-.45 1-1V2c0-.55-.45-1-1-1z"/></svg>Chat
       </button>
       <button class="btn btn-ghost btn-sm" onclick="openAssignSkills('${a.id}','${esc(a.name)}')">
         📄 Skills${agentSkills.length ? ` (${agentSkills.length})` : ''}
       </button>
       <button class="btn btn-ghost btn-sm" onclick="openEditAgent('${a.id}')">Edit</button>
       <button class="btn btn-ghost btn-sm" onclick="showNewCronForAgent('${a.id}')">
         <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 4v4l3 2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>Schedule
       </button>
       <button class="btn btn-ghost btn-sm" onclick="viewAgentRuns('${a.id}')">Runs</button>
       <button class="btn btn-danger btn-sm" onclick="deleteAgent('${a.id}','${esc(a.name)}')">Delete</button>`;

  return `<div class="agent-card ${isCOO ? 'coo' : ''} ${a.status === 'running' ? 'running' : ''}" id="ac-${a.id}">
    <div class="agent-card-header">
      <div class="agent-name">${isCOO ? '<span class="coo-crown">👔</span>' : ''}${esc(a.name)}${isCOO ? ' <span class="lock-badge">Protected</span>' : ''}</div>
      ${statusHtml}
    </div>
    ${a.description ? `<div class="agent-desc">${esc(a.description)}</div>` : ''}
    <div class="agent-meta"><span class="model-tag">${esc(model)}</span>${tags}${channels}${skillChips}</div>
    <div class="agent-actions">${actions}</div>
  </div>`;
}

async function renderAgents() {
  agents = await api(bUrl('/agents'));
  populateAgentSelects();
  const el = document.getElementById('agents-list');
  el.innerHTML = agents.length ? agents.map(agentCard).join('') : '<div class="empty-hint">No agents yet.</div>';
}

function populateAgentSelects() {
  [
    ['run-filter-agent', 'All agents'],
    ['tf-agent',         'Unassigned'],
    ['cf-agent',         'Select agent…'],
    ['sk-owner',         '🌐 Shared — available to all agents'],
    ['im-owner',         '🌐 Shared — available to all agents'],
  ].forEach(([id, placeholder]) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      agents.map(a => `<option value="${a.id}" ${a.id === cur ? 'selected' : ''}>👤 ${esc(a.name)} (private)</option>`).join('');
  });
}

function openCOOChat() { const c = currentCOO(); if (c) openChat(c.id); }

// ── Runs ───────────────────────────────────────────────────────────────────
async function loadRuns() {
  const status  = document.getElementById('run-filter-status')?.value || '';
  const agentId = document.getElementById('run-filter-agent')?.value || '';
  const runs = await api(bUrl(`/runs?limit=60${status ? '&status='+status : ''}${agentId ? '&agentId='+agentId : ''}`));
  const el = document.getElementById('runs-list');
  el.innerHTML = runs.length ? runs.map(runCard).join('') : '<div class="empty-hint">No runs found</div>';
}

function runCard(r) {
  const time = r.finished_at ? `${relTime(r.started_at)} · ${duration(r.started_at, r.finished_at)}` : `Started ${relTime(r.started_at)}`;
  return `<div class="run-card ${r.status}" onclick="openRunDetail('${r.id}')">
    <div class="run-info">
      <div class="run-agent">${r.agent_id === currentCOO()?.id ? '👔 ' : ''}${esc(r.agent_name || 'Agent')}</div>
      <div class="run-prompt">${esc(r.prompt || '')}</div>
    </div>
    <div class="run-time">${time}</div>
    <span class="badge badge-${r.status}">${r.status}</span>
    ${r.status === 'running' ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();stopRun('${r.id}')">Stop</button>` : ''}
  </div>`;
}

function viewAgentRuns(agentId) {
  switchView('activity');
  const s = document.getElementById('run-filter-agent'); if (s) s.value = agentId;
  loadRuns();
}

async function stopRun(runId) { await api('/runs/' + runId + '/stop', { method: 'POST' }); }

async function openRunDetail(runId) {
  currentDetailRunId = runId;
  document.getElementById('detail-modal').classList.remove('hidden');
  await loadRunDetail(runId);
}
async function loadRunDetail(runId) {
  const r = await api('/runs/' + runId);
  document.getElementById('detail-title').textContent = (r.agent_id === currentCOO()?.id ? '👔 ' : '') + (r.agent_name || 'Run');
  document.getElementById('detail-status-badge').innerHTML = `<span class="badge badge-${r.status}">${r.status}</span>`;
  const btn = document.getElementById('detail-stop-btn');
  btn.style.display = r.status === 'running' ? '' : 'none';
  btn.dataset.runId = runId;
  document.getElementById('detail-meta').textContent = [`Triggered: ${r.triggered_by||'ui'}`, `Started: ${fmtTime(r.started_at)}`, r.finished_at ? `Finished: ${fmtTime(r.finished_at)}` : ''].filter(Boolean).join(' · ');
  const box = document.getElementById('detail-output');
  box.textContent = r.output || '(waiting for output…)';
  box.scrollTop = box.scrollHeight;
}
function stopDetailRun() { const id = document.getElementById('detail-stop-btn').dataset.runId; if (id) stopRun(id); }
function closeDetailModal() { currentDetailRunId = null; document.getElementById('detail-modal').classList.add('hidden'); }

function openRunModal(agentId, agentName) {
  document.getElementById('run-modal-title').textContent = `Run: ${agentName}`;
  document.getElementById('run-agent-id').value = agentId;
  document.getElementById('run-prompt').value = '';
  document.getElementById('run-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('run-prompt').focus(), 60);
}
function closeRunModal() { document.getElementById('run-modal').classList.add('hidden'); }
async function submitRun() {
  const agentId = document.getElementById('run-agent-id').value;
  const prompt  = document.getElementById('run-prompt').value.trim();
  if (!prompt) return;
  closeRunModal();
  const { runId } = await api('/runs', { method: 'POST', body: JSON.stringify({ agentId, prompt }) });
  openRunDetail(runId);
}
document.getElementById('run-prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitRun(); });

// ── Agents CRUD ────────────────────────────────────────────────────────────
function showCreateAgent() {
  document.getElementById('modal-title').textContent = 'Create an Agent';
  document.getElementById('save-btn').textContent    = 'Create Agent';
  document.getElementById('agent-form').reset();
  document.getElementById('f-id').value      = '';
  document.getElementById('f-workdir').value = userHomeDir;
  document.getElementById('agent-advanced').style.display = 'none';
  document.getElementById('agent-advanced-toggle').style.display = '';
  document.getElementById('agent-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('f-name').focus(), 60);
}
async function openEditAgent(agentId) {
  const a = await api('/agents/' + agentId);
  document.getElementById('modal-title').textContent = 'Edit Agent';
  document.getElementById('save-btn').textContent    = 'Save Changes';
  document.getElementById('f-id').value          = a.id;
  document.getElementById('f-name').value        = a.name;
  document.getElementById('f-description').value = a.description || '';
  document.getElementById('f-prompt').value      = a.prompt;
  document.getElementById('f-workdir').value     = a.workdir || userHomeDir;
  document.getElementById('f-model').value       = a.model || 'claude-sonnet-4-6';
  document.getElementById('f-telegram').value    = a.telegram_chat_id || '';
  document.getElementById('f-imessage').value    = a.imessage_handle || '';
  document.getElementById('f-tags').value        = JSON.parse(a.tags || '[]').join(', ');
  // Show advanced when editing
  document.getElementById('agent-advanced').style.display = '';
  document.getElementById('agent-advanced-toggle').style.display = 'none';
  document.getElementById('agent-modal').classList.remove('hidden');
}
function closeAgentModal() { document.getElementById('agent-modal').classList.add('hidden'); }
async function saveAgent(e) {
  e.preventDefault();
  const id   = document.getElementById('f-id').value;
  const tags = document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const body = {
    name: document.getElementById('f-name').value.trim(),
    description: document.getElementById('f-description').value.trim(),
    prompt: document.getElementById('f-prompt').value.trim(),
    workdir: document.getElementById('f-workdir').value.trim() || userHomeDir,
    model: document.getElementById('f-model').value,
    telegram_chat_id: document.getElementById('f-telegram').value.trim() || null,
    imessage_handle: document.getElementById('f-imessage').value.trim() || null,
    tags: JSON.stringify(tags),
  };
  await api(id ? '/agents/'+id : '/agents', { method: id ? 'PUT' : 'POST', body: id ? JSON.stringify(body) : bBody(body) });
  closeAgentModal();
  loadDashboard(); renderAgents();
}
async function deleteAgent(agentId, name) {
  if (!confirm(`Delete agent "${name}"? All its runs and chat history will be removed.`)) return;
  try {
    await api('/agents/' + agentId, { method: 'DELETE' });
    loadDashboard(); renderAgents();
  } catch(e) { alert(e.message); }
}

// ── Tasks ──────────────────────────────────────────────────────────────────
async function renderKanban() {
  const tasks = await api(bUrl('/tasks'));
  const byStatus = { todo: [], 'in-progress': [], done: [] };
  tasks.forEach(t => (byStatus[t.status] || byStatus.todo).push(t));
  setText('count-todo', byStatus.todo.length);
  setText('count-inprogress', byStatus['in-progress'].length);
  setText('count-done', byStatus.done.length);
  document.getElementById('cards-todo').innerHTML       = byStatus.todo.length       ? byStatus.todo.map(taskCard).join('') : '<div class="empty-hint">No tasks</div>';
  document.getElementById('cards-inprogress').innerHTML = byStatus['in-progress'].length ? byStatus['in-progress'].map(taskCard).join('') : '<div class="empty-hint">No tasks</div>';
  document.getElementById('cards-done').innerHTML       = byStatus.done.length       ? byStatus.done.map(taskCard).join('') : '<div class="empty-hint">No tasks</div>';
}
function taskCard(t) {
  const canStart = t.agent_id && t.status !== 'in-progress';
  const canDone  = t.status === 'in-progress';
  return `<div class="task-card" onclick="openEditTask('${t.id}')">
    <div class="task-card-title">${esc(t.title)}</div>
    ${t.description ? `<div class="task-card-desc">${esc(t.description)}</div>` : ''}
    <div class="task-card-footer">
      <span class="priority-dot p-${t.priority}"></span>
      <span class="priority-label pl-${t.priority}">${t.priority}</span>
      ${t.agent_name ? `<span class="agent-chip">${t.agent_id === currentCOO()?.id ? '👔 ' : ''}${esc(t.agent_name)}</span>` : ''}
    </div>
    <div class="task-card-actions" onclick="event.stopPropagation()">
      ${canStart ? `<button class="btn btn-green btn-sm" onclick="startTask('${t.id}')">▶ Start</button>` : ''}
      ${canDone  ? `<button class="btn btn-ghost btn-sm" onclick="markTaskDone('${t.id}')">✓ Done</button>` : ''}
      ${t.status === 'done' ? `<button class="btn btn-ghost btn-sm" onclick="archiveTask('${t.id}')">📦 Archive</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="openEditTask('${t.id}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteTask('${t.id}')">Delete</button>
    </div>
  </div>`;
}
async function showNewTask() {
  if (!agents.length) agents = await api(bUrl('/agents'));
  populateAgentSelects();
  document.getElementById('task-modal-title').textContent = 'New Task';
  document.getElementById('task-save-btn').textContent    = 'Create Task';
  document.getElementById('task-form').reset();
  document.getElementById('tf-id').value = '';
  document.getElementById('task-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('tf-title').focus(), 60);
}
async function openEditTask(taskId) {
  if (!agents.length) agents = await api(bUrl('/agents'));
  populateAgentSelects();
  const t = await api('/tasks/' + taskId);
  document.getElementById('task-modal-title').textContent = 'Edit Task';
  document.getElementById('task-save-btn').textContent    = 'Save Changes';
  document.getElementById('tf-id').value          = t.id;
  document.getElementById('tf-title').value       = t.title;
  document.getElementById('tf-description').value = t.description || '';
  document.getElementById('tf-agent').value       = t.agent_id || '';
  document.getElementById('tf-priority').value    = t.priority || 'medium';
  document.getElementById('tf-notes').value       = t.notes || '';
  document.getElementById('task-modal').classList.remove('hidden');
}
function closeTaskModal() { document.getElementById('task-modal').classList.add('hidden'); }
async function saveTask(e) {
  e.preventDefault();
  const id   = document.getElementById('tf-id').value;
  const body = {
    title:       document.getElementById('tf-title').value.trim(),
    description: document.getElementById('tf-description').value.trim(),
    agent_id:    document.getElementById('tf-agent').value || null,
    priority:    document.getElementById('tf-priority').value,
    notes:       document.getElementById('tf-notes').value.trim(),
  };
  if (id) body.status = (await api('/tasks/'+id)).status;
  await api(id ? '/tasks/'+id : '/tasks', { method: id ? 'PUT' : 'POST', body: id ? JSON.stringify(body) : bBody(body) });
  closeTaskModal(); renderKanban(); refreshActiveTasks(); refreshStats();
}
async function startTask(id)     { await api('/tasks/'+id+'/start', { method: 'POST' }); renderKanban(); refreshActiveTasks(); refreshActiveRuns(); }
async function markTaskDone(id)  { const t = await api('/tasks/'+id); await api('/tasks/'+id, { method:'PUT', body: JSON.stringify({...t, status:'done'}) }); renderKanban(); }
async function deleteTask(id)    { if (!confirm('Delete this task?')) return; await api('/tasks/'+id, { method:'DELETE' }); renderKanban(); refreshStats(); }

// ── Cron Skill Picker ─────────────────────────────────────────────────────
let cronSelectedSkills = new Set();
async function populateCronSkills() {
  const el = document.getElementById('cf-skills');
  try {
    const allSkills = await api(bUrl('/skills'));
    const shared = allSkills.filter(s => !s.owner_agent_id && s.active !== false);
    if (!shared.length) { el.innerHTML = '<span class="skill-picker-empty">No shared skills available</span>'; return; }
    el.innerHTML = shared.map(s =>
      `<span class="skill-chip ${cronSelectedSkills.has(s.id) ? 'selected' : ''}" data-skill-id="${s.id}">` +
      `<span class="chip-icon">${cronSelectedSkills.has(s.id) ? '✓' : '◇'}</span>${esc(s.name)}</span>`
    ).join('');
  } catch(_) { el.innerHTML = '<span class="skill-picker-empty">Could not load skills</span>'; }
}

// ── Schedule Presets & Preview ─────────────────────────────────────────────
// Listeners attach to #cron-form (inside the .modal div that calls stopPropagation).
(function initSchedulePresets() {
  const form = document.getElementById('cron-form');
  if (!form) return;
  form.addEventListener('click', e => {
    // Preset buttons
    const btn = e.target.closest('.preset-btn');
    if (btn) {
      const input = document.getElementById('cf-schedule');
      input.value = btn.dataset.val;
      form.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      previewSchedule(btn.dataset.val);
      return;
    }
    // Skill chips
    const chip = e.target.closest('.skill-chip');
    if (chip && chip.closest('#cf-skills')) {
      const sid = chip.dataset.skillId;
      if (cronSelectedSkills.has(sid)) { cronSelectedSkills.delete(sid); } else { cronSelectedSkills.add(sid); }
      chip.classList.toggle('selected');
      chip.querySelector('.chip-icon').textContent = cronSelectedSkills.has(sid) ? '✓' : '◇';
    }
  });
  const schedInput = document.getElementById('cf-schedule');
  if (schedInput) {
    schedInput.addEventListener('input', function() {
      clearTimeout(this._previewTimer);
      const val = this.value.trim();
      form.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.val === val));
      this._previewTimer = setTimeout(() => previewSchedule(val), 300);
    });
  }
})();
let _lastPreview = '';
async function previewSchedule(val) {
  const el = document.getElementById('schedule-preview');
  if (!val) { el.classList.add('hidden'); _lastPreview = ''; return; }
  if (val === _lastPreview) return;
  _lastPreview = val;
  try {
    const r = await api('/crons/preview', { method: 'POST', body: JSON.stringify({ schedule: val }) });
    el.classList.remove('hidden');
    if (r.valid) {
      const next = r.nextRun ? new Date(r.nextRun) : null;
      const nextStr = next ? `Next run: ${next.toLocaleDateString()} ${next.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : '';
      el.className = 'schedule-preview valid';
      el.innerHTML = `<span class="preview-icon">✓</span> ${esc(r.description)}${nextStr ? `<span class="preview-next">${nextStr}</span>` : ''}`;
    } else {
      el.className = 'schedule-preview invalid';
      el.innerHTML = `<span class="preview-icon">✗</span> ${esc(r.error)}`;
    }
  } catch(_) { el.classList.add('hidden'); }
}

// ── Schedules ──────────────────────────────────────────────────────────────
let allSkillsCache = [];
async function loadSchedules() {
  if (!agents.length) agents = await api(bUrl('/agents'));
  populateAgentSelects();
  try { allSkillsCache = await api(bUrl('/skills')); } catch(_) { allSkillsCache = []; }
  const crons = await api(bUrl('/crons'));
  const el = document.getElementById('schedules-list');
  if (!crons.length) { el.innerHTML = '<div class="empty-hint">No schedules yet. Use "+ New Schedule" or ask the COO to set one up.</div>'; return; }
  el.innerHTML = crons.map(cronCard).join('');
}
function cronCard(c) {
  const skillBadges = (c.skill_ids || []).length
    ? `<div class="schedule-skills-badges">${c.skill_ids.map(sid => {
        const s = allSkillsCache.find(x => x.id === sid);
        return `<span class="skill-badge">${esc(s ? s.name : sid.slice(0,6))}</span>`;
      }).join('')}</div>` : '';
  return `<div class="schedule-card ${c.enabled ? '' : 'disabled'}">
    <div class="schedule-icon">⏰</div>
    <div class="schedule-info">
      <div class="schedule-name">${esc(c.name)}</div>
      <div class="schedule-meta">${esc(c.agent_name || c.agent_id)} · <strong>${esc(c.schedule)}</strong>${c.last_run ? ` · last ran ${relTime(c.last_run)}` : ''}</div>
      <div class="schedule-prompt">${esc(c.prompt)}</div>
      ${skillBadges}
    </div>
    <div class="schedule-actions">
      <button class="btn btn-ghost btn-sm" onclick="runCronNow('${c.id}')">▶ Run now</button>
      <button class="btn btn-ghost btn-sm" onclick="toggleCron('${c.id}', ${!c.enabled})">${c.enabled ? 'Pause' : 'Enable'}</button>
      <button class="btn btn-ghost btn-sm" onclick="editCron('${c.id}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteCron('${c.id}')">Delete</button>
    </div>
  </div>`;
}
async function showNewCron() {
  if (!agents.length) agents = await api(bUrl('/agents'));
  populateAgentSelects();
  document.getElementById('cron-modal-title').textContent = 'New Schedule';
  document.getElementById('cron-save-btn').textContent    = 'Create Schedule';
  document.getElementById('cron-form').reset();
  document.getElementById('cf-id').value = '';
  document.getElementById('cf-enabled').checked = true;
  document.getElementById('schedule-preview').classList.add('hidden');
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('cf-prompt').style.display = '';
  _lastPreview = '';
  cronSelectedSkills = new Set();
  populateCronSkills();
  document.getElementById('cron-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('cf-name').focus(), 60);
}
async function showNewCronForAgent(agentId) {
  await showNewCron();
  document.getElementById('cf-agent').value = agentId;
}
async function editCron(cronId) {
  if (!agents.length) agents = await api(bUrl('/agents'));
  populateAgentSelects();
  const c = (await api(bUrl('/crons'))).find(x => x.id === cronId);
  if (!c) return;
  document.getElementById('cron-modal-title').textContent = 'Edit Schedule';
  document.getElementById('cron-save-btn').textContent    = 'Save Changes';
  document.getElementById('cf-id').value       = c.id;
  document.getElementById('cf-name').value     = c.name;
  document.getElementById('cf-agent').value    = c.agent_id;
  document.getElementById('cf-schedule').value = c.schedule;
  document.getElementById('cf-prompt').value   = c.prompt;
  document.getElementById('cf-prompt').style.display = '';
  document.getElementById('cf-enabled').checked = c.enabled;
  document.querySelectorAll('.prompt-preset').forEach(b => b.classList.remove('active'));
  cronSelectedSkills = new Set(c.skill_ids || []);
  populateCronSkills();
  document.getElementById('cron-modal').classList.remove('hidden');
  _lastPreview = '';
  previewSchedule(c.schedule);
}
function closeCronModal() { document.getElementById('cron-modal').classList.add('hidden'); }

function setCronPromptPreset(btn) {
  document.querySelectorAll('.prompt-preset').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const val = btn.dataset.val;
  const textarea = document.getElementById('cf-prompt');
  if (val) {
    textarea.value = val;
    textarea.style.display = 'none';
  } else {
    textarea.value = '';
    textarea.style.display = '';
    textarea.focus();
  }
}
async function saveCron(e) {
  e.preventDefault();
  const id   = document.getElementById('cf-id').value;
  const body = {
    agentId:  document.getElementById('cf-agent').value,
    name:     document.getElementById('cf-name').value.trim(),
    schedule: document.getElementById('cf-schedule').value.trim(),
    prompt:   document.getElementById('cf-prompt').value.trim(),
    enabled:  document.getElementById('cf-enabled').checked,
    skillIds: [...cronSelectedSkills],
  };
  try {
    await api(id ? '/crons/'+id : '/crons', { method: id ? 'PUT' : 'POST', body: id ? JSON.stringify(body) : bBody(body) });
    closeCronModal(); loadSchedules(); refreshStats();
  } catch(e) {
    const el = document.getElementById('schedule-preview');
    el.classList.remove('hidden');
    el.className = 'schedule-preview invalid';
    el.innerHTML = `<span class="preview-icon">✗</span> ${esc(e.message)}`;
  }
}
async function toggleCron(id, enabled) { await api('/crons/'+id, { method:'PUT', body: JSON.stringify({enabled}) }); loadSchedules(); }
async function runCronNow(id) {
  const { runId } = await api('/crons/'+id+'/run-now', { method:'POST' });
  openRunDetail(runId);
}
async function deleteCron(id) { if (!confirm('Delete this schedule?')) return; await api('/crons/'+id, { method:'DELETE' }); loadSchedules(); refreshStats(); }

// ── Chat ───────────────────────────────────────────────────────────────────
async function openChat(agentId) {
  const agent = agents.find(a => a.id === agentId) || await api('/agents/' + agentId);
  const isCOO = !!agent.protected;
  currentChatAgentId = agentId;
  chatIsStreaming = false;
  const letter = agent.name.charAt(0).toUpperCase();
  document.getElementById('chat-avatar').textContent     = letter;
  document.getElementById('chat-agent-name').textContent = agent.name;
  document.getElementById('chat-agent-role').textContent = agent.description || agent.model || '';
  document.getElementById('chat-agent-id').value         = agentId;
  document.getElementById('chat-input').value            = '';
  updateChatSendBtn();

  // COO special placeholder text
  if (isCOO) {
    document.getElementById('chat-input').placeholder = 'Tell the COO what you need done… (e.g. "Hire a Python developer agent and assign them the scraper task")';
  } else {
    document.getElementById('chat-input').placeholder = 'Message… (Enter to send, Shift+Enter for new line)';
  }

  const { messages } = await api('/agents/' + agentId + '/chat');
  const container = document.getElementById('chat-messages');
  if (!messages.length) {
    const welcome = isCOO
      ? `I'm your COO. Tell me what needs to get done — I'll hire the right agents, assign tasks, and keep things moving. What are we working on?`
      : `Hi! I'm ${esc(agent.name)}. ${esc(agent.description || 'How can I help you today?')}`;
    container.innerHTML = `<div class="chat-welcome" id="chat-welcome">
      <div class="chat-welcome-avatar">${letter}</div><p>${welcome}</p></div>`;
  } else {
    container.innerHTML = '';
    messages.forEach(m => addChatBubble(m, false));
  }
  document.getElementById('chat-modal').classList.remove('hidden');
  scrollChatToBottom();
  setTimeout(() => document.getElementById('chat-input').focus(), 60);
}
function closeChatModal() { document.getElementById('chat-modal').classList.add('hidden'); currentChatAgentId = null; }

function addChatBubble(msg, scroll = true) {
  const welcome = document.getElementById('chat-welcome');
  if (welcome) welcome.remove();
  const container = document.getElementById('chat-messages');
  const wrapper   = document.createElement('div');
  wrapper.className = `chat-msg ${msg.role}`;
  const av = document.createElement('div');
  av.className = `msg-avatar ${msg.role === 'user' ? 'user-av' : 'agent-av'}`;
  av.textContent = msg.role === 'user' ? 'Y' : (agents.find(a => a.id === currentChatAgentId)?.name || 'A').charAt(0).toUpperCase();
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble' + (msg.streaming ? ' streaming' : '');
  bubble.id = 'msg-' + msg.id;
  bubble.textContent = msg.content || '';
  if (msg.role === 'user') { wrapper.appendChild(bubble); wrapper.appendChild(av); }
  else                     { wrapper.appendChild(av);     wrapper.appendChild(bubble); }
  container.appendChild(wrapper);
  if (scroll) scrollChatToBottom();
  return bubble;
}

async function sendChat() {
  if (chatIsStreaming) return;
  const input   = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || !currentChatAgentId) return;
  input.value = '';
  chatIsStreaming = true; updateChatSendBtn();
  addChatBubble({ id: 'u-'+Date.now(), role: 'user', content: message });
  const tempId = 'tmp-'+Date.now();
  addChatBubble({ id: tempId, role: 'assistant', content: '', streaming: true });
  try {
    const { messageId } = await api('/agents/'+currentChatAgentId+'/chat', { method:'POST', body: JSON.stringify({ message }) });
    const ph = document.getElementById('msg-'+tempId);
    if (ph && messageId) ph.id = 'msg-'+messageId;
  } catch(err) {
    chatIsStreaming = false; updateChatSendBtn();
    const ph = document.getElementById('msg-'+tempId);
    if (ph) { ph.textContent = 'Error: '+err.message; ph.classList.remove('streaming'); }
  }
}
async function clearChat() {
  if (!currentChatAgentId || !confirm('Clear all messages?')) return;
  await api('/agents/'+currentChatAgentId+'/chat', { method:'DELETE' });
  const agent = agents.find(a => a.id === currentChatAgentId);
  const letter = (agent?.name || 'A').charAt(0).toUpperCase();
  document.getElementById('chat-messages').innerHTML = `<div class="chat-welcome" id="chat-welcome">
    <div class="chat-welcome-avatar">${letter}</div>
    <p>Conversation cleared. How can I help?</p></div>`;
}
function updateChatSendBtn() {
  document.getElementById('chat-send-btn').disabled   = chatIsStreaming;
  document.getElementById('chat-input').disabled      = chatIsStreaming;
}
function scrollChatToBottom() { const c = document.getElementById('chat-messages'); if (c) c.scrollTop = c.scrollHeight; }
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

// ── Skills ─────────────────────────────────────────────────────────────────
async function loadSkillsView() {
  [allSkills, agents] = await Promise.all([api(bUrl('/skills')), api(bUrl('/agents'))]);
  populateAgentSelects();
  renderSkillsSidebar();
  if (activeSkillId) openSkill(activeSkillId);
  else resetEditorPanel();
}

function resetEditorPanel() {
  document.getElementById('skills-editor-panel').innerHTML = `
    <div class="skills-empty-state">
      <div style="font-size:48px;margin-bottom:12px">📄</div>
      <p>Select a skill to view or edit it</p>
      <p style="font-size:12px;color:var(--text-dim);margin-top:6px">Skills are injected into agents before every run</p>
    </div>`;
}

const skillFolderState = {}; // label -> open/closed

function toggleSkillFolder(label, gid) {
  const items = document.getElementById(gid);
  const chev = document.getElementById('chev-' + gid);
  const isOpen = !items.classList.contains('collapsed');
  items.classList.toggle('collapsed', isOpen);
  chev.classList.toggle('open', !isOpen);
  skillFolderState[label] = !isOpen;
}

function renderSkillsSidebar() {
  const sidebar = document.getElementById('skills-sidebar');
  if (!allSkills.length) {
    sidebar.innerHTML = '<div class="empty-hint" style="padding:20px">No skills yet</div>';
    return;
  }

  // Split into shared and agent-owned
  const shared = allSkills.filter(s => !s.owner_agent_id);
  const owned  = allSkills.filter(s => s.owner_agent_id);

  // Group shared skills by folder
  const sharedNoFolder = shared.filter(s => !s.folder);
  const sharedByFolder = {};
  for (const s of shared.filter(s => s.folder)) {
    if (!sharedByFolder[s.folder]) sharedByFolder[s.folder] = [];
    sharedByFolder[s.folder].push(s);
  }

  // Group owned by agent
  const byAgent = {};
  for (const s of owned) {
    const agentName = agents.find(a => a.id === s.owner_agent_id)?.name || s.owner_agent_id.slice(0,8);
    if (!byAgent[agentName]) byAgent[agentName] = [];
    byAgent[agentName].push(s);
  }

  function skillRows(list) {
    return list.map(s => `
      <div class="skill-row ${s.id === activeSkillId ? 'active' : ''} ${!s.active ? 'skill-row-pending' : ''}" onclick="openSkill('${s.id}')" id="srow-${s.id}">
        <span class="skill-row-icon">${s.type === 'folder' ? '📁' : s.type === 'file' ? '🔗' : '📄'}</span>
        <span class="skill-row-name">${esc(s.name)}</span>
        ${!s.active ? `<span class="skill-type-badge skill-pending-badge">🔒</span>` : ''}
      </div>`).join('');
  }

  let groupIdx = 0;
  function collapsibleGroup(icon, label, list, startOpen = true) {
    const gid = 'sg-' + (groupIdx++);
    const isOpen = skillFolderState[label] !== undefined ? skillFolderState[label] : startOpen;
    return `<div class="skills-folder-group">
      <div class="skills-folder-label" onclick="toggleSkillFolder('${esc(label)}','${gid}')" style="cursor:pointer;user-select:none">
        <span class="folder-chevron ${isOpen ? 'open' : ''}" id="chev-${gid}">▸</span>
        ${icon} ${esc(label)}
        <span class="folder-count">${list.length}</span>
      </div>
      <div class="folder-items ${isOpen ? '' : 'collapsed'}" id="${gid}">
        ${skillRows(list)}
      </div>
    </div>`;
  }

  let html = '';

  // Shared skills without a folder
  if (sharedNoFolder.length) {
    html += collapsibleGroup('', 'Shared', sharedNoFolder, true);
  }

  // Shared skills grouped by folder
  for (const [folder, skills] of Object.entries(sharedByFolder).sort()) {
    const folderDisplay = folder.charAt(0).toUpperCase() + folder.slice(1);
    html += collapsibleGroup('📂', folderDisplay, skills, false);
  }

  // Agent-owned skills
  for (const [agentName, skills] of Object.entries(byAgent).sort()) {
    html += collapsibleGroup('👤', agentName, skills, true);
  }

  sidebar.innerHTML = html || '<div class="empty-hint" style="padding:20px">No skills yet</div>';
}

async function openSkill(skillId) {
  activeSkillId = skillId;
  document.querySelectorAll('.skill-row').forEach(r => r.classList.remove('active'));
  const row = document.getElementById('srow-' + skillId);
  if (row) row.classList.add('active');

  const skill = await api('/skills/' + skillId);
  const ownerAgent = skill.owner_agent_id ? agents.find(a => a.id === skill.owner_agent_id) : null;

  // Agents that use this skill (owned = the owner, shared = all assigned)
  let usedBy;
  if (ownerAgent) {
    usedBy = [ownerAgent];
  } else {
    usedBy = agents.filter(a => (a.skill_ids || []).includes(skillId));
  }

  const scopeBadge = !skill.active
    ? `<span class="skill-scope-badge scope-pending">🔒 Needs Activation</span>`
    : ownerAgent
      ? `<span class="skill-scope-badge scope-private">Private · ${esc(ownerAgent.name)}</span>`
      : `<span class="skill-scope-badge scope-shared">Shared</span>`;

  document.getElementById('skills-editor-panel').innerHTML = `
    <div class="skill-editor-header">
      <div>
        <div class="skill-editor-title">
          ${skill.type === 'folder' ? '📁' : skill.type === 'file' ? '🔗' : '📄'} ${esc(skill.name)}
          ${scopeBadge}
        </div>
        <div class="skill-editor-meta">${esc(skill.description || '')}${skill.file_path ? ` · <code>${esc(skill.file_path)}</code>` : ''}</div>
      </div>
      <div class="skill-editor-actions">
        ${!skill.active ? `<button class="btn btn-primary btn-sm" onclick="showActivateSkill('${skill.id}','${esc(skill.name)}')">🔓 Activate</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="editSkill('${skill.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSkill('${skill.id}','${esc(skill.name)}')">Delete</button>
      </div>
    </div>
    <div class="skill-content-view">${esc(skill.content || '(empty)')}</div>
    <div class="skill-agents-bar">
      <span>${ownerAgent ? 'Owner:' : 'Used by:'}</span>
      ${usedBy.length
        ? usedBy.map(a => `<span class="skill-agent-chip">${esc(a.name)}</span>`).join('')
        : '<span style="color:var(--text-dim)">No agents yet</span>'}
    </div>`;
}

// skill-modal now has a scope selector — shared vs private to agent
function showNewSkill(defaultOwnerAgentId = null) {
  document.getElementById('skill-modal-title').textContent = 'Create a Skill';
  document.getElementById('skill-form').reset();
  document.getElementById('sk-id').value = '';
  document.getElementById('sk-owner').value = defaultOwnerAgentId || '';
  document.getElementById('sk-advanced').style.display = 'none';
  document.getElementById('sk-advanced-toggle').style.display = '';
  document.getElementById('skill-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('sk-name').focus(), 60);
}

function showNewSkillForAgent(agentId) { showNewSkill(agentId); }

async function editSkill(skillId) {
  const s = await api('/skills/' + skillId);
  document.getElementById('skill-modal-title').textContent = 'Edit Skill';
  document.getElementById('sk-id').value            = s.id;
  document.getElementById('sk-name').value          = s.name;
  document.getElementById('sk-folder').value        = s.folder || '';
  document.getElementById('sk-description').value   = s.description || '';
  document.getElementById('sk-content').value       = s.content || '';
  document.getElementById('sk-owner').value         = s.owner_agent_id || '';
  // Show advanced if folder is set
  if (s.folder) {
    document.getElementById('sk-advanced').style.display = '';
    document.getElementById('sk-advanced-toggle').style.display = 'none';
  } else {
    document.getElementById('sk-advanced').style.display = 'none';
    document.getElementById('sk-advanced-toggle').style.display = '';
  }
  document.getElementById('skill-modal').classList.remove('hidden');
}

function closeSkillModal() { document.getElementById('skill-modal').classList.add('hidden'); }

async function saveSkill(e) {
  e.preventDefault();
  const id = document.getElementById('sk-id').value;
  const body = {
    name:           document.getElementById('sk-name').value.trim(),
    folder:         document.getElementById('sk-folder').value.trim(),
    description:    document.getElementById('sk-description').value.trim(),
    content:        document.getElementById('sk-content').value,
    type:           'inline',
    owner_agent_id: document.getElementById('sk-owner').value || null,
  };
  const saved = await api(id ? '/skills/'+id : '/skills', { method: id ? 'PUT' : 'POST', body: id ? JSON.stringify(body) : bBody(body) });
  closeSkillModal();
  allSkills = await api(bUrl('/skills'));
  renderSkillsSidebar();
  openSkill(saved.id);
}

async function deleteSkill(skillId, name) {
  if (!confirm(`Delete skill "${name}"?`)) return;
  await api('/skills/'+skillId, { method:'DELETE' });
  if (activeSkillId === skillId) { activeSkillId = null; resetEditorPanel(); }
  allSkills = await api(bUrl('/skills'));
  renderSkillsSidebar();
}

// ── Import file/folder skill ────────────────────────────────────────────────
async function showImportSkill(defaultOwnerAgentId = null) {
  document.getElementById('im-path').value    = '';
  document.getElementById('im-name').value    = '';
  document.getElementById('im-folder').value  = '';
  document.getElementById('im-owner').value   = defaultOwnerAgentId || '';
  document.getElementById('import-modal').classList.remove('hidden');
  await browseTo(userHomeDir);
}

async function browseTo(dir) {
  fileBrowserPath = dir;
  document.getElementById('fb-path').textContent = dir;
  const { entries } = await api('/browse?path=' + encodeURIComponent(dir));
  const parent = dir.split('/').slice(0,-1).join('/') || '/';
  const html = [
    dir !== '/' ? `<div class="fb-entry dir" onclick="browseTo('${esc(parent)}')"><span class="fb-entry-icon">⬆️</span> ..</div>` : '',
    ...entries.map(e => `
      <div class="fb-entry ${e.isDir ? 'dir' : 'md'}" onclick="${e.isDir ? `browseTo('${esc(e.path)}')` : `selectFile('${esc(e.path)}')`}">
        <span class="fb-entry-icon">${e.isDir ? '📁' : '📄'}</span> ${esc(e.name)}
      </div>`),
  ].join('');
  document.getElementById('fb-entries').innerHTML = html || '<div style="padding:12px;color:var(--text-dim)">No .md files here</div>';
}

function selectFile(filePath) {
  document.getElementById('im-path').value = filePath;
  const name = filePath.split('/').pop().replace(/\.(md|txt)$/, '');
  if (!document.getElementById('im-name').value) document.getElementById('im-name').value = name;
  document.getElementById('im-type').value = 'file';
}

async function saveImportSkill() {
  const filePath = document.getElementById('im-path').value.trim();
  const name     = document.getElementById('im-name').value.trim();
  const type     = document.getElementById('im-type').value;
  const folder   = document.getElementById('im-folder').value.trim();
  const owner    = document.getElementById('im-owner').value || null;
  if (!filePath || !name) return alert('Path and name are required');
  const saved = await api('/skills', { method:'POST', body: bBody({
    name, type, file_path: filePath, folder,
    description: `Linked ${type}: ${filePath}`,
    owner_agent_id: owner,
  })});
  document.getElementById('import-modal').classList.add('hidden');
  allSkills = await api(bUrl('/skills'));
  renderSkillsSidebar();
  openSkill(saved.id);
}

// ── Assign shared skills to agent ───────────────────────────────────────────
async function openAssignSkills(agentId, agentName) {
  allSkills = await api(bUrl('/skills'));
  const agent = agents.find(a => a.id === agentId) || await api('/agents/'+agentId);
  assignSelectedIds = new Set(agent.skill_ids || []);

  document.getElementById('assign-agent-id').value = agentId;
  document.getElementById('assign-modal-title').textContent = `Skills for ${agentName}`;
  renderAssignList(agentId);
  document.getElementById('assign-modal').classList.remove('hidden');
}

function renderAssignList(agentId) {
  const el = document.getElementById('assign-skill-list');

  // Private skills (owned by this agent) — always on, shown separately
  const privateSkills = allSkills.filter(s => s.owner_agent_id === agentId);
  // Shared skills — can be toggled
  const sharedSkills  = allSkills.filter(s => !s.owner_agent_id);

  let html = '';

  if (privateSkills.length) {
    html += `<div class="assign-section-label">Private to this agent (always included)</div>`;
    html += privateSkills.map(s => `
      <div class="assign-skill-row selected locked">
        <div class="assign-skill-check locked-check">🔒</div>
        <div>
          <div class="assign-skill-name">${s.type === 'folder' ? '📁' : s.type === 'file' ? '🔗' : '📄'} ${esc(s.name)}</div>
          <div class="assign-skill-desc">${esc(s.description || '')}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="editSkill('${s.id}')">Edit</button>
      </div>`).join('');
  }

  if (sharedSkills.length) {
    html += `<div class="assign-section-label" style="margin-top:12px">Shared skills (pick any)</div>`;
    html += sharedSkills.map(s => {
      const sel = assignSelectedIds.has(s.id);
      return `<div class="assign-skill-row ${sel ? 'selected' : ''}" onclick="toggleAssignSkill('${s.id}')">
        <div class="assign-skill-check"></div>
        <div>
          <div class="assign-skill-name">${s.type === 'folder' ? '📁' : s.type === 'file' ? '🔗' : '📄'} ${esc(s.name)}</div>
          <div class="assign-skill-desc">${esc(s.description || '')}</div>
        </div>
      </div>`;
    }).join('');
  }

  if (!privateSkills.length && !sharedSkills.length) {
    html = '<div class="empty-hint">No skills yet — create some in the Skills tab</div>';
  }

  el.innerHTML = html;
}

function toggleAssignSkill(skillId) {
  if (assignSelectedIds.has(skillId)) assignSelectedIds.delete(skillId);
  else assignSelectedIds.add(skillId);
  const agentId = document.getElementById('assign-agent-id').value;
  renderAssignList(agentId);
}

async function saveAssignSkills() {
  const agentId = document.getElementById('assign-agent-id').value;
  // Only save shared skill selections (private ones are auto-included by runner)
  const sharedOnly = [...assignSelectedIds].filter(id => {
    const s = allSkills.find(x => x.id === id);
    return s && !s.owner_agent_id;
  });
  await api('/agents/'+agentId+'/skills', { method:'PUT', body: JSON.stringify({ skill_ids: sharedOnly }) });
  agents = await api(bUrl('/agents'));
  closeAssignModal();
  const card = document.getElementById('ac-'+agentId);
  if (card) { const a = agents.find(x => x.id === agentId); if (a) card.outerHTML = agentCard(a); }
}

function closeAssignModal() { document.getElementById('assign-modal').classList.add('hidden'); }

// ── Toast Notifications ────────────────────────────────────────────────────
function showToast(html, type = 'info', duration = 6000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = html;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.onclick = () => t.remove();
  t.appendChild(close);
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, duration);
}

// ── Office View ─────────────────────────────────────────────────────────────
async function loadOfficeView() {
  const [agentList, runs, chattingIds] = await Promise.all([
    api(bUrl('/agents')),
    api(bUrl('/runs?status=running&limit=20')),
    api('/chatting'),
  ]);
  agents = agentList;
  const activeRunsByAgent = {};
  for (const r of runs) activeRunsByAgent[r.agent_id] = r;
  const chattingSet = new Set(chattingIds);

  const el = document.getElementById('office-floor');
  if (!el) return;

  if (!agentList.length) {
    el.innerHTML = `<div class="office-empty">
      <div style="font-size:64px;margin-bottom:16px">🏢</div>
      <h3>The office is empty</h3>
      <p>Create some agents and they'll show up here at their desks.</p>
      <button class="btn btn-primary" style="margin-top:16px" onclick="showCreateAgent()">Hire your first agent</button>
    </div>`;
    return;
  }

  el.innerHTML = agentList.map(a => {
    const run = activeRunsByAgent[a.id];
    const isChatting = chattingSet.has(a.id);
    const isWorking = !!run || a.status === 'running' || isChatting;
    const task = run ? run.prompt : isChatting ? 'Chatting…' : null;
    return deskCard(a, isWorking, task, isChatting);
  }).join('');
}

function deskCard(agent, isWorking, currentTask, isChatting = false) {
  const initial  = (agent.name || 'A').charAt(0).toUpperCase();
  const isCOO    = !!agent.protected;
  const statusTxt = isChatting ? 'Chatting' : isWorking ? 'Working' : 'Available';
  const taskSnip  = currentTask ? currentTask.slice(0, 60) + (currentTask.length > 60 ? '…' : '') : '';

  const liveText = agentLiveOutput[agent.id] || '';
  const screenContent = isWorking
    ? (liveText
        ? `<div class="screen-live" id="screen-${agent.id}">${esc(liveText.slice(-200))}</div>`
        : `<div class="screen-lines"><span></span><span></span><span></span></div>`)
    : `<div class="screen-idle">···</div>`;

  return `<div class="desk-card ${isWorking ? 'working' : 'idle'}" onclick="${isCOO ? `openCOOChat()` : `openChat('${agent.id}')`}" title="Chat with ${esc(agent.name)}">
    <div class="desk-monitor">
      <div class="desk-screen ${isWorking ? 'screen-active' : ''}">
        ${screenContent}
      </div>
    </div>
    <div class="desk-person">
      <div class="desk-head ${isWorking ? 'head-working' : 'head-idle'}">${isCOO ? '👔' : initial}</div>
      <div class="desk-body"></div>
      ${isWorking ? `<div class="desk-typing"><span></span><span></span><span></span></div>` : ''}
    </div>
    <div class="desk-surface"></div>
    <div class="desk-info">
      <div class="desk-name">${esc(agent.name)}${isCOO ? ' <span class="desk-coo-tag">COO</span>' : ''}</div>
      <div class="desk-status ${isChatting ? 'status-chatting' : isWorking ? 'status-working' : 'status-idle'}">
        <span class="desk-dot"></span>${statusTxt}
      </div>
      ${taskSnip ? `<div class="desk-task">"${esc(taskSnip)}"</div>` : ''}
    </div>
  </div>`;
}

function updateDeskScreen(agentId) {
  if (!document.getElementById('view-office')?.classList.contains('active')) return;
  const text = agentLiveOutput[agentId] || '';
  let el = document.getElementById('screen-' + agentId);
  if (!el) {
    // Screen doesn't have a live element yet — find the monitor and swap it in
    const cards = document.querySelectorAll('.desk-card');
    for (const card of cards) {
      if (card.getAttribute('onclick')?.includes(agentId)) {
        const screen = card.querySelector('.desk-screen');
        if (screen) {
          screen.innerHTML = `<div class="screen-live" id="screen-${agentId}"></div>`;
          screen.classList.add('screen-active');
          el = document.getElementById('screen-' + agentId);
        }
        break;
      }
    }
  }
  if (el) {
    el.textContent = text.slice(-200);
    el.scrollTop = el.scrollHeight;
  }
}

// ── Task Archive ────────────────────────────────────────────────────────────
let showingArchive = false;

function toggleArchiveView() {
  showingArchive = !showingArchive;
  document.getElementById('kanban').style.display       = showingArchive ? 'none' : '';
  document.getElementById('archive-panel').style.display = showingArchive ? '' : 'none';
  document.getElementById('archive-toggle-btn').textContent = showingArchive ? '← Back to Board' : '📦 Archive';
  if (showingArchive) loadArchive();
}

async function loadArchive() {
  const tasks = await api(bUrl('/tasks?archived=true'));
  const el = document.getElementById('archive-list');
  if (!tasks.length) {
    el.innerHTML = '<div class="empty-hint">No archived tasks yet. Completed tasks will appear here.</div>';
    return;
  }
  el.innerHTML = tasks.map(t => `
    <div class="archive-row">
      <div class="archive-row-left">
        <span class="priority-dot p-${t.priority}"></span>
        <div>
          <div class="archive-title">${esc(t.title)}</div>
          ${t.agent_name ? `<div class="archive-meta">Done by ${esc(t.agent_name)} · ${fmtDate(t.updated_at)}</div>` : `<div class="archive-meta">${fmtDate(t.updated_at)}</div>`}
        </div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteTask('${t.id}')">Delete</button>
    </div>`).join('');
}

async function archiveTask(id) {
  await api('/tasks/'+id+'/archive', { method: 'POST' });
  renderKanban();
  showToast('📦 Task archived', 'info', 3000);
}

// ── Skill Activation ────────────────────────────────────────────────────────
function showActivateSkill(skillId, skillName) {
  document.getElementById('activate-skill-id').value    = skillId;
  document.getElementById('activate-skill-name').textContent = skillName;
  document.getElementById('activate-password').value    = '';
  document.getElementById('activate-error').textContent  = '';
  document.getElementById('activate-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('activate-password').focus(), 60);
}

async function submitActivation() {
  const id       = document.getElementById('activate-skill-id').value;
  const password = document.getElementById('activate-password').value;
  const errEl    = document.getElementById('activate-error');
  errEl.textContent = '';
  try {
    await api('/skills/'+id+'/activate', { method: 'POST', body: JSON.stringify({ password }) });
    document.getElementById('activate-modal').classList.add('hidden');
    showToast('🔓 Skill activated! Agents can now use it.', 'success');
    allSkills = await api(bUrl('/skills'));
    renderSkillsSidebar();
    if (activeSkillId === id) openSkill(id);
  } catch(e) {
    errEl.textContent = e.message === 'Wrong password' ? '❌ Wrong password — try again' : e.message;
  }
}

// ── Integrations ───────────────────────────────────────────────────────────
async function loadIntegrations() {
  const s = await api('/integrations/status');
  renderTelegramState(s.telegram, s.telegramUsername, s.telegramName);
  renderComposioState(s.composio);
  renderWebhookState('zapier', s.zapier);
  renderWebhookState('make', s.make);
  renderCustomAppState('lovable', s.lovable);
  renderCustomAppState('base44', s.base44);
  const feedData = await api('/imessage/feed');
  const feedEl = document.getElementById('imsg-feed');
  if (feedEl) { feedEl.innerHTML = ''; feedData.forEach(appendImessageFeedItem); }
}

function renderComposioState(connected) {
  const form = document.getElementById('composio-connect-form');
  const info = document.getElementById('composio-connected-info');
  const badge = document.getElementById('composio-badge');
  if (connected) {
    form.classList.add('hidden');
    info.classList.remove('hidden');
    badge.innerHTML = '<span class="badge badge-on">Connected</span>';
    document.getElementById('composio-status-text').textContent = 'Connected — your agents can use Composio tools';
  } else {
    form.classList.remove('hidden');
    info.classList.add('hidden');
    badge.innerHTML = '<span class="badge badge-off">Off</span>';
    document.getElementById('composio-status-text').textContent = 'Connect 500+ apps — Gmail, Slack, GitHub, Google Sheets, and more';
  }
}

async function connectComposio() {
  const input = document.getElementById('composio-key-input');
  const key = input.value.trim();
  const errEl = document.getElementById('composio-error');
  if (!key) { errEl.textContent = 'Please paste your API key'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  document.getElementById('composio-connect-btn').disabled = true;
  try {
    await api('/integrations/composio', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
    renderComposioState(true);
    showToast('Composio connected!', 'success');
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove('hidden');
  }
  document.getElementById('composio-connect-btn').disabled = false;
}

async function disconnectComposio() {
  if (!confirm('Disconnect Composio?')) return;
  await api('/integrations/composio', { method: 'DELETE' });
  renderComposioState(false);
  showToast('Composio disconnected', 'info');
}

// Generic webhook integration (Zapier, Make, etc.)
function renderWebhookState(name, connected) {
  const form = document.getElementById(name + '-connect-form');
  const info = document.getElementById(name + '-connected-info');
  const badge = document.getElementById(name + '-badge');
  if (!form || !info || !badge) return;
  if (connected) {
    form.classList.add('hidden');
    info.classList.remove('hidden');
    badge.innerHTML = '<span class="badge badge-on">Connected</span>';
  } else {
    form.classList.remove('hidden');
    info.classList.add('hidden');
    badge.innerHTML = '<span class="badge badge-off">Off</span>';
  }
}

async function connectWebhookIntegration(name) {
  const input = document.getElementById(name + '-key-input');
  const key = input.value.trim();
  const errEl = document.getElementById(name + '-error');
  if (!key) { errEl.textContent = 'Please paste your API key'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  document.getElementById(name + '-connect-btn').disabled = true;
  try {
    await api('/integrations/' + name, { method: 'POST', body: JSON.stringify({ apiKey: key }) });
    renderWebhookState(name, true);
    showToast(name.charAt(0).toUpperCase() + name.slice(1) + ' connected!', 'success');
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove('hidden');
  }
  document.getElementById(name + '-connect-btn').disabled = false;
}

// Custom app integrations (Lovable, Base44 — webhook + API key)
function renderCustomAppState(name, data) {
  const form = document.getElementById(name + '-connect-form');
  const info = document.getElementById(name + '-connected-info');
  const badge = document.getElementById(name + '-badge');
  if (!form || !info || !badge || !data) return;
  if (data.connected) {
    form.classList.add('hidden');
    info.classList.remove('hidden');
    badge.innerHTML = '<span class="badge badge-on">Connected</span>';
    const hint = document.getElementById(name + '-connected-hint');
    if (hint) {
      const parts = [];
      if (data.webhook) parts.push('Webhook: ' + data.webhook.slice(0, 40) + (data.webhook.length > 40 ? '...' : ''));
      if (data.hasKey) parts.push('API key saved');
      hint.textContent = parts.join(' · ') || 'Connected';
    }
  } else {
    form.classList.remove('hidden');
    info.classList.add('hidden');
    badge.innerHTML = '<span class="badge badge-off">Off</span>';
  }
}

async function connectCustomApp(name) {
  const webhook = document.getElementById(name + '-webhook-input').value.trim();
  const apiKey = document.getElementById(name + '-key-input').value.trim();
  const errEl = document.getElementById(name + '-error');
  if (!webhook && !apiKey) { errEl.textContent = 'Enter a webhook URL or API key'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  document.getElementById(name + '-connect-btn').disabled = true;
  try {
    await api('/integrations/custom/' + name, { method: 'POST', body: JSON.stringify({ webhook, apiKey }) });
    renderCustomAppState(name, { connected: true, webhook, hasKey: !!apiKey });
    showToast(name.charAt(0).toUpperCase() + name.slice(1) + ' connected!', 'success');
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove('hidden');
  }
  document.getElementById(name + '-connect-btn').disabled = false;
}

async function disconnectCustomApp(name) {
  if (!confirm('Disconnect ' + name.charAt(0).toUpperCase() + name.slice(1) + '?')) return;
  await api('/integrations/custom/' + name, { method: 'DELETE' });
  renderCustomAppState(name, { connected: false });
  showToast(name.charAt(0).toUpperCase() + name.slice(1) + ' disconnected', 'info');
}

async function disconnectWebhookIntegration(name) {
  if (!confirm('Disconnect ' + name.charAt(0).toUpperCase() + name.slice(1) + '?')) return;
  await api('/integrations/' + name, { method: 'DELETE' });
  renderWebhookState(name, false);
  showToast(name.charAt(0).toUpperCase() + name.slice(1) + ' disconnected', 'info');
}

// ── Inbox ──────────────────────────────────────────────────────────────────
// In-memory store: Map of "handle::agentName" -> { handle, agentName, messages: [...] }
const inboxConvos = new Map();
let activeConvoKey = null;
let inboxUnread = 0;

function _convoKey(item) { return `${item.handle}::${item.agentName}`; }

function inboxAddMessage(item) {
  const key = _convoKey(item);
  if (!inboxConvos.has(key)) {
    inboxConvos.set(key, { handle: item.handle, agentName: item.agentName, messages: [] });
  }
  // Deduplicate by timestamp + type + text prefix
  const msgs = inboxConvos.get(key).messages;
  const isDup = msgs.some(m => m.ts === item.ts && m.type === item.type && m.text.slice(0, 50) === item.text.slice(0, 50));
  if (isDup) return;
  msgs.push(item);

  // Refresh sidebar + active thread if inbox is open
  if (document.getElementById('view-inbox').classList.contains('active')) {
    renderInboxSidebar();
    if (activeConvoKey === key) renderInboxThread(key);
  }
}

function bumpInboxBadge() {
  inboxUnread++;
  const badge = document.getElementById('inbox-nav-badge');
  if (badge) { badge.textContent = inboxUnread; badge.classList.remove('hidden'); }
}

function clearInboxBadge() {
  inboxUnread = 0;
  const badge = document.getElementById('inbox-nav-badge');
  if (badge) badge.classList.add('hidden');
}

async function loadInbox() {
  // Load full history from disk on every open
  const feedData = await api('/imessage/feed');
  inboxConvos.clear();
  feedData.forEach(inboxAddMessage);
  renderInboxSidebar();
  if (activeConvoKey) renderInboxThread(activeConvoKey);
}

function renderInboxSidebar() {
  const sidebar = document.getElementById('inbox-sidebar');
  const empty   = document.getElementById('inbox-empty');
  if (!sidebar) return;

  const convos = [...inboxConvos.values()];
  if (convos.length === 0) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');

  sidebar.innerHTML = '';
  convos.forEach(c => {
    const key      = _convoKey(c);
    const last     = c.messages[c.messages.length - 1];
    const time     = new Date(last.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isActive = key === activeConvoKey;
    const dir      = last.type === 'in' ? '' : '↩ ';
    const div      = document.createElement('div');
    div.className  = `inbox-row${isActive ? ' active' : ''}`;
    div.innerHTML  = `
      <div class="inbox-row-top">
        <span class="inbox-row-agent">${esc(c.agentName)}</span>
        <span class="inbox-row-time">${time}</span>
      </div>
      <div class="inbox-row-handle">${esc(c.handle)}</div>
      <div class="inbox-row-preview">${dir}${esc(last.text.slice(0, 60))}${last.text.length > 60 ? '…' : ''}</div>`;
    div.addEventListener('click', () => openConvo(key));
    sidebar.appendChild(div);
  });
}

function openConvo(key) {
  activeConvoKey = key;
  renderInboxSidebar();
  renderInboxThread(key);
}

function renderInboxThread(key) {
  const thread  = document.getElementById('inbox-thread');
  if (!thread) return;

  const convo = inboxConvos.get(key);
  if (!convo) return;

  document.getElementById('inbox-thread-placeholder')?.remove();

  // Build header
  let header = thread.querySelector('.inbox-thread-header');
  if (!header) {
    thread.innerHTML = '';
    header = document.createElement('div');
    header.className = 'inbox-thread-header';
    thread.appendChild(header);
  }
  header.innerHTML = `<div class="inbox-thread-agent">${esc(convo.agentName)}</div>
    <div class="inbox-thread-handle">${esc(convo.handle)}</div>`;

  // Build messages container
  let msgsEl = document.getElementById('inbox-thread-msgs');
  if (!msgsEl) {
    msgsEl = document.createElement('div');
    msgsEl.id = 'inbox-thread-msgs';
    msgsEl.className = 'inbox-thread-messages';
    thread.appendChild(msgsEl);
  }

  msgsEl.innerHTML = convo.messages.map(m => {
    const isIn = m.type === 'in';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="inbox-msg ${isIn ? 'inbox-msg-in' : 'inbox-msg-out'}">
      <div class="inbox-msg-bubble">${esc(m.text)}</div>
      <div class="inbox-msg-time">${isIn ? 'You' : esc(convo.agentName)} · ${time}</div>
    </div>`;
  }).join('');

  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function appendImessageFeedItem(item) {
  const feedEl = document.getElementById('imsg-feed');
  if (!feedEl) return;
  document.getElementById('imsg-empty')?.classList.add('hidden');
  const isIn = item.type === 'in';
  const time = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const div = document.createElement('div');
  div.className = `imsg-item ${isIn ? 'imsg-in' : 'imsg-out'}`;
  div.innerHTML = `
    <div class="imsg-meta">
      <span class="imsg-handle">${esc(item.handle)}</span>
      <span class="imsg-arrow">${isIn ? '→' : '←'}</span>
      <span class="imsg-agent">${esc(item.agentName)}</span>
      <span class="imsg-time">${time}</span>
    </div>
    <div class="imsg-text">${esc(item.text)}</div>`;
  feedEl.appendChild(div);
  feedEl.scrollTop = feedEl.scrollHeight;
}

function renderTelegramState(connected, username, name) {
  document.getElementById('telegram-badge').innerHTML = connected
    ? '<span class="badge badge-on">Connected</span>'
    : '<span class="badge badge-off">Off</span>';
  document.getElementById('telegram-status-text').textContent = connected
    ? `Connected as @${username}`
    : 'Paste your bot token below to connect';
  document.getElementById('telegram-connect-form').classList.toggle('hidden', connected);
  document.getElementById('telegram-connected-info').classList.toggle('hidden', !connected);
  if (connected && username) {
    document.getElementById('tg-bot-name').textContent = `@${username}${name ? ` (${name})` : ''}`;
  }
}

async function connectTelegram() {
  const token = document.getElementById('tg-token-input').value.trim();
  const errEl = document.getElementById('tg-error');
  const btn   = document.getElementById('tg-connect-btn');
  errEl.classList.add('hidden');
  if (!token) { errEl.textContent = 'Please paste your bot token first.'; errEl.classList.remove('hidden'); return; }

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const r = await api('/integrations/telegram', { method: 'POST', body: JSON.stringify({ token }) });
    document.getElementById('tg-token-input').value = '';
    renderTelegramState(true, r.username, r.name);
    showToast(`🤖 Telegram connected as @${r.username}`, 'success');
  } catch(e) {
    errEl.textContent = '❌ ' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function disconnectTelegram() {
  if (!confirm('Disconnect Telegram bot?')) return;
  await api('/integrations/telegram', { method: 'DELETE' });
  renderTelegramState(false, null, null);
  showToast('Telegram disconnected', 'info', 3000);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function setBoardColor(hex) {
  document.getElementById('bf-color').value = hex;
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('selected', s.style.background === hex));
}

function closeOnOverlay(e, id) {
  if (e.target === e.currentTarget) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'detail-modal') currentDetailRunId = null;
    if (id === 'chat-modal')   currentChatAgentId = null;
  }
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function relTime(iso) {
  const d = Date.now() - new Date(iso);
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d/60000)+'m ago';
  if (d < 86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}
function duration(s, e) {
  const ms = new Date(e) - new Date(s);
  if (ms < 1000) return ms+'ms';
  if (ms < 60000) return (ms/1000).toFixed(1)+'s';
  return Math.floor(ms/60000)+'m '+Math.floor((ms%60000)/1000)+'s';
}
function fmtTime(iso) { return new Date(iso).toLocaleString(); }
function fmtDate(iso) { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }

// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    const h = await api('/homedir');
    userHomeDir = h.homedir || '';
    fileBrowserPath = userHomeDir;
  } catch {}
  connectWS();
  await loadBoards();
  allSkills = await api(bUrl('/skills'));
  await loadDashboard();
  api('/version').then(v => {
    const el = document.getElementById('version-label');
    if (el) el.textContent = 'v' + v.version;
  }).catch(() => {});
  checkForUpdate();
  setInterval(checkForUpdate, 5 * 60 * 1000); // check every 5 min
  setInterval(() => { refreshStats(); refreshActiveRuns(); refreshActiveTasks(); }, 15000);
})();

// ── Skill drag & drop ───────────────────────────────────────────────────────
function handleSkillDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('skill-drop-zone').classList.add('drag-over');
}
function handleSkillDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('skill-drop-zone').classList.remove('drag-over');
}

async function handleSkillDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('skill-drop-zone');
  zone.classList.remove('drag-over');
  zone.classList.add('uploading');
  document.querySelector('.drop-zone-text').textContent = 'Reading files...';

  const mdFiles = [];

  async function readEntry(entry, folderName) {
    if (entry.isFile) {
      if (entry.name.endsWith('.md') || entry.name.endsWith('.txt')) {
        const file = await new Promise(r => entry.file(r));
        const content = await file.text();
        mdFiles.push({ name: entry.name, content, folder: folderName || '' });
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await new Promise((resolve, reject) => {
        const all = [];
        function readBatch() {
          reader.readEntries(batch => {
            if (!batch.length) return resolve(all);
            all.push(...batch);
            readBatch();
          }, reject);
        }
        readBatch();
      });
      for (const child of entries) {
        await readEntry(child, folderName || entry.name);
      }
    }
  }

  try {
    const items = e.dataTransfer.items;
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) await readEntry(entry, '');
    }

    if (!mdFiles.length) {
      showToast('No .md or .txt files found in the drop', 'error');
      zone.classList.remove('uploading');
      document.querySelector('.drop-zone-text').textContent = 'Drag & drop a folder or .md files here';
      return;
    }

    document.querySelector('.drop-zone-text').textContent = `Uploading ${mdFiles.length} skill${mdFiles.length > 1 ? 's' : ''}...`;

    const result = await api('/skills/upload', {
      method: 'POST',
      body: JSON.stringify({ files: mdFiles, boardId: currentBoardId }),
    });

    showToast(`${result.count} skill${result.count > 1 ? 's' : ''} created!`, 'success');
    allSkills = await api(bUrl('/skills'));
    renderSkillsSidebar();
    if (result.created.length) openSkill(result.created[0].id);
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  }

  zone.classList.remove('uploading');
  document.querySelector('.drop-zone-text').textContent = 'Drag & drop a folder or .md files here';
}

// ── Auto-update ─────────────────────────────────────────────────────────────
let updateDismissed = null;

async function checkForUpdate() {
  try {
    const data = await api('/update/check');
    if (data.updateAvailable && data.remote !== updateDismissed) {
      const banner = document.getElementById('update-banner');
      document.getElementById('update-banner-text').textContent = `Update available: v${data.local} → v${data.remote}`;
      banner.classList.remove('hidden');
    }
  } catch {}
}

function dismissUpdate() {
  const banner = document.getElementById('update-banner');
  banner.classList.add('hidden');
  // Remember dismissed version so we don't nag until next new version
  const text = document.getElementById('update-banner-text').textContent;
  const match = text.match(/→ v(.+)$/);
  if (match) updateDismissed = match[1];
}

async function applyUpdate() {
  const banner = document.getElementById('update-banner');
  banner.classList.add('updating');
  document.getElementById('update-banner-text').textContent = 'Updating... please wait';
  try {
    const result = await api('/update/apply', { method: 'POST' });
    document.getElementById('update-banner-text').textContent = `Updated to v${result.version}! Reloading...`;
    // Server restarts after update — poll until it's back up, then reload
    const waitForServer = () => {
      setTimeout(async () => {
        try {
          await fetch('/api/version');
          location.reload();
        } catch {
          waitForServer();
        }
      }, 2000);
    };
    waitForServer();
  } catch (e) {
    // If the server already restarted mid-request, the fetch will fail — try reloading
    if (e.message === 'Failed to fetch' || e.message.includes('NetworkError')) {
      document.getElementById('update-banner-text').textContent = 'Server restarting... reloading shortly';
      setTimeout(() => location.reload(), 5000);
    } else {
      document.getElementById('update-banner-text').textContent = 'Update failed: ' + e.message;
      banner.classList.remove('updating');
    }
  }
}
