'use strict';
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const skills = require('./skills-manager');
let getCOOContextPrompt = null;

const activeRuns  = new Map(); // runId  -> { proc, agentId }
const activeChats = new Map(); // agentId -> proc
let broadcast = null;
const notifiers = {};
const chatDoneListeners = [];

function setBroadcast(fn)        { broadcast = fn; }
function registerNotifier(n, fn) { notifiers[n] = fn; }
function onChatDone(cb)          { chatDoneListeners.push(cb); }
function emit(event, data)       { if (broadcast) broadcast(event, data); }
function setCOOHelpers(ctxFn)    { getCOOContextPrompt = ctxFn; }

// ── Find claude binary ───────────────────────────────────────────────────────
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN))
    return process.env.CLAUDE_BIN;

  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'), // most common install location
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(process.env.HOME || '', '.npm', 'bin', 'claude'),
    path.join(process.env.HOME || '', 'node_modules', '.bin', 'claude'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to PATH lookup
  try {
    return require('child_process').execSync('which claude', { stdio: 'pipe' }).toString().trim();
  } catch {}
  return 'claude';
}

const CLAUDE_BIN = findClaude();
console.log(`[runner] claude binary: ${CLAUDE_BIN}`);

// ── Parse stream-json output ─────────────────────────────────────────────────
// Only reads text from `assistant` content blocks.
// The `result` field is the final summary — we skip it to avoid duplicates.
function parseStreamLines(raw) {
  const textParts = [];
  let cost = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);

      if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) textParts.push(block.text);
          else if (block.type === 'tool_use')       textParts.push(`\`[tool: ${block.name}]\``);
        }
      }

      // Only grab cost from result, not the text (text already emitted above)
      if (obj.type === 'result' && obj.total_cost_usd) {
        cost = obj.total_cost_usd;
      }
    } catch { /* not JSON, skip */ }
  }
  return { text: textParts.join(''), cost };
}

// ── Common spawn args ────────────────────────────────────────────────────────
function claudeArgs(model, prompt) {
  return [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',                          // required for stream-json in Claude Code 2.x
    '--model', model || 'claude-sonnet-4-6',
    '--dangerously-skip-permissions',
    prompt,
  ];
}

// ── Background Run ───────────────────────────────────────────────────────────
function startRun(agentId, prompt, opts = {}) {
  const runId = uuidv4();
  const agent = db.getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const workdir = agent.workdir || process.env.HOME || '/tmp';
  if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });

  const now = new Date().toISOString();
  db.insertRun({
    id: runId, agent_id: agentId, status: 'running',
    prompt, output: '', exit_code: null,
    started_at: now, finished_at: null,
    triggered_by: opts.triggeredBy || 'ui',
    task_id: opts.taskId || null,
  });
  db.updateAgent(agentId, { status: 'running', last_run_at: now, run_count: (agent.run_count || 0) + 1 });
  emit('run:started', { runId, agentId, agentName: agent.name, prompt });

  // Build prompt: role + skills context + (COO live state) + task
  let fullPrompt;
  // Merge extra skill IDs from cron/opts with agent's own skills
  const runAgent = opts.skillIds?.length
    ? { ...agent, skill_ids: [...new Set([...(agent.skill_ids || []), ...opts.skillIds])] }
    : agent;
  const skillsCtx = skills.buildSkillsContext(runAgent);
  if (agent.protected && getCOOContextPrompt) {
    fullPrompt = agent.prompt + skillsCtx + getCOOContextPrompt(agent.board_id) + '\n\n---\n\n' + prompt;
  } else {
    const systemCtx = [agent.prompt, agent.description ? `(${agent.description})` : ''].filter(Boolean).join('\n');
    fullPrompt = (systemCtx ? systemCtx : '') + skillsCtx + '\n\n---\n\n' + prompt;
  }

  const proc = spawn(CLAUDE_BIN, claudeArgs(agent.model, fullPrompt), {
    cwd: workdir,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeRuns.set(runId, { proc, agentId });
  let outputBuf = '';
  let totalCost = 0;

  function onData(raw) {
    const { text, cost } = parseStreamLines(raw);
    if (cost) totalCost = cost;
    if (text) {
      outputBuf += text;
      db.updateRun(runId, { output: outputBuf });
      emit('run:output', { runId, agentId, chunk: text });
    }
  }

  proc.stdout.on('data', d => onData(d.toString()));
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) {
      outputBuf += `\n[err] ${msg}`;
      db.updateRun(runId, { output: outputBuf });
      emit('run:output', { runId, agentId, chunk: `\n[err] ${msg}` });
    }
  });

  proc.on('close', code => {
    activeRuns.delete(runId);
    const status = code === 0 ? 'done' : 'error';
    db.updateRun(runId, { status, exit_code: code, finished_at: new Date().toISOString() });
    db.updateAgent(agentId, { status: 'idle' });

    if (opts.taskId) {
      db.updateTask(opts.taskId, { status: status === 'done' ? 'done' : 'todo', run_id: runId });
      emit('task:updated', db.getTask(opts.taskId));
    }

    emit('run:done', { runId, agentId, agentName: agent.name, status, output: outputBuf });

    const notify = JSON.parse(agent.notify_on || '["done","error"]');
    if (notify.includes(status))
      notifyAgent(agent, status, outputBuf.slice(0, 500) + (outputBuf.length > 500 ? '…' : ''), runId);
  });

  proc.on('error', err => {
    activeRuns.delete(runId);
    const msg = `Failed to start claude: ${err.message}\nBinary path: ${CLAUDE_BIN}`;
    db.updateRun(runId, { status: 'error', output: msg, finished_at: new Date().toISOString() });
    db.updateAgent(agentId, { status: 'idle' });
    emit('run:done', { runId, agentId, status: 'error', output: msg });
  });

  return runId;
}

function stopRun(runId) {
  const run = activeRuns.get(runId);
  if (!run) return false;
  run.proc.kill('SIGTERM');
  setTimeout(() => { try { run.proc.kill('SIGKILL'); } catch {} }, 3000);
  db.updateRun(runId, { status: 'stopped', finished_at: new Date().toISOString() });
  db.updateAgent(run.agentId, { status: 'idle' });
  activeRuns.delete(runId);
  emit('run:done', { runId, agentId: run.agentId, status: 'stopped' });
  return true;
}

function getActiveRuns() { return [...activeRuns.keys()]; }

// ── Chat ─────────────────────────────────────────────────────────────────────
function sendChatMessage(agentId, userText) {
  const agent = db.getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Kill any in-flight chat for this agent
  if (activeChats.has(agentId)) {
    try { activeChats.get(agentId).kill('SIGTERM'); } catch {}
    activeChats.delete(agentId);
  }

  // Persist user message
  const userMsg = { id: uuidv4(), role: 'user', content: userText, ts: new Date().toISOString() };
  db.appendChatMessage(agentId, userMsg);

  // Persist placeholder for assistant reply
  const assistantId = uuidv4();
  db.appendChatMessage(agentId, { id: assistantId, role: 'assistant', content: '', ts: new Date().toISOString(), streaming: true });

  emit('chat:start', { agentId, messageId: assistantId });

  // Build full prompt from history
  const chat = db.getChat(agentId);
  const history = (chat?.messages || []).filter(m => m.id !== assistantId);

  const skillsCtxChat = skills.buildSkillsContext(agent);
  let systemLines;
  if (agent.protected && getCOOContextPrompt) {
    systemLines = agent.prompt + skillsCtxChat + getCOOContextPrompt(agent.board_id) +
      '\nYou are in a direct chat. Be decisive and action-oriented. Use your Bash tools to take real actions when asked.';
  } else {
    systemLines = [
      agent.prompt || `You are ${agent.name}, a helpful AI agent.`,
      agent.description ? `Context: ${agent.description}` : '',
      'You are in a direct chat conversation. Be clear and concise.',
    ].filter(Boolean).join('\n') + skillsCtxChat;
  }

  let promptText = systemLines + '\n\n';
  if (history.length > 0) {
    for (const m of history) {
      promptText += `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}\n\n`;
    }
  }
  promptText += `Human: ${userText}\n\nAssistant:`;

  const workdir = agent.workdir || process.env.HOME || '/tmp';
  const proc = spawn(CLAUDE_BIN, claudeArgs(agent.model, promptText), {
    cwd: workdir,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeChats.set(agentId, proc);
  let replyBuf = '';

  proc.stdout.on('data', d => {
    const { text } = parseStreamLines(d.toString());
    if (text) {
      replyBuf += text;
      // Emit each chunk for streaming UI
      emit('chat:chunk', { agentId, messageId: assistantId, chunk: text });
    }
  });

  proc.stderr.on('data', () => {}); // suppress in chat

  proc.on('close', () => {
    activeChats.delete(agentId);
    const final = replyBuf.trim() || '(no response)';
    db.updateLastChatMessage(agentId, { content: final, streaming: false });
    emit('chat:done', { agentId, messageId: assistantId, content: final });
    for (const cb of chatDoneListeners) cb({ agentId, messageId: assistantId, content: final });
  });

  proc.on('error', err => {
    activeChats.delete(agentId);
    const errMsg = `Error starting claude: ${err.message}`;
    db.updateLastChatMessage(agentId, { content: errMsg, streaming: false });
    emit('chat:done', { agentId, messageId: assistantId, content: errMsg });
    for (const cb of chatDoneListeners) cb({ agentId, messageId: assistantId, content: errMsg });
  });

  return assistantId;
}

function stopChat(agentId) {
  if (!activeChats.has(agentId)) return false;
  try { activeChats.get(agentId).kill('SIGTERM'); } catch {}
  activeChats.delete(agentId);
  db.updateLastChatMessage(agentId, { content: '(stopped)', streaming: false });
  emit('chat:done', { agentId, content: '(stopped)' });
  return true;
}

function isChatting(agentId) { return activeChats.has(agentId); }

// ── Notifications ────────────────────────────────────────────────────────────
function notifyAgent(agent, status, summary, runId) {
  const msg = `Agent *${agent.name}* finished: *${status}*\n\n${summary}\n\nRun: \`${runId.slice(0, 8)}\``;
  if (agent.telegram_chat_id && notifiers.telegram) notifiers.telegram(agent.telegram_chat_id, msg);
  if (agent.imessage_handle  && notifiers.imessage)
    notifiers.imessage(agent.imessage_handle, msg.replace(/\*/g, '').replace(/`/g, ''));
}

module.exports = {
  startRun, stopRun, getActiveRuns,
  sendChatMessage, stopChat, isChatting,
  setBroadcast, registerNotifier, onChatDone, setCOOHelpers,
  CLAUDE_BIN,
};
