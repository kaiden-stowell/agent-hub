'use strict';
const cron = require('node-cron');
const db   = require('./db');
const runner = require('./runner');

// Map of cronId -> cron.ScheduledTask
const tasks = new Map();
let broadcast = null;

function setBroadcast(fn) { broadcast = fn; }
function emit(event, data) { if (broadcast) broadcast(event, data); }

function humanToExpr(human) {
  const lower = human.trim().toLowerCase();
  const map = {
    'every minute':        '* * * * *',
    'every 5 minutes':     '*/5 * * * *',
    'every 10 minutes':    '*/10 * * * *',
    'every 15 minutes':    '*/15 * * * *',
    'every 30 minutes':    '*/30 * * * *',
    'every hour':          '0 * * * *',
    'every 2 hours':       '0 */2 * * *',
    'every 3 hours':       '0 */3 * * *',
    'every 4 hours':       '0 */4 * * *',
    'every 6 hours':       '0 */6 * * *',
    'every 12 hours':      '0 */12 * * *',
    'every day':           '0 9 * * *',
    'daily':               '0 9 * * *',
    'every day at noon':   '0 12 * * *',
    'every day at midnight':'0 0 * * *',
    'every monday':        '0 9 * * 1',
    'every tuesday':       '0 9 * * 2',
    'every wednesday':     '0 9 * * 3',
    'every thursday':      '0 9 * * 4',
    'every friday':        '0 9 * * 5',
    'every saturday':      '0 9 * * 6',
    'every sunday':        '0 9 * * 0',
    'every weekday':       '0 9 * * 1-5',
    'every weekend':       '0 9 * * 0,6',
    'every week':          '0 9 * * 1',
    'hourly':              '0 * * * *',
    'weekly':              '0 9 * * 1',
  };
  if (map[lower]) return map[lower];

  // Parse "every N minutes/hours"
  let m = lower.match(/^every\s+(\d+)\s+minutes?$/);
  if (m) return `*/${m[1]} * * * *`;
  m = lower.match(/^every\s+(\d+)\s+hours?$/);
  if (m) return `0 */${m[1]} * * *`;

  // Parse "every day at <time>" / "daily at <time>"
  m = lower.match(/^(?:every\s+day|daily)\s+at\s+(.+)$/);
  if (m) { const t = parseTime(m[1]); if (t) return `${t.min} ${t.hour} * * *`; }

  // Parse "every <weekday> at <time>"
  const dayMap = { sun:0, sunday:0, mon:1, monday:1, tue:2, tuesday:2, wed:3, wednesday:3, thu:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };
  m = lower.match(/^every\s+(\w+)\s+at\s+(.+)$/);
  if (m && dayMap[m[1]] !== undefined) { const t = parseTime(m[2]); if (t) return `${t.min} ${t.hour} * * ${dayMap[m[1]]}`; }

  // Parse "every weekday/weekend at <time>"
  m = lower.match(/^every\s+(weekday|weekend)\s+at\s+(.+)$/);
  if (m) { const t = parseTime(m[2]); if (t) return `${t.min} ${t.hour} * * ${m[1] === 'weekday' ? '1-5' : '0,6'}`; }

  // If it looks like a cron expression already (5 fields), return as-is
  if (/^[\d\*\/,\-\s]+$/.test(human) && human.trim().split(/\s+/).length === 5) return human.trim();
  return null;
}

function parseTime(str) {
  str = str.trim().toLowerCase();
  if (str === 'noon') return { hour: 12, min: 0 };
  if (str === 'midnight') return { hour: 0, min: 0 };
  // "3pm", "3:30pm", "15:00", "9am", "10:30 am"
  let m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  const ampm = m[3];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || min < 0 || min > 59) return null;
  return { hour, min };
}

function describeExpr(expr) {
  // Reverse-map a cron expression to a human-readable description
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Every N minutes
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return `Every ${min.slice(2)} minutes`;
  // Every minute
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every minute';
  // Every N hours
  if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*')
    return `Every ${hour.slice(2)} hours`;
  // Hourly
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every hour';

  const timeStr = formatTime(parseInt(hour), parseInt(min));
  if (!timeStr) return expr;

  // Daily
  if (dom === '*' && mon === '*' && dow === '*')
    return `Daily at ${timeStr}`;
  // Weekdays
  if (dom === '*' && mon === '*' && dow === '1-5')
    return `Weekdays at ${timeStr}`;
  // Weekends
  if (dom === '*' && mon === '*' && dow === '0,6')
    return `Weekends at ${timeStr}`;
  // Specific day
  if (dom === '*' && mon === '*' && /^\d$/.test(dow))
    return `Every ${dayNames[parseInt(dow)]} at ${timeStr}`;

  return expr;
}

function formatTime(hour, min) {
  if (isNaN(hour) || isNaN(min)) return null;
  const ampm = hour >= 12 ? 'pm' : 'am';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return min === 0 ? `${h}${ampm}` : `${h}:${String(min).padStart(2,'0')}${ampm}`;
}

function nextRunTime(expr) {
  // Calculate next run time from a cron expression
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minP, hourP, domP, monP, dowP] = parts;

  const now = new Date();
  // Check each minute for the next 8 days (11520 iterations max)
  for (let i = 1; i <= 11520; i++) {
    const candidate = new Date(now.getTime() + i * 60000);
    candidate.setSeconds(0, 0);
    if (matchesCronField(minP, candidate.getMinutes()) &&
        matchesCronField(hourP, candidate.getHours()) &&
        matchesCronField(domP, candidate.getDate()) &&
        matchesCronField(monP, candidate.getMonth() + 1) &&
        matchesCronField(dowP, candidate.getDay())) {
      return candidate.toISOString();
    }
  }
  return null;
}

function matchesCronField(field, value) {
  if (field === '*') return true;
  return field.split(',').some(part => {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const s = parseInt(step);
      if (range === '*') return value % s === 0;
      return false;
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(part) === value;
  });
}

function scheduleOne(cronRecord) {
  // Cancel existing if any
  if (tasks.has(cronRecord.id)) {
    tasks.get(cronRecord.id).stop();
    tasks.delete(cronRecord.id);
  }
  if (!cronRecord.enabled) return;

  const expr = humanToExpr(cronRecord.schedule) || cronRecord.schedule;
  if (!cron.validate(expr)) {
    console.warn(`[cron] Invalid expression for cron ${cronRecord.id}: "${expr}"`);
    return;
  }

  const task = cron.schedule(expr, async () => {
    console.log(`[cron] Firing "${cronRecord.name}" → agent ${cronRecord.agent_id}`);
    try {
      const runId = runner.startRun(cronRecord.agent_id, cronRecord.prompt, { triggeredBy: 'cron', cronId: cronRecord.id, skillIds: cronRecord.skill_ids });
      db.updateCron(cronRecord.id, { last_run: new Date().toISOString(), last_run_id: runId });
      emit('cron:fired', { cronId: cronRecord.id, runId, agentId: cronRecord.agent_id });
    } catch (e) {
      console.error(`[cron] Error firing cron ${cronRecord.id}:`, e.message);
    }
  });

  tasks.set(cronRecord.id, task);
  console.log(`[cron] Scheduled "${cronRecord.name}" (${expr})`);
}

function init() {
  const crons = db.getCrons();
  for (const c of crons) scheduleOne(c);
  console.log(`[cron] Loaded ${crons.filter(c => c.enabled).length} active schedules`);
}

function add(cronRecord) {
  db.insertCron(cronRecord);
  scheduleOne(cronRecord);
}

function update(id, patch) {
  const updated = db.updateCron(id, patch);
  if (updated) scheduleOne(updated);
  return updated;
}

function remove(id) {
  if (tasks.has(id)) { tasks.get(id).stop(); tasks.delete(id); }
  db.deleteCron(id);
}

function getAll(agentId, boardId) { return db.getCrons(agentId, boardId); }

module.exports = { init, add, update, remove, getAll, setBroadcast, humanToExpr, describeExpr, nextRunTime };
