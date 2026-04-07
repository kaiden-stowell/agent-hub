'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR       = path.join(__dirname, 'data');
const DB_FILE        = path.join(DATA_DIR, 'db.json');
const DEFAULT_BOARD  = 'board-default';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!d.tasks)  d.tasks  = [];
    if (!d.chats)  d.chats  = [];
    if (!d.crons)  d.crons  = [];
    if (!d.skills) d.skills = [];
    if (!d.boards) d.boards = [];
    if (!d.inbox)  d.inbox  = [];

    // Ensure the default board always exists
    if (!d.boards.find(b => b.id === DEFAULT_BOARD)) {
      d.boards.unshift({ id: DEFAULT_BOARD, name: 'Default', color: '#6366f1',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }

    // Backfill board_id + skill_ids on existing records
    d.agents = d.agents.map(a => ({ board_id: DEFAULT_BOARD, skill_ids: [], ...a }));
    d.skills = d.skills.map(s => ({ board_id: DEFAULT_BOARD, owner_agent_id: null, active: true, ...s }));
    d.tasks  = d.tasks.map(t  => ({ board_id: DEFAULT_BOARD, archived: false, ...t }));
    d.crons  = d.crons.map(c  => ({ board_id: DEFAULT_BOARD, ...c }));
    return d;
  } catch {
    const now = new Date().toISOString();
    return {
      agents: [], runs: [], tasks: [], chats: [], crons: [], skills: [], inbox: [],
      boards: [{ id: DEFAULT_BOARD, name: 'Default', color: '#6366f1', created_at: now, updated_at: now }],
    };
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Boards ──────────────────────────────────────────────────────────────────
function getBoards()   { return load().boards; }
function getBoard(id)  { return load().boards.find(b => b.id === id) || null; }
function insertBoard(board) { const d = load(); d.boards.push(board); save(d); }

function updateBoard(id, patch) {
  const data = load();
  const idx  = data.boards.findIndex(b => b.id === id);
  if (idx === -1) return null;
  data.boards[idx] = { ...data.boards[idx], ...patch, updated_at: new Date().toISOString() };
  save(data);
  return data.boards[idx];
}

function deleteBoard(id) {
  const data = load();
  if (data.boards.length <= 1) throw new Error('Cannot delete the last board');
  const agentIds = new Set(data.agents.filter(a => a.board_id === id).map(a => a.id));
  data.boards = data.boards.filter(b => b.id !== id);
  data.agents = data.agents.filter(a => a.board_id !== id);
  data.runs   = data.runs.filter(r => !agentIds.has(r.agent_id));
  data.chats  = data.chats.filter(c => !agentIds.has(c.agent_id));
  data.tasks  = data.tasks.filter(t => t.board_id !== id);
  data.skills = data.skills.filter(s => s.board_id !== id);
  data.crons  = data.crons.filter(c => c.board_id !== id);
  save(data);
}

// ── Agents ──────────────────────────────────────────────────────────────────
function getAgents(opts = {}) {
  let agents = load().agents;
  if (opts.board_id) agents = agents.filter(a => a.board_id === opts.board_id);
  return agents;
}
function getAgent(id) { return load().agents.find(a => a.id === id) || null; }

function insertAgent(agent) {
  const data = load();
  data.agents.push(agent);
  save(data);
}

function updateAgent(id, patch) {
  const data = load();
  const idx  = data.agents.findIndex(a => a.id === id);
  if (idx === -1) return null;
  data.agents[idx] = { ...data.agents[idx], ...patch, updated_at: new Date().toISOString() };
  save(data);
  return data.agents[idx];
}

function deleteAgent(id) {
  const data  = load();
  const agent = data.agents.find(a => a.id === id);
  if (agent?.protected) throw new Error('Cannot delete a protected agent');
  data.agents = data.agents.filter(a => a.id !== id);
  data.runs   = data.runs.filter(r => r.agent_id !== id);
  data.tasks  = data.tasks.map(t => t.agent_id === id ? { ...t, agent_id: null } : t);
  data.chats  = data.chats.filter(c => c.agent_id !== id);
  data.crons  = data.crons.filter(c => c.agent_id !== id);
  save(data);
}

// ── Runs ────────────────────────────────────────────────────────────────────
function getRuns(opts = {}) {
  const data = load();
  let runs = data.runs;
  if (opts.status)   runs = runs.filter(r => r.status === opts.status);
  if (opts.agent_id) runs = runs.filter(r => r.agent_id === opts.agent_id);
  if (opts.board_id) {
    const boardAgents = new Set(data.agents.filter(a => a.board_id === opts.board_id).map(a => a.id));
    runs = runs.filter(r => boardAgents.has(r.agent_id));
  }
  runs = runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (opts.limit) runs = runs.slice(0, opts.limit);
  return runs.map(r => ({ ...r, agent_name: (data.agents.find(a => a.id === r.agent_id) || {}).name || '' }));
}

function getRun(id) {
  const data = load();
  const run  = data.runs.find(r => r.id === id);
  if (!run) return null;
  return { ...run, agent_name: (data.agents.find(a => a.id === run.agent_id) || {}).name || '' };
}

function insertRun(run)       { const d = load(); d.runs.push(run); save(d); }
function updateRun(id, patch) {
  const data = load();
  const idx  = data.runs.findIndex(r => r.id === id);
  if (idx === -1) return null;
  data.runs[idx] = { ...data.runs[idx], ...patch };
  save(data);
  return data.runs[idx];
}

// ── Tasks ────────────────────────────────────────────────────────────────────
function getTasks(opts = {}) {
  const data = load();
  let tasks = data.tasks;
  // By default exclude archived tasks; pass archived:true to get only archived
  if (opts.archived === true)       tasks = tasks.filter(t => t.archived);
  else if (opts.archived !== 'all') tasks = tasks.filter(t => !t.archived);
  if (opts.status)   tasks = tasks.filter(t => t.status === opts.status);
  if (opts.agent_id) tasks = tasks.filter(t => t.agent_id === opts.agent_id);
  if (opts.board_id) tasks = tasks.filter(t => t.board_id === opts.board_id);
  const pri = { urgent: 0, high: 1, medium: 2, low: 3 };
  tasks = tasks.sort((a, b) =>
    (pri[a.priority] ?? 2) - (pri[b.priority] ?? 2) || b.created_at.localeCompare(a.created_at));
  return tasks.map(t => ({ ...t, agent_name: (data.agents.find(a => a.id === t.agent_id) || {}).name || '' }));
}

function getTask(id) {
  const data = load();
  const t    = data.tasks.find(t => t.id === id);
  if (!t) return null;
  return { ...t, agent_name: (data.agents.find(a => a.id === t.agent_id) || {}).name || '' };
}

function insertTask(task)      { const d = load(); d.tasks.push(task); save(d); }
function updateTask(id, patch) {
  const data = load();
  const idx  = data.tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  data.tasks[idx] = { ...data.tasks[idx], ...patch, updated_at: new Date().toISOString() };
  save(data);
  return { ...data.tasks[idx], agent_name: (data.agents.find(a => a.id === data.tasks[idx].agent_id) || {}).name || '' };
}

function deleteTask(id) { const d = load(); d.tasks = d.tasks.filter(t => t.id !== id); save(d); }

// ── Skills ───────────────────────────────────────────────────────────────────
function getSkills(opts = {}) {
  let skills = load().skills;
  if (opts.board_id) skills = skills.filter(s => s.board_id === opts.board_id);
  return skills.sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name));
}
function getSkill(id)   { return load().skills.find(s => s.id === id) || null; }
function insertSkill(s) { const d = load(); d.skills.push(s); save(d); }

function updateSkill(id, patch) {
  const data = load();
  const idx  = data.skills.findIndex(s => s.id === id);
  if (idx === -1) return null;
  data.skills[idx] = { ...data.skills[idx], ...patch, updated_at: new Date().toISOString() };
  save(data);
  return data.skills[idx];
}

function deleteSkill(id) {
  const data = load();
  data.skills = data.skills.filter(s => s.id !== id);
  data.agents = data.agents.map(a => ({
    ...a,
    skill_ids: (a.skill_ids || []).filter(sid => sid !== id),
  }));
  save(data);
}

// ── Crons ────────────────────────────────────────────────────────────────────
function getCrons(agentId, boardId) {
  const data  = load();
  let crons = data.crons;
  if (agentId)  crons = crons.filter(c => c.agent_id === agentId);
  if (boardId)  crons = crons.filter(c => c.board_id === boardId);
  return crons.map(c => ({ ...c, agent_name: (data.agents.find(a => a.id === c.agent_id) || {}).name || '' }));
}

function getCron(id)       { return load().crons.find(c => c.id === id) || null; }
function insertCron(cron)  { const d = load(); d.crons.push(cron); save(d); }

function updateCron(id, patch) {
  const data = load();
  const idx  = data.crons.findIndex(c => c.id === id);
  if (idx === -1) return null;
  data.crons[idx] = { ...data.crons[idx], ...patch };
  save(data);
  return data.crons[idx];
}

function deleteCron(id) { const d = load(); d.crons = d.crons.filter(c => c.id !== id); save(d); }

// ── Chats ────────────────────────────────────────────────────────────────────
function getChat(agentId) { return load().chats.find(c => c.agent_id === agentId) || null; }

function appendChatMessage(agentId, message) {
  const data = load();
  const now  = new Date().toISOString();
  const idx  = data.chats.findIndex(c => c.agent_id === agentId);
  if (idx === -1) {
    data.chats.push({ agent_id: agentId, messages: [message], created_at: now, updated_at: now });
  } else {
    data.chats[idx].messages.push(message);
    data.chats[idx].updated_at = now;
  }
  save(data);
}

function updateLastChatMessage(agentId, patch) {
  const data = load();
  const idx  = data.chats.findIndex(c => c.agent_id === agentId);
  if (idx === -1) return;
  const msgs = data.chats[idx].messages;
  if (!msgs.length) return;
  msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...patch };
  data.chats[idx].updated_at = new Date().toISOString();
  save(data);
}

function clearChat(agentId) {
  const data = load();
  const idx  = data.chats.findIndex(c => c.agent_id === agentId);
  if (idx !== -1) { data.chats[idx].messages = []; save(data); }
}

// ── Inbox (iMessage history) ─────────────────────────────────────────────────
function getInboxMessages(opts = {}) {
  const data = load();
  if (!data.inbox) return [];
  let msgs = data.inbox;
  if (opts.handle)    msgs = msgs.filter(m => m.handle === opts.handle);
  if (opts.agentName) msgs = msgs.filter(m => m.agentName === opts.agentName);
  if (opts.limit)     msgs = msgs.slice(-opts.limit);
  return msgs;
}

function appendInboxMessage(msg) {
  const data = load();
  if (!data.inbox) data.inbox = [];
  data.inbox.push(msg);
  save(data);
}

// ── Stats ────────────────────────────────────────────────────────────────────
function getStats(boardId) {
  const data = load();
  const agents = boardId ? data.agents.filter(a => a.board_id === boardId) : data.agents;
  const boardAgentIds = new Set(agents.map(a => a.id));
  const tasks  = boardId ? data.tasks.filter(t => t.board_id === boardId) : data.tasks;
  const crons  = boardId ? data.crons.filter(c => c.board_id === boardId) : data.crons;
  const runs   = boardId ? data.runs.filter(r => boardAgentIds.has(r.agent_id)) : data.runs;
  return {
    agents:    agents.length,
    running:   agents.filter(a => a.status === 'running').length,
    totalRuns: runs.length,
    done:      runs.filter(r => r.status === 'done').length,
    tasks:     tasks.length,
    tasksDone: tasks.filter(t => t.status === 'done').length,
    crons:     crons.filter(c => c.enabled).length,
  };
}

module.exports = {
  DEFAULT_BOARD,
  getBoards, getBoard, insertBoard, updateBoard, deleteBoard,
  getAgents, getAgent, insertAgent, updateAgent, deleteAgent,
  getRuns, getRun, insertRun, updateRun,
  getTasks, getTask, insertTask, updateTask, deleteTask,
  getSkills, getSkill, insertSkill, updateSkill, deleteSkill,
  getCrons, getCron, insertCron, updateCron, deleteCron,
  getChat, appendChatMessage, updateLastChatMessage, clearChat,
  getInboxMessages, appendInboxMessage,
  getStats,
};
