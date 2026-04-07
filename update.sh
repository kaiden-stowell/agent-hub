#!/bin/bash
# ── Agent Hub Update Script ───────────────────────────────────────────────
# Applies a version bundle to this agent-hub installation.
# Usage:
#   ./update.sh /path/to/versions/1.1.0
#   ./update.sh /path/to/versions/1.1.0 --no-restart
# ──────────────────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")"

SOURCE="$1"
NO_RESTART="$2"

if [ -z "$SOURCE" ]; then
  echo "Usage: ./update.sh <path-to-version-folder>"
  echo ""
  echo "Example: ./update.sh /Volumes/USB/versions/1.1.0"
  echo "         ./update.sh ~/Downloads/1.1.0"
  exit 1
fi

# Resolve to absolute path
SOURCE=$(cd "$SOURCE" && pwd)

if [ ! -f "$SOURCE/manifest.json" ]; then
  echo "Error: No manifest.json found in $SOURCE"
  echo "       Make sure you're pointing to a valid version folder."
  exit 1
fi

NEW_VERSION=$(node -p "require('$SOURCE/manifest.json').version")
CURRENT_VERSION="none"
[ -f version.json ] && CURRENT_VERSION=$(node -p "require('./version.json').version")

echo ""
echo "  Agent Hub Update"
echo "  ────────────────"
echo "  Current:  v${CURRENT_VERSION}"
echo "  Updating: v${NEW_VERSION}"
echo ""

# Create backup of current version
BACKUP="backups/${CURRENT_VERSION}_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP"

echo "  📦 Backing up current files to ${BACKUP}/"

# Backup existing app files
for f in server.js db.js runner.js coo.js cron-scheduler.js imessage.js telegram.js skills-manager.js package.json version.json start.sh; do
  [ -f "$f" ] && cp "$f" "$BACKUP/"
done
[ -d public ] && cp -r public "$BACKUP/public"

echo "  📥 Applying v${NEW_VERSION}..."

# Copy all files from the version bundle (skip manifest.json itself)
for f in "$SOURCE"/*.js "$SOURCE"/*.json "$SOURCE"/*.sh; do
  [ -f "$f" ] && {
    fname=$(basename "$f")
    [ "$fname" = "manifest.json" ] && continue
    cp "$f" .
  }
done

# Copy directories
[ -d "$SOURCE/public" ] && cp -r "$SOURCE/public" .

# Only copy skills if they don't already exist locally (preserve user skills)
if [ -d "$SOURCE/skills" ]; then
  mkdir -p skills
  for f in "$SOURCE"/skills/*; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    # Only copy if file doesn't exist (don't overwrite user's skill files)
    [ ! -f "skills/$fname" ] && cp "$f" "skills/$fname"
  done
fi

# Reinstall dependencies if package-lock changed
if ! diff -q "$SOURCE/package-lock.json" "$BACKUP/package.json" >/dev/null 2>&1; then
  echo "  📦 Installing dependencies..."
  npm install --production --silent 2>/dev/null || npm install --production
fi

echo ""
echo "  ✅ Updated to v${NEW_VERSION}"

# Restart the server
if [ "$NO_RESTART" != "--no-restart" ]; then
  echo "  🔄 Restarting server..."
  # Find and kill existing server
  PID=$(lsof -ti:12789 2>/dev/null || true)
  if [ -n "$PID" ]; then
    kill $PID 2>/dev/null || true
    sleep 1
  fi
  nohup node server.js > /tmp/agent-hub.log 2>&1 &
  sleep 2
  if curl -s -o /dev/null -w "" http://localhost:12789/api/stats 2>/dev/null; then
    echo "  🟢 Server is running on http://$(hostname -f 2>/dev/null || echo localhost):12789"
  else
    echo "  ⚠️  Server may not have started. Check /tmp/agent-hub.log"
  fi
else
  echo "  ℹ️  Skipped restart (--no-restart). Run: node server.js"
fi

echo ""
echo "  Backup saved to: ${BACKUP}/"
echo ""
