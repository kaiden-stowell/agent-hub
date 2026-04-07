#!/bin/bash
# ── Agent Hub Installer ───────────────────────────────────────────────────
# curl -fsSL https://raw.githubusercontent.com/kaiden-stowell/agent-hub/main/install.sh | bash
# ──────────────────────────────────────────────────────────────────────────

set -e

REPO="https://github.com/kaiden-stowell/agent-hub.git"
DEST="$HOME/agent-hub"

echo ""
echo "  Agent Hub Installer"
echo "  ────────────────────"
echo ""

# Check dependencies
for cmd in node npm git; do
  if ! command -v $cmd &>/dev/null; then
    echo "  Error: '$cmd' is required but not installed."
    exit 1
  fi
done

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  Error: Node.js 18+ required (found v$(node -v))"
  exit 1
fi

if [ -d "$DEST" ]; then
  echo "  Found existing install at $DEST"
  echo "  To update, use: cd $DEST && ./update.sh <version-folder>"
  echo ""
  read -p "  Overwrite code files? (data will be preserved) [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
  # Preserve data and .env
  TEMP_DATA=$(mktemp -d)
  [ -f "$DEST/.env" ] && cp "$DEST/.env" "$TEMP_DATA/.env"
  [ -d "$DEST/data" ] && cp -r "$DEST/data" "$TEMP_DATA/data"
fi

echo "  Downloading Agent Hub..."
if [ -d "$DEST/.git" ]; then
  cd "$DEST" && git pull --ff-only origin main
else
  rm -rf "$DEST"
  git clone "$REPO" "$DEST"
fi

cd "$DEST"

# Restore preserved data
if [ -d "${TEMP_DATA:-/nonexistent}" ]; then
  [ -f "$TEMP_DATA/.env" ] && cp "$TEMP_DATA/.env" .env
  [ -d "$TEMP_DATA/data" ] && cp -r "$TEMP_DATA/data" .
  rm -rf "$TEMP_DATA"
fi

echo "  Installing dependencies..."
npm install --production --silent 2>/dev/null || npm install --production

# Create data dir if fresh install
mkdir -p data
[ ! -f data/db.json ] && echo '{}' > data/db.json

# Create .env if missing
if [ ! -f .env ]; then
  cat > .env <<'ENVEOF'
# Agent Hub Configuration
# ANTHROPIC_API_KEY=sk-ant-...
# TELEGRAM_BOT_TOKEN=
# CLAUDE_BIN=/usr/local/bin/claude
ENVEOF
  echo ""
  echo "  ⚠️  Edit ~/.agent-hub/.env with your API keys:"
  echo "     nano $DEST/.env"
fi

chmod +x start.sh release.sh update.sh install.sh 2>/dev/null || true

VERSION=$(node -p "require('./version.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "  ✅ Agent Hub v${VERSION} installed to $DEST"
echo ""
echo "  To start:"
echo "    cd $DEST"
echo "    node server.js"
echo ""
echo "  Then open http://localhost:12789"
echo ""
