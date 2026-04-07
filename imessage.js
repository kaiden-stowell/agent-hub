'use strict';
const { spawn } = require('child_process');
const { exec }  = require('child_process');
const path      = require('path');
const db        = require('./db');
const runner    = require('./runner');

// Apple's Core Data epoch starts 2001-01-01; chat.db stores nanoseconds from that date
const APPLE_EPOCH_OFFSET_S = 978307200;
function unixToAppleNs(unixMs) {
  return BigInt(Math.floor(unixMs / 1000 - APPLE_EPOCH_OFFSET_S)) * 1_000_000_000n;
}

const CHAT_DB = path.join(process.env.HOME || '/Users/friday', 'Library/Messages/chat.db');

// agentId -> iMessage handle waiting for a reply
const pendingReplies = new Map();

// In-memory feed of recent iMessage activity (max 200 items)
const MAX_FEED = 200;
const feed = [];
let broadcast = null;

function setBroadcast(fn) { broadcast = fn; }

function _addFeed(entry) {
  feed.push(entry);
  if (feed.length > MAX_FEED) feed.shift();
  // Persist to disk
  db.appendInboxMessage(entry);
  if (broadcast) broadcast('imessage:message', entry);
}

function getFeed() {
  // Return full persisted history, not just in-memory feed
  return db.getInboxMessages();
}

let pollTimer  = null;
let lastSeenNs = unixToAppleNs(Date.now());

// ── Send via AppleScript ────────────────────────────────────────────────────
function sendViaiMessage(handle, text) {
  const msg    = text.length > 2000 ? text.slice(0, 1997) + '…' : text;
  const safe   = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const chatId = `any;-;${handle}`;
  const script = `tell application "Messages"
  send "${safe}" to chat id "${chatId}"
end tell`;
  exec(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, (err, _stdout, stderr) => {
    if (err) console.error('[imessage] send error:', (stderr || err.message).slice(0, 150));
  });
}

// ── Agent lookup ────────────────────────────────────────────────────────────
function _findAgent(nameStr) {
  const name = nameStr.replace(/^@/, '').trim().toLowerCase();
  return db.getAgents().find(a => (a.name || '').toLowerCase() === name);
}

// ── Route a received message ────────────────────────────────────────────────
function handleIncoming(handle, text) {
  if (!text?.trim()) return;
  const t = text.trim();

  let agent  = null;
  let prompt = null;

  // Pattern 1: @AgentName message
  const atMatch = t.match(/^@(\S+)\s+([\s\S]+)$/);
  if (atMatch) {
    agent  = _findAgent(atMatch[1]);
    prompt = atMatch[2].trim();
  }

  // Pattern 2: AgentName: message
  if (!agent) {
    const colonMatch = t.match(/^([^:]+):\s+([\s\S]+)$/);
    if (colonMatch) {
      const candidate = _findAgent(colonMatch[1]);
      if (candidate) { agent = candidate; prompt = colonMatch[2].trim(); }
    }
  }

  // Pattern 3: Linked agent (imessage_handle set on agent matches this handle)
  if (!agent) {
    agent  = db.getAgents().find(a => a.imessage_handle === handle);
    prompt = t;
  }

  if (!agent || !prompt) {
    console.log(`[imessage] no agent matched for handle=${handle} text="${t.slice(0, 60)}"`);
    return;
  }

  console.log(`[imessage] routing "${prompt.slice(0, 60)}" → ${agent.name}`);
  _addFeed({ type: 'in', handle, agentName: agent.name, text: prompt, ts: new Date().toISOString() });

  try {
    const messageId = runner.sendChatMessage(agent.id, prompt);
    pendingReplies.set(messageId, { handle, agentName: agent.name });
  } catch (e) {
    sendViaiMessage(handle, `Error: ${e.message}`);
  }
}

// ── Poll chat.db for new incoming messages ──────────────────────────────────
function poll() {
  const since = lastSeenNs.toString();
  const sql   = `SELECT h.id,m.text,m.date FROM message m JOIN handle h ON m.handle_id=h.ROWID WHERE m.is_from_me=0 AND m.text IS NOT NULL AND m.text!='' AND m.date>${since} ORDER BY m.date ASC;`;

  const child  = spawn('sqlite3', [CHAT_DB]);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.stdin.write(sql + '\n');
  child.stdin.end();

  child.on('close', code => {
    if (code !== 0) {
      console.error('[imessage] poll sqlite3 error:', (err || `exit ${code}`).slice(0, 150));
      if (err.includes('unable to open') || err.includes('authorization')) {
        console.error('[imessage] Grant Terminal Full Disk Access in System Settings → Privacy & Security');
        stop();
      }
      return;
    }

    const rows = out.trim().split('\n').filter(Boolean);
    if (rows.length) console.log(`[imessage] poll found ${rows.length} new message(s)`);

    for (const row of rows) {
      const parts   = row.split('|');
      if (parts.length < 3) continue;
      const handle  = parts[0].trim();
      const dateStr = parts[parts.length - 1].trim();
      const text    = parts.slice(1, -1).join('|').trim();

      try {
        const dateNs = BigInt(dateStr);
        if (dateNs > lastSeenNs) lastSeenNs = dateNs;
      } catch {}

      handleIncoming(handle, text);
    }
  });
}

// ── Init / Stop ─────────────────────────────────────────────────────────────
function init() {
  runner.registerNotifier('imessage', (handle, text) => {
    sendViaiMessage(handle, text);
  });

  runner.onChatDone(({ messageId, content }) => {
    const pending = pendingReplies.get(messageId);
    if (!pending) return;
    pendingReplies.delete(messageId);
    if (!content || content === '(no response)' || content === '(stopped)') return;
    const { handle, agentName } = pending;
    console.log(`[imessage] reply sent to ${handle}`);
    _addFeed({ type: 'out', handle, agentName, text: content, ts: new Date().toISOString() });
    sendViaiMessage(handle, content);
  });

  // Look back 5 min to catch messages sent just before a restart
  lastSeenNs = unixToAppleNs(Date.now() - 5 * 60 * 1000);
  pollTimer  = setInterval(poll, 3000);
  console.log('[imessage] Polling chat.db every 3 s — send "@AgentName message" to chat with agents.');
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = { init, setBroadcast, sendViaiMessage, handleIncoming, getFeed, stop };
