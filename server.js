'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

const db        = require('./db');
const runner    = require('./runner');
const telegram  = require('./telegram');
const imessage  = require('./imessage');
const scheduler = require('./cron-scheduler');
const coo       = require('./coo');
const skillsMgr = require('./skills-manager');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '12789', 10);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket ──────────────────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

runner.setBroadcast(broadcast);
runner.setCOOHelpers(coo.getCOOContextPrompt);
telegram.setBroadcast(broadcast);
scheduler.setBroadcast(broadcast);
imessage.setBroadcast(broadcast);

// ── Debug ──────────────────────────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
  const fs = require('fs');
  res.json({ claudeBin: runner.CLAUDE_BIN, claudeExists: fs.existsSync(runner.CLAUDE_BIN), nodeVersion: process.version });
});

app.get('/api/version', (req, res) => {
  res.json({ version: getLocalVersion() });
});

// ── Update check & apply ──────────────────────────────────────────────────
// Use GitHub API (no CDN cache) instead of raw.githubusercontent.com
const REPO_API_URL = 'https://api.github.com/repos/kaiden-stowell/agent-hub/contents/version.json?ref=main';
let cachedRemoteVersion = null;
let lastVersionCheck = 0;

function getLocalVersion() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
  } catch { return 'unknown'; }
}

app.get('/api/update/check', async (req, res) => {
  try {
    const localVersion = getLocalVersion();
    const forceCheck = req.query.force === '1';
    // Cache for 2 minutes unless forced
    if (!forceCheck && Date.now() - lastVersionCheck < 120000 && cachedRemoteVersion) {
      return res.json({ local: localVersion, remote: cachedRemoteVersion, updateAvailable: cachedRemoteVersion !== localVersion });
    }
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(REPO_API_URL, {
        headers: { 'User-Agent': 'agent-hub', 'Accept': 'application/vnd.github.v3+json' }
      }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
      }).on('error', reject);
    });
    const json = JSON.parse(data);
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    const remote = JSON.parse(content).version;
    cachedRemoteVersion = remote;
    lastVersionCheck = Date.now();
    res.json({ local: localVersion, remote, updateAvailable: remote !== localVersion });
  } catch (e) {
    res.json({ local: getLocalVersion(), remote: null, updateAvailable: false, error: e.message });
  }
});

app.post('/api/update/apply', (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const gitDir = path.join(__dirname, '.git');
  if (!fs.existsSync(gitDir)) {
    return res.status(400).json({ error: 'Not a git repo. Run the install script first.' });
  }
  try {
    execSync('git pull --ff-only origin main', { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    const newVersion = getLocalVersion();
    cachedRemoteVersion = null;
    lastVersionCheck = 0;
    res.json({ ok: true, version: newVersion, restarting: true });
    // Restart after response is sent
    setTimeout(() => {
      console.log('[update] Restarting server after update...');
      process.exit(0); // launchd or process manager will restart us
    }, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Skill upload (drag & drop) ────────────────────────────────────────────
app.post('/api/skills/upload', (req, res) => {
  const { files, boardId } = req.body;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'No files provided' });
  const created = [];
  for (const f of files) {
    if (!f.name || !f.content) continue;
    // Clean name: remove extension, convert dashes/underscores to spaces, title case
    const rawName = f.name.replace(/\.(md|txt)$/i, '');
    const name = rawName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const skill = {
      id: uuidv4(), board_id: boardId || db.DEFAULT_BOARD, name,
      description: '',
      type: 'inline',
      file_path: null,
      folder: f.folder || '',
      tags: '[]',
      owner_agent_id: null,
      active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.insertSkill(skill);
    skillsMgr.writeSkillContent(skill.id, f.content);
    broadcast('skill:created', skill);
    created.push({ id: skill.id, name: skill.name });
  }
  res.status(201).json({ created, count: created.length });
});

// ── Stats ──────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => res.json(db.getStats(req.query.boardId || null)));

// ── Boards ──────────────────────────────────────────────────────────────────
app.get('/api/boards', (req, res) => res.json(db.getBoards()));

app.post('/api/boards', (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const board = {
    id: uuidv4(), name: name.trim(),
    color: color || '#6366f1',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.insertBoard(board);
  // Seed a COO for the new board
  coo.ensureCOO(board.id, board.name);
  broadcast('board:created', board);
  res.status(201).json(board);
});

app.put('/api/boards/:id', (req, res) => {
  const { name, color } = req.body;
  const updated = db.updateBoard(req.params.id, {
    ...(name ? { name: name.trim() } : {}),
    ...(color ? { color } : {}),
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  broadcast('board:updated', updated);
  res.json(updated);
});

app.delete('/api/boards/:id', (req, res) => {
  try {
    db.deleteBoard(req.params.id);
    broadcast('board:deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Agents ─────────────────────────────────────────────────────────────────
app.get('/api/agents', (req, res) => {
  const { boardId } = req.query;
  res.json(db.getAgents(boardId ? { board_id: boardId } : {}).sort((a, b) => {
    if (a.protected && !b.protected) return -1;
    if (!a.protected && b.protected) return 1;
    return (a.name || '').localeCompare(b.name || '');
  }));
});

app.get('/api/agents/:id', (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a);
});

app.post('/api/agents', (req, res) => {
  const { name, description, prompt, workdir, model, tags, telegram_chat_id, imessage_handle, notify_on, boardId } = req.body;
  if (!name?.trim() || !prompt?.trim()) return res.status(400).json({ error: 'name and prompt are required' });
  const agent = {
    id: uuidv4(), board_id: boardId || db.DEFAULT_BOARD,
    name: name.trim(), description: description?.trim() || '',
    prompt: prompt.trim(), workdir: workdir?.trim() || process.env.HOME || '/tmp',
    model: model || 'claude-sonnet-4-6', tags: tags || '[]',
    telegram_chat_id: telegram_chat_id || null, imessage_handle: imessage_handle || null,
    notify_on: notify_on || '["done","error"]',
    status: 'idle', run_count: 0, total_cost_cents: 0, protected: false, skill_ids: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_run_at: null,
  };
  db.insertAgent(agent);
  broadcast('agent:created', agent);
  res.status(201).json(agent);
});

app.put('/api/agents/:id', (req, res) => {
  if (!db.getAgent(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { name, description, prompt, workdir, model, tags, telegram_chat_id, imessage_handle, notify_on, skill_ids } = req.body;
  const updated = db.updateAgent(req.params.id, {
    name: name?.trim(), description: description?.trim() || '',
    prompt: prompt?.trim(), workdir: workdir?.trim() || process.env.HOME || '/tmp',
    model: model || 'claude-sonnet-4-6', tags: tags || '[]',
    telegram_chat_id: telegram_chat_id || null, imessage_handle: imessage_handle || null,
    notify_on: notify_on || '["done","error"]',
    ...(Array.isArray(skill_ids) ? { skill_ids } : {}),
  });
  broadcast('agent:updated', updated);
  res.json(updated);
});

app.delete('/api/agents/:id', (req, res) => {
  try {
    db.deleteAgent(req.params.id);
    broadcast('agent:deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

// ── Runs ───────────────────────────────────────────────────────────────────
app.get('/api/runs', (req, res) => {
  const { status, agentId, boardId, limit = '50' } = req.query;
  res.json(db.getRuns({ status: status || null, agent_id: agentId || null, board_id: boardId || null, limit: parseInt(limit, 10) }));
});

app.get('/api/runs/:id', (req, res) => {
  const r = db.getRun(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.post('/api/runs', (req, res) => {
  const { agentId, prompt, taskId } = req.body;
  if (!agentId || !prompt) return res.status(400).json({ error: 'agentId and prompt required' });
  try {
    const runId = runner.startRun(agentId, prompt, { triggeredBy: 'ui', taskId });
    res.status(201).json({ runId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/runs/:id/stop', (req, res) => res.json({ ok: runner.stopRun(req.params.id) }));

// ── Tasks ──────────────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const { status, agentId, boardId, archived } = req.query;
  const archivedOpt = archived === 'true' ? true : archived === 'all' ? 'all' : false;
  res.json(db.getTasks({ status: status || null, agent_id: agentId || null, board_id: boardId || null, archived: archivedOpt }));
});

app.get('/api/tasks/:id', (req, res) => {
  const t = db.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

app.post('/api/tasks', (req, res) => {
  const { title, description, agent_id, priority, notes, boardId } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const task = {
    id: uuidv4(), board_id: boardId || db.DEFAULT_BOARD,
    title: title.trim(), description: description?.trim() || '',
    agent_id: agent_id || null, priority: priority || 'medium',
    status: 'todo', notes: notes || '', run_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.insertTask(task);
  broadcast('task:created', db.getTask(task.id));
  res.status(201).json(db.getTask(task.id));
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { title, description, agent_id, priority, status, notes } = req.body;
  const updated = db.updateTask(req.params.id, {
    title: title?.trim(), description: description?.trim() || '',
    agent_id: agent_id || null, priority: priority || 'medium',
    status: status || 'todo', notes: notes || '',
  });
  broadcast('task:updated', updated);
  if (status === 'done' && existing.status !== 'done') {
    broadcast('task:done', { id: updated.id, title: updated.title, agent_name: updated.agent_name });
  }
  res.json(updated);
});

app.post('/api/tasks/:id/archive', (req, res) => {
  const t = db.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const updated = db.updateTask(req.params.id, { archived: true, status: 'done' });
  broadcast('task:archived', updated);
  res.json(updated);
});

app.delete('/api/tasks/:id', (req, res) => {
  db.deleteTask(req.params.id);
  broadcast('task:deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/start', (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!task.agent_id) return res.status(400).json({ error: 'Task has no assigned agent' });
  const prompt = [`Task: ${task.title}`, task.description ? `Description: ${task.description}` : '', task.notes ? `Notes: ${task.notes}` : ''].filter(Boolean).join('\n');
  try {
    const runId   = runner.startRun(task.agent_id, prompt, { triggeredBy: 'task', taskId: task.id });
    const updated = db.updateTask(task.id, { status: 'in-progress', run_id: runId });
    broadcast('task:updated', updated);
    res.json({ runId, task: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Skills ─────────────────────────────────────────────────────────────────
app.get('/api/skills', (req, res) => {
  const { agentId, scope, boardId } = req.query;
  let skills = db.getSkills(boardId ? { board_id: boardId } : {});
  if (scope === 'owned' && agentId)  skills = skills.filter(s => s.owner_agent_id === agentId);
  if (scope === 'shared')            skills = skills.filter(s => !s.owner_agent_id);
  if (agentId && !scope)             skills = skills.filter(s => !s.owner_agent_id || s.owner_agent_id === agentId);
  res.json(skills.map(s => ({
    ...s,
    file_exists: s.type !== 'inline' ? require('fs').existsSync(s.file_path || '') : true,
  })));
});

app.get('/api/skills/:id', (req, res) => {
  const s = db.getSkill(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ ...s, content: skillsMgr.readSkillContent(s) });
});

app.post('/api/skills', (req, res) => {
  const { name, description, type, file_path, folder, tags, content, owner_agent_id, boardId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if ((type === 'file' || type === 'folder') && !file_path?.trim())
    return res.status(400).json({ error: 'file_path is required for file/folder skills' });

  const skill = {
    id: uuidv4(), board_id: boardId || db.DEFAULT_BOARD, name: name.trim(),
    description: description?.trim() || '',
    type: type || 'inline',
    file_path: (type === 'inline' ? null : file_path?.trim()) || null,
    folder: folder?.trim() || '',
    tags: tags || '[]',
    owner_agent_id: owner_agent_id || null,
    active: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db.insertSkill(skill);
  if (skill.type === 'inline') skillsMgr.writeSkillContent(skill.id, content || '');
  broadcast('skill:created', skill);
  res.status(201).json({ ...skill, content: skillsMgr.readSkillContent(skill) });
});

app.put('/api/skills/:id', (req, res) => {
  const existing = db.getSkill(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, description, type, file_path, folder, tags, content, owner_agent_id } = req.body;
  const updated = db.updateSkill(req.params.id, {
    name: name?.trim(),
    description: description?.trim() || '',
    type: type || existing.type,
    file_path: (type === 'inline' ? null : file_path?.trim()) || existing.file_path,
    folder: folder?.trim() || '',
    tags: tags || '[]',
    owner_agent_id: owner_agent_id !== undefined ? (owner_agent_id || null) : existing.owner_agent_id,
  });
  if ((updated.type === 'inline') && content !== undefined)
    skillsMgr.writeSkillContent(updated.id, content);
  broadcast('skill:updated', updated);
  res.json({ ...updated, content: skillsMgr.readSkillContent(updated) });
});

app.delete('/api/skills/:id', (req, res) => {
  const s = db.getSkill(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  skillsMgr.deleteSkillFile(req.params.id);
  db.deleteSkill(req.params.id);
  broadcast('skill:deleted', { id: req.params.id });
  res.json({ ok: true });
});

// Activate a skill — requires creator password
app.post('/api/skills/:id/activate', (req, res) => {
  const s = db.getSkill(req.params.id);
  if (!s) return res.status(404).json({ error: 'Skill not found' });
  if (req.body.password !== '1420') return res.status(403).json({ error: 'Wrong password' });
  const updated = db.updateSkill(req.params.id, { active: true });
  broadcast('skill:updated', updated);
  res.json({ ok: true, skill: updated });
});

// Get skill content (for preview/edit)
app.get('/api/skills/:id/content', (req, res) => {
  const s = db.getSkill(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ content: skillsMgr.readSkillContent(s) });
});

// Assign/remove skills on an agent
app.put('/api/agents/:id/skills', (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { skill_ids } = req.body;
  if (!Array.isArray(skill_ids)) return res.status(400).json({ error: 'skill_ids must be an array' });
  const updated = db.updateAgent(req.params.id, { skill_ids });
  broadcast('agent:updated', updated);
  res.json(updated);
});

// File browser — list .md/.txt files in a directory
app.get('/api/browse', (req, res) => {
  const dir = req.query.path || process.env.HOME || '/Users/friday';
  res.json({ path: dir, entries: skillsMgr.browseFiles(dir) });
});

// ── Crons ──────────────────────────────────────────────────────────────────
app.get('/api/crons', (req, res) => {
  const { agentId, boardId } = req.query;
  res.json(scheduler.getAll(agentId || null, boardId || null));
});

app.post('/api/crons/preview', (req, res) => {
  const { schedule } = req.body;
  if (!schedule) return res.json({ valid: false, error: 'Enter a schedule' });
  const expr = scheduler.humanToExpr(schedule) || schedule;
  const nodeCron = require('node-cron');
  if (!nodeCron.validate(expr)) return res.json({ valid: false, error: `Not recognized. Try "every day at 9am" or a cron expression like "0 9 * * *"` });
  res.json({ valid: true, expr, description: scheduler.describeExpr(expr), nextRun: scheduler.nextRunTime(expr) });
});

app.post('/api/crons', (req, res) => {
  const { agentId, name, schedule, prompt, enabled, boardId, skillIds } = req.body;
  if (!agentId || !schedule || !prompt) return res.status(400).json({ error: 'agentId, schedule, and prompt are required' });
  if (!db.getAgent(agentId)) return res.status(404).json({ error: 'Agent not found' });

  const expr = scheduler.humanToExpr(schedule) || schedule;
  const nodeCron = require('node-cron');
  if (!nodeCron.validate(expr)) return res.status(400).json({ error: `Invalid schedule: "${schedule}"` });

  const cronRecord = {
    id: uuidv4(), agent_id: agentId, board_id: boardId || db.DEFAULT_BOARD,
    name: name?.trim() || `${schedule} job`,
    schedule, prompt: prompt.trim(),
    enabled: enabled !== false,
    skill_ids: Array.isArray(skillIds) ? skillIds : [],
    created_at: new Date().toISOString(),
    last_run: null, last_run_id: null,
  };
  scheduler.add(cronRecord);
  broadcast('cron:created', db.getCron(cronRecord.id));
  res.status(201).json(db.getCron(cronRecord.id));
});

app.put('/api/crons/:id', (req, res) => {
  if (!db.getCron(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { name, schedule, prompt, enabled, skillIds } = req.body;
  const patch = { name, schedule, prompt, enabled };
  if (Array.isArray(skillIds)) patch.skill_ids = skillIds;
  const updated = scheduler.update(req.params.id, patch);
  broadcast('cron:updated', updated);
  res.json(updated);
});

app.delete('/api/crons/:id', (req, res) => {
  scheduler.remove(req.params.id);
  broadcast('cron:deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/crons/:id/run-now', (req, res) => {
  const c = db.getCron(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  try {
    const runId = runner.startRun(c.agent_id, c.prompt, { triggeredBy: 'cron-manual', cronId: c.id, skillIds: c.skill_ids });
    db.updateCron(c.id, { last_run: new Date().toISOString(), last_run_id: runId });
    res.json({ runId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Chat ───────────────────────────────────────────────────────────────────
app.get('/api/chatting', (req, res) => {
  const agents = db.getAgents();
  const chatting = agents.filter(a => runner.isChatting(a.id)).map(a => a.id);
  res.json(chatting);
});

app.get('/api/agents/:id/chat', (req, res) => {
  const chat = db.getChat(req.params.id);
  res.json({ messages: chat?.messages || [] });
});

app.post('/api/agents/:id/chat', (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
  if (!db.getAgent(req.params.id)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const msgId = runner.sendChatMessage(req.params.id, message.trim());
    res.json({ messageId: msgId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/agents/:id/chat', (req, res) => {
  runner.stopChat(req.params.id);
  db.clearChat(req.params.id);
  res.json({ ok: true });
});

app.post('/api/agents/:id/chat/stop', (req, res) => res.json({ ok: runner.stopChat(req.params.id) }));

// ── Integrations ───────────────────────────────────────────────────────────
app.get('/api/integrations/status', (req, res) => {
  const botInfo = telegram.getBotInfo();
  // Check if Composio key is set
  const envContent = (() => { try { return require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch { return ''; } })();
  const getKey = name => (envContent.match(new RegExp('^' + name + '=(.+)$', 'm')) || [])[1]?.trim();
  res.json({
    telegram: telegram.isConnected(),
    telegramUsername: botInfo?.username || null,
    telegramName: botInfo?.first_name || null,
    imessage: true,
    composio: !!getKey('COMPOSIO_API_KEY'),
    zapier: !!getKey('ZAPIER_API_KEY'),
    make: !!getKey('MAKE_API_KEY'),
    lovable: { connected: !!(getKey('LOVABLE_WEBHOOK') || getKey('LOVABLE_API_KEY')), webhook: getKey('LOVABLE_WEBHOOK') || '', hasKey: !!getKey('LOVABLE_API_KEY') },
    base44: { connected: !!(getKey('BASE44_WEBHOOK') || getKey('BASE44_API_KEY')), webhook: getKey('BASE44_WEBHOOK') || '', hasKey: !!getKey('BASE44_API_KEY') },
  });
});

app.post('/api/integrations/composio', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey?.trim()) return res.status(400).json({ error: 'API key is required' });
  // Save to .env
  const envPath = path.join(__dirname, '.env');
  try {
    let content = '';
    try { content = require('fs').readFileSync(envPath, 'utf8'); } catch {}
    if (content.includes('COMPOSIO_API_KEY=')) {
      content = content.replace(/^COMPOSIO_API_KEY=.*/m, `COMPOSIO_API_KEY=${apiKey.trim()}`);
    } else {
      content += `\nCOMPOSIO_API_KEY=${apiKey.trim()}`;
    }
    require('fs').writeFileSync(envPath, content);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Custom app connect/disconnect (Lovable, Base44 — stores webhook + API key)
app.post('/api/integrations/custom/:name', (req, res) => {
  const { name } = req.params;
  const { webhook, apiKey } = req.body;
  if (!webhook?.trim() && !apiKey?.trim()) return res.status(400).json({ error: 'Webhook URL or API key required' });
  const prefix = name.toUpperCase();
  const envPath = path.join(__dirname, '.env');
  try {
    let content = '';
    try { content = require('fs').readFileSync(envPath, 'utf8'); } catch {}
    // Save webhook
    if (webhook?.trim()) {
      const wKey = prefix + '_WEBHOOK';
      if (content.includes(wKey + '=')) content = content.replace(new RegExp('^' + wKey + '=.*', 'm'), `${wKey}=${webhook.trim()}`);
      else content += `\n${wKey}=${webhook.trim()}`;
    }
    // Save API key
    if (apiKey?.trim()) {
      const aKey = prefix + '_API_KEY';
      if (content.includes(aKey + '=')) content = content.replace(new RegExp('^' + aKey + '=.*', 'm'), `${aKey}=${apiKey.trim()}`);
      else content += `\n${aKey}=${apiKey.trim()}`;
    }
    require('fs').writeFileSync(envPath, content);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/integrations/custom/:name', (req, res) => {
  const prefix = req.params.name.toUpperCase();
  const envPath = path.join(__dirname, '.env');
  try {
    let content = require('fs').readFileSync(envPath, 'utf8');
    content = content.replace(new RegExp('^' + prefix + '_WEBHOOK=.*', 'm'), prefix + '_WEBHOOK=');
    content = content.replace(new RegExp('^' + prefix + '_API_KEY=.*', 'm'), prefix + '_API_KEY=');
    require('fs').writeFileSync(envPath, content);
  } catch {}
  res.json({ ok: true });
});

// Generic webhook integration connect/disconnect (Zapier, Make, etc.)
app.post('/api/integrations/:name', (req, res) => {
  const { name } = req.params;
  if (['telegram', 'composio'].includes(name)) return res.status(400).json({ error: 'Use dedicated endpoint' });
  const { apiKey } = req.body;
  if (!apiKey?.trim()) return res.status(400).json({ error: 'API key is required' });
  const envKey = name.toUpperCase() + '_API_KEY';
  const envPath = path.join(__dirname, '.env');
  try {
    let content = '';
    try { content = require('fs').readFileSync(envPath, 'utf8'); } catch {}
    if (content.includes(envKey + '=')) {
      content = content.replace(new RegExp('^' + envKey + '=.*', 'm'), `${envKey}=${apiKey.trim()}`);
    } else {
      content += `\n${envKey}=${apiKey.trim()}`;
    }
    require('fs').writeFileSync(envPath, content);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/integrations/composio', (req, res) => {
  const envPath = path.join(__dirname, '.env');
  try {
    let content = require('fs').readFileSync(envPath, 'utf8');
    content = content.replace(/^COMPOSIO_API_KEY=.*/m, 'COMPOSIO_API_KEY=');
    require('fs').writeFileSync(envPath, content);
  } catch {}
  res.json({ ok: true });
});

app.delete('/api/integrations/:name', (req, res, next) => {
  const { name } = req.params;
  if (name === 'telegram') return next(); // handled by dedicated route below
  const envKey = name.toUpperCase() + '_API_KEY';
  const envPath = path.join(__dirname, '.env');
  try {
    let content = require('fs').readFileSync(envPath, 'utf8');
    content = content.replace(new RegExp('^' + envKey + '=.*', 'm'), envKey + '=');
    require('fs').writeFileSync(envPath, content);
  } catch {}
  res.json({ ok: true });
});

app.post('/api/integrations/telegram', async (req, res) => {
  const { token } = req.body;
  if (!token?.trim()) return res.status(400).json({ error: 'token is required' });

  // Attempt live connection first — fail fast if token is wrong
  const result = await telegram.connect(token.trim());
  if (!result.ok) return res.status(400).json({ error: `Could not connect: ${result.error}` });

  // Persist token to .env so it survives restarts
  const envPath = path.join(__dirname, '.env');
  try {
    let content = '';
    try { content = require('fs').readFileSync(envPath, 'utf8'); } catch {}
    if (content.includes('TELEGRAM_BOT_TOKEN=')) {
      content = content.replace(/^TELEGRAM_BOT_TOKEN=.*/m, `TELEGRAM_BOT_TOKEN=${token.trim()}`);
    } else {
      content += `\nTELEGRAM_BOT_TOKEN=${token.trim()}`;
    }
    require('fs').writeFileSync(envPath, content);
  } catch (e) {
    console.warn('[telegram] Could not save token to .env:', e.message);
  }

  broadcast('integration:telegram', { connected: true, username: result.username });
  res.json({ ok: true, username: result.username, name: result.name });
});

app.delete('/api/integrations/telegram', async (req, res) => {
  await telegram.disconnect();

  // Clear token from .env
  const envPath = path.join(__dirname, '.env');
  try {
    let content = require('fs').readFileSync(envPath, 'utf8');
    content = content.replace(/^TELEGRAM_BOT_TOKEN=.*/m, 'TELEGRAM_BOT_TOKEN=');
    require('fs').writeFileSync(envPath, content);
  } catch {}

  broadcast('integration:telegram', { connected: false });
  res.json({ ok: true });
});

app.post('/api/imessage/incoming', (req, res) => {
  const { handle, text } = req.body;
  if (handle && text) imessage.handleIncoming(handle, text);
  res.json({ ok: true });
});

app.get('/api/imessage/feed', (req, res) => {
  res.json(imessage.getFeed());
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`\n  Agent Hub → http://${HOST}:${PORT}\n`);
  // Seed a COO for every existing board
  db.getBoards().forEach(b => coo.ensureCOO(b.id, b.name));
  scheduler.init();
  telegram.init();
  imessage.init();
});

process.on('SIGINT', () => { imessage.stop(); process.exit(0); });
