#!/bin/bash
# ── Agent Hub Release Script ──────────────────────────────────────────────
# Bundles current agent-hub code into versions/<version>/ for distribution.
# Usage:
#   ./release.sh              → bumps patch  (1.0.0 → 1.0.1)
#   ./release.sh minor        → bumps minor  (1.0.1 → 1.1.0)
#   ./release.sh major        → bumps major  (1.1.0 → 2.0.0)
#   ./release.sh 2.5.0        → sets exact version
# ──────────────────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")"

CURRENT=$(node -p "require('./version.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

if [ -z "$1" ] || [ "$1" = "patch" ]; then
  PATCH=$((PATCH + 1))
elif [ "$1" = "minor" ]; then
  MINOR=$((MINOR + 1)); PATCH=0
elif [ "$1" = "major" ]; then
  MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0
else
  # Treat as exact version
  IFS='.' read -r MAJOR MINOR PATCH <<< "$1"
fi

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
DEST="versions/${NEW_VERSION}"

if [ -d "$DEST" ]; then
  echo "Error: version ${NEW_VERSION} already exists at ${DEST}"
  exit 1
fi

echo "Releasing v${NEW_VERSION}  (was v${CURRENT})"

# Update version.json
echo "{ \"version\": \"${NEW_VERSION}\" }" > version.json

# Update package.json version
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Create version directory
mkdir -p "$DEST"

# Copy application files (not data, node_modules, versions, or .env)
FILES=(
  server.js db.js runner.js coo.js ceo.js cron-scheduler.js
  imessage.js telegram.js skills-manager.js local-hubs.js
  package.json package-lock.json version.json
  start.sh update.sh
)

for f in "${FILES[@]}"; do
  [ -f "$f" ] && cp "$f" "$DEST/"
done

# Copy public folder
cp -r public "$DEST/public"

# Copy skills folder (templates only, not user data)
[ -d skills ] && cp -r skills "$DEST/skills"

# Write a manifest so update.sh knows what to do
cat > "$DEST/manifest.json" <<EOF
{
  "version": "${NEW_VERSION}",
  "released_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "files": [
    $(printf '"%s", ' "${FILES[@]}" | sed 's/, $//')
  ],
  "dirs": ["public", "skills"]
}
EOF

echo ""
echo "  ✅  v${NEW_VERSION} released to ${DEST}/"
echo ""
echo "  To update another machine:"
echo "    1. Copy the '${DEST}' folder to the other Mac Mini"
echo "    2. On that machine, run:  ./update.sh /path/to/${DEST}"
echo ""
