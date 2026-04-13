# Agent Hub

A self-hosted AI agent orchestration dashboard for managing, chatting with, and monitoring Claude-powered agents in real time.

## What is Agent Hub?

Agent Hub is a local-first web dashboard that lets you create and manage multiple AI agents, each with their own system prompts, working directories, and capabilities. Agents run via the Claude CLI under the hood, and you interact with them through a clean browser UI.

Think of it as a control center for your AI workforce — assign tasks, schedule recurring jobs, chat in real time, and organize everything into boards.

## Features

- **Agent Management** — Create agents with custom system prompts, working directories, and models. Run tasks or have interactive chat sessions with any agent.
- **Boards** — Organize agents, tasks, and schedules into separate workspaces.
- **Live Chat** — Real-time conversations with agents via WebSocket streaming.
- **Task Board** — Create and track tasks with priorities, assignees, and statuses.
- **Skills** — Reusable prompt templates (inline, file, or folder-based) that can be attached to agents to shape their behavior.
- **Cron Schedules** — Schedule agents to run on recurring intervals using natural language (e.g. "every 30 minutes", "every weekday") or standard cron expressions.
- **COO Agent** — Each board gets a built-in Chief Operating Officer agent that has context about all other agents, tasks, and schedules on the board.
- **Telegram Integration** — Connect a Telegram bot to chat with your agents from anywhere.
- **iMessage Integration** — Route incoming iMessages to agents and send replies back (macOS only).
- **Third-Party Integrations** — Supports Composio, Zapier, Make, and custom webhook integrations via environment variables.
- **Auto-Updates** — Built-in update checker with one-click updates from the dashboard.
- **Runs as a Service** — Installs as a macOS launchd service that starts on boot and stays running in the background.

## Requirements

- macOS (launchd service support; iMessage integration is macOS-only)
- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kaiden-stowell/agent-hub/main/install.sh | bash
```

This will:
1. Clone the repo to `~/agent-hub`
2. Install dependencies
3. Register a launchd service so it runs on boot
4. Start the server on `http://127.0.0.1:12789`

## Configuration

Edit `~/agent-hub/.env` with your settings:

```env
# Required for agents
CLAUDE_BIN=/usr/local/bin/claude

# Optional integrations
TELEGRAM_BOT_TOKEN=
COMPOSIO_API_KEY=
ZAPIER_API_KEY=
MAKE_API_KEY=
```

## Usage

Open [http://127.0.0.1:12789](http://127.0.0.1:12789) in your browser.

From the dashboard you can:
- **Create agents** with custom prompts and working directories
- **Run tasks** — send one-shot prompts to agents and view the output
- **Chat** — have back-and-forth conversations with agents in real time
- **Manage tasks** — create, assign, and track work items
- **Add skills** — attach reusable prompt templates to agents
- **Schedule jobs** — set up cron-based recurring agent runs
- **Switch boards** — organize everything into separate workspaces

## Architecture

```
server.js          Express + WebSocket server, REST API
runner.js          Spawns Claude CLI processes for agent runs and chats
db.js              JSON file-based storage (data/db.json)
cron-scheduler.js  node-cron based job scheduler
skills-manager.js  Manages skill templates (inline, file, folder)
telegram.js        Telegram bot integration
imessage.js        iMessage bridge (reads macOS Messages database)
coo.js             COO (Chief Operating Officer) agent per board
public/            Frontend SPA (vanilla HTML/CSS/JS)
```

## Managing the Service

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.agent-hub.server.plist

# Start
launchctl load ~/Library/LaunchAgents/com.agent-hub.server.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.agent-hub.server.plist && \
launchctl load ~/Library/LaunchAgents/com.agent-hub.server.plist

# View logs
tail -f ~/agent-hub/logs/stdout.log
```

## License

MIT
