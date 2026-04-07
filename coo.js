'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const DEFAULT_BOARD = db.DEFAULT_BOARD;
const HUB_URL       = 'http://127.0.0.1:12789';

// Stable COO ID per board — default board keeps the legacy ID
function getCOOId(boardId) {
  return boardId === DEFAULT_BOARD
    ? 'coo-agent-00000000-0000-0000-0000-000000000001'
    : 'coo-agent-' + boardId;
}

// Seed the COO for a given board if it doesn't exist yet
function ensureCOO(boardId, boardName) {
  boardId   = boardId   || DEFAULT_BOARD;
  boardName = boardName || (db.getBoard(boardId)?.name) || 'Default';
  const cooId   = getCOOId(boardId);
  const existing = db.getAgent(cooId);
  if (existing) return existing;

  const coo = {
    id:          cooId,
    board_id:    boardId,
    name:        'COO',
    description: `Chief Operating Officer for ${boardName}`,
    prompt:      buildCOOPrompt(),
    workdir:     process.env.HOME || '/Users/friday',
    model:       'claude-sonnet-4-6',
    tags:        '["executive","management","automation"]',
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

  db.insertAgent(coo);
  console.log(`[coo] COO seeded for board "${boardName}" (${boardId})`);
  return coo;
}

function buildCOOPrompt() {
  return `You are the COO (Chief Operating Officer) of this AI company running on Agent Hub.

You manage a team of AI agents. You can:

1. **Hire new agents** — create specialist agents for any task
2. **Assign tasks** — delegate work to existing agents or handle it yourself
3. **Run agents** — trigger any agent immediately
4. **Check status** — see what agents and tasks exist
5. **Schedule recurring jobs** — set up cron schedules for agents

## Hub API (available via Bash)
Base URL: ${HUB_URL}

### See your team
  curl -s ${HUB_URL}/api/agents | jq '.[] | {id, name, description, status}'

### Hire a new agent
  curl -s -X POST ${HUB_URL}/api/agents \\
    -H "Content-Type: application/json" \\
    -d '{"name":"Agent Name","prompt":"System prompt / role","description":"One-liner","model":"claude-sonnet-4-6","workdir":"${process.env.HOME || '/Users/friday'}"}'

### Create and assign a task
  curl -s -X POST ${HUB_URL}/api/tasks \\
    -H "Content-Type: application/json" \\
    -d '{"title":"Task title","description":"Details","agent_id":"AGENT_ID","priority":"high"}'

### Start a task
  curl -s -X POST ${HUB_URL}/api/tasks/TASK_ID/start

### Run any agent directly
  curl -s -X POST ${HUB_URL}/api/runs \\
    -H "Content-Type: application/json" \\
    -d '{"agentId":"AGENT_ID","prompt":"What to do"}'

### Add a cron schedule
  curl -s -X POST ${HUB_URL}/api/crons \\
    -H "Content-Type: application/json" \\
    -d '{"agentId":"AGENT_ID","name":"Schedule name","schedule":"every day at 9am","prompt":"What to do each time","enabled":true}'

### Check recent runs
  curl -s "${HUB_URL}/api/runs?limit=10" | jq '.[] | {id, agent_name, status, prompt}'

## Decision process
When given a goal or instruction:
1. Decide if it needs a specialist agent or if you can do it yourself
2. If delegating: check if a suitable agent already exists, otherwise hire one
3. Create a clear task with context and assign it
4. If urgent, start it immediately
5. Report back with what you did and who is handling it

## Important
- Always use jq for readable JSON output
- Write clear detailed prompts when hiring agents
- Keep task descriptions specific and actionable
- You CANNOT be deleted — you are essential to operations
`;
}

// Called at chat/run time — inject current board state into the COO's context
function getCOOContextPrompt(boardId) {
  boardId = boardId || DEFAULT_BOARD;
  const cooId  = getCOOId(boardId);
  const agents = db.getAgents({ board_id: boardId }).filter(a => a.id !== cooId);
  const tasks  = db.getTasks({ board_id: boardId }).filter(t => t.status !== 'done').slice(0, 20);
  const crons  = db.getCrons(null, boardId);

  const agentList = agents.length
    ? agents.map(a => `  - ${a.name} (${a.id.slice(0,8)}): ${a.description || a.prompt.slice(0,80)} [${a.status}]`).join('\n')
    : '  (no agents hired yet)';

  const taskList = tasks.length
    ? tasks.map(t => `  - [${t.status}] ${t.title} → ${t.agent_name || 'unassigned'} [${t.priority}]`).join('\n')
    : '  (no active tasks)';

  const cronList = crons.length
    ? crons.map(c => `  - ${c.name} → ${c.agent_name || c.agent_id} every ${c.schedule} [${c.enabled ? 'on' : 'off'}]`).join('\n')
    : '  (no schedules)';

  return `\n\n## Current Team\n${agentList}\n\n## Active Tasks\n${taskList}\n\n## Scheduled Jobs\n${cronList}\n`;
}

module.exports = { ensureCOO, getCOOId, getCOOContextPrompt, HUB_URL, DEFAULT_BOARD };
