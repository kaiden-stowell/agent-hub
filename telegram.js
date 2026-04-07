'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs     = require('fs');
const path   = require('path');
const db     = require('./db');
const runner = require('./runner');

let bot      = null;
let botInfo  = null; // { username, first_name }

function setBroadcast(fn) { /* available for future use */ }

// ── Reconnect at runtime (called from API) ──────────────────────────────────
async function connect(token) {
  // Stop any existing bot first
  if (bot) {
    try { await bot.stopPolling(); } catch {}
    bot = null; botInfo = null;
  }
  if (!token?.trim()) { return { ok: false, error: 'No token provided' }; }

  try {
    const TelegramBot = require('node-telegram-bot-api');
    const newBot = new TelegramBot(token.trim(), { polling: true });

    // Verify the token works — getMe will throw if it's invalid
    const me = await newBot.getMe();
    bot     = newBot;
    botInfo = me;
    _attachHandlers(bot);
    console.log(`[telegram] Connected as @${me.username}`);
    return { ok: true, username: me.username, name: me.first_name };
  } catch (e) {
    console.error('[telegram] Connection failed:', e.message);
    return { ok: false, error: e.message };
  }
}

async function disconnect() {
  if (!bot) return;
  try { await bot.stopPolling(); } catch {}
  bot = null; botInfo = null;
  console.log('[telegram] Disconnected');
}

// ── Startup init (reads from .env) ──────────────────────────────────────────
function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token?.trim()) {
    console.log('[telegram] No token — paste one in Settings → Integrations to enable.');
    return;
  }
  // Fire-and-forget async connect on startup
  connect(token).then(r => {
    if (!r.ok) console.error('[telegram] Startup connect failed:', r.error);
  });
}

// ── Message handlers ─────────────────────────────────────────────────────────
function _attachHandlers(b) {
  b.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();

    const allowed = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    if (allowed?.trim()) {
      if (!allowed.split(',').map(s => s.trim()).includes(chatId))
        return b.sendMessage(chatId, 'Unauthorized.');
    }
    if (!text) return;

    if (text === '/start' || text === '/help') {
      return b.sendMessage(chatId, [
        '*Agent Hub*', '',
        'Commands:',
        '/list — list all agents',
        '/run <id> <prompt> — run an agent',
        '/status — active runs',
        '/stop <run\\_id> — stop a run',
        '', 'Or: `@AgentName do something`',
      ].join('\n'), { parse_mode: 'Markdown' });
    }

    if (text === '/list') {
      const agents = db.getAgents().sort((a,b) => (a.name||'').localeCompare(b.name||''));
      if (!agents.length) return b.sendMessage(chatId, 'No agents yet.');
      return b.sendMessage(chatId,
        agents.map(a => `• *${a.name}* (\`${a.id.slice(0,8)}\`) — ${a.status}\n  ${a.description||'No description'}`).join('\n\n'),
        { parse_mode: 'Markdown' });
    }

    if (text === '/status') {
      const active = runner.getActiveRuns();
      if (!active.length) return b.sendMessage(chatId, 'No active runs.');
      return b.sendMessage(chatId, '*Active runs:*\n' +
        active.map(rid => { const r = db.getRun(rid); return r ? `• *${r.agent_name}*: \`${rid.slice(0,8)}\`` : `• \`${rid.slice(0,8)}\``; }).join('\n'),
        { parse_mode: 'Markdown' });
    }

    if (text.startsWith('/stop ')) {
      const run = db.getRuns({ status: 'running' }).find(r => r.id.startsWith(text.slice(6).trim()));
      if (!run) return b.sendMessage(chatId, 'Run not found.');
      runner.stopRun(run.id);
      return b.sendMessage(chatId, `Stopped \`${run.id.slice(0,8)}\``, { parse_mode: 'Markdown' });
    }

    if (text.startsWith('/run ')) {
      const parts = text.slice(5).trim().split(' ');
      const agent = db.getAgents().find(a => a.id.startsWith(parts[0]));
      if (!agent) return b.sendMessage(chatId, `Agent not found.`);
      const prompt = parts.slice(1).join(' ');
      if (!prompt) return b.sendMessage(chatId, 'Usage: /run <agent_id> <prompt>');
      try {
        const runId = runner.startRun(agent.id, prompt, { triggeredBy: 'telegram' });
        return b.sendMessage(chatId, `Started for *${agent.name}* (\`${runId.slice(0,8)}\`)`, { parse_mode: 'Markdown' });
      } catch (e) { return b.sendMessage(chatId, `Error: ${e.message}`); }
    }

    const atMatch = text.match(/^@(\S+)\s+([\s\S]+)$/);
    if (atMatch) {
      const agent = db.getAgents().find(a => a.name.toLowerCase() === atMatch[1].toLowerCase());
      if (!agent) return b.sendMessage(chatId, `@${atMatch[1]} not found. Use /list to see agents.`);
      try {
        const runId = runner.startRun(agent.id, atMatch[2], { triggeredBy: 'telegram' });
        return b.sendMessage(chatId, `Running @${agent.name}\\.\\.\\. (\`${runId.slice(0,8)}\`)`, { parse_mode: 'MarkdownV2' });
      } catch (e) { return b.sendMessage(chatId, `Error: ${e.message}`); }
    }

    const linked = db.getAgents().find(a => a.telegram_chat_id === chatId);
    if (linked) {
      try {
        const runId = runner.startRun(linked.id, text, { triggeredBy: 'telegram' });
        return b.sendMessage(chatId, `Running *${linked.name}*\\.\\.\\. (\`${runId.slice(0,8)}\`)`, { parse_mode: 'MarkdownV2' });
      } catch (e) { return b.sendMessage(chatId, `Error: ${e.message}`); }
    }

    b.sendMessage(chatId, 'Use /help for commands or @AgentName to run an agent.');
  });

  b.on('polling_error', err => console.error('[telegram] polling error:', err.message));

  runner.registerNotifier('telegram', (chatId, msg) => {
    b.sendMessage(chatId, msg, { parse_mode: 'Markdown' }).catch(() => {});
  });
}

function isConnected() { return bot !== null; }
function getBotInfo()  { return botInfo; }
function sendMessage(chatId, text) { if (bot) bot.sendMessage(chatId, text).catch(() => {}); }

module.exports = { init, connect, disconnect, isConnected, getBotInfo, sendMessage, setBroadcast };
