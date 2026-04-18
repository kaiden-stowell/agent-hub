'use strict';
const db = require('./db');

const DEFAULT_BOARD = db.DEFAULT_BOARD;
const HUB_URL       = 'http://127.0.0.1:12789';

function getCEOId(boardId) {
  return boardId === DEFAULT_BOARD
    ? 'ceo-agent-00000000-0000-0000-0000-000000000000'
    : 'ceo-agent-' + boardId;
}

function ensureCEO(boardId, boardName) {
  boardId   = boardId   || DEFAULT_BOARD;
  boardName = boardName || (db.getBoard(boardId)?.name) || 'Default';
  const ceoId    = getCEOId(boardId);
  const existing = db.getAgent(ceoId);
  if (existing) {
    if (existing.role !== 'ceo') db.updateAgent(ceoId, { role: 'ceo', protected: true });
    return db.getAgent(ceoId);
  }

  const ceo = {
    id:          ceoId,
    board_id:    boardId,
    name:        'CEO',
    description: `Chief Executive Officer for ${boardName}`,
    emoji:       '👑',
    role:        'ceo',
    prompt:      buildCEOPrompt(),
    workdir:     process.env.HOME || require('os').homedir(),
    model:       'claude-opus-4-6',
    tags:        '["executive","strategy","leadership"]',
    telegram_chat_id: null,
    imessage_handle:  null,
    notify_on:   '["done","error"]',
    status:      'idle',
    run_count:   0,
    total_cost_cents: 0,
    protected:   true,
    skill_ids:   [],
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
    last_run_at: null,
  };

  db.insertAgent(ceo);
  console.log(`[ceo] CEO seeded for board "${boardName}" (${boardId})`);
  return ceo;
}

function buildCEOPrompt() {
  return `You are the CEO (Chief Executive Officer) of this AI company running on Agent Hub. You are the top of the org chart.

Your job is strategy and direction. The COO handles day-to-day operations and hiring; you set the vision and make final calls on ambiguous decisions.

## Chain of command
- You are the CEO. You report to no one.
- The COO reports to you. Delegate operational work to the COO.
- The COO manages all other agents (workers).
- You can talk directly to any agent, but prefer to delegate through the COO for operational tasks.

## When to act yourself vs delegate
- **You act**: strategy, prioritization between competing goals, judgment calls on ambiguous user requests, direct user communication when it matters
- **Delegate to COO**: hiring agents, assigning tasks, scheduling recurring work, operational follow-up
- **Delegate to specialist agents**: any domain-specific work (only if you know the right agent exists — otherwise ask the COO to handle staffing)

## Hub API (available via Bash)
Base URL: ${HUB_URL}

### See the full team
  curl -s ${HUB_URL}/api/agents | jq '.[] | {id, name, role, description, status}'

### Talk to the COO
  curl -s -X POST ${HUB_URL}/api/agents/COO_AGENT_ID/chat \\
    -H "Content-Type: application/json" \\
    -d '{"message":"Your delegation to the COO here"}'

### Delegate a high-level goal to the COO (operational path)
  curl -s -X POST ${HUB_URL}/api/tasks \\
    -H "Content-Type: application/json" \\
    -d '{"title":"Goal title","description":"What you want achieved and why","agent_id":"COO_AGENT_ID","priority":"high"}'

### Run any agent directly (emergency override)
  curl -s -X POST ${HUB_URL}/api/runs \\
    -H "Content-Type: application/json" \\
    -d '{"agentId":"AGENT_ID","prompt":"What to do"}'

## Style
- Be concise and direct. You're the CEO — speak like one.
- Give the why, not just the what. Your team needs context to make good decisions.
- You CANNOT be deleted — you are essential to this company.
`;
}

function getCEOContextPrompt(boardId) {
  boardId = boardId || DEFAULT_BOARD;
  const ceoId  = getCEOId(boardId);
  const agents = db.getAgents({ board_id: boardId });
  const coo    = agents.find(a => a.role === 'coo');
  const workers = agents.filter(a => a.id !== ceoId && a.role !== 'coo');
  const tasks  = db.getTasks({ board_id: boardId }).filter(t => t.status !== 'done').slice(0, 20);

  const cooLine = coo ? `  - COO (${coo.id}): ${coo.description || ''} [${coo.status}]` : '  (no COO seeded)';
  const workerList = workers.length
    ? workers.map(a => `  - ${a.name} (${a.id.slice(0,8)}): ${a.description || a.prompt.slice(0,80)} [${a.status}]`).join('\n')
    : '  (no worker agents yet — ask the COO to hire some)';
  const taskList = tasks.length
    ? tasks.map(t => `  - [${t.status}] ${t.title} → ${t.agent_name || 'unassigned'} [${t.priority}]`).join('\n')
    : '  (no active tasks)';

  return `\n\n## Your Reports\n### COO (your direct report)\n${cooLine}\n\n### Workers (managed by COO)\n${workerList}\n\n## Active Tasks\n${taskList}\n`;
}

module.exports = { ensureCEO, getCEOId, getCEOContextPrompt, HUB_URL, DEFAULT_BOARD };
