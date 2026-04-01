#!/bin/bash
# deploy.sh — Replaces EF-Workshop files with the latest downloaded zip,
# then stages all changes for GitHub Desktop.

set -e

DOWNLOADS="$HOME/Downloads"
PROJECT="$HOME/Documents/EF-Workshop"

# ── 1. Find the most recent zip in Downloads ──
ZIP=$(ls -t "$DOWNLOADS"/*.zip 2>/dev/null | head -1)

if [ -z "$ZIP" ]; then
  echo "❌ No zip files found in $DOWNLOADS"
  exit 1
fi

echo "📦 Using zip: $(basename "$ZIP")"
echo ""

# ── 2. Extract to a temp folder ──
TEMP_DIR=$(mktemp -d)
unzip -q "$ZIP" -d "$TEMP_DIR"

# Handle the single-folder-inside-zip structure
CONTENTS=("$TEMP_DIR"/*)
if [ ${#CONTENTS[@]} -eq 1 ] && [ -d "${CONTENTS[0]}" ]; then
  SOURCE="${CONTENTS[0]}"
else
  SOURCE="$TEMP_DIR"
fi

echo "📂 Extracted to temp folder"

# ── 3. Delete old files from EF-Workshop (preserve .git and deploy.sh) ──
cd "$PROJECT"

# Remove everything except .git, .gitignore, and this script
find . -maxdepth 1 ! -name '.' ! -name '.git' ! -name '.gitignore' ! -name 'deploy.sh' ! -name '.DS_Store' -exec rm -rf {} +

echo "🗑️  Cleared old files"

# ── 4. Copy new files in ──
# Copy everything from the extracted folder (except .git if present)
rsync -a --exclude='.git' --exclude='.gitignore' --exclude='deploy.sh' "$SOURCE/" "$PROJECT/"

echo "✅ New files copied to EF-Workshop"

# ── 5. Stage all changes in git ──
cd "$PROJECT"
git add -A

echo ""
echo "📋 Changes staged. Here's a summary:"
echo ""
git status --short
echo ""
echo "✅ Done! Open GitHub Desktop to review, commit, and push."

# ── 6. Clean up ──
rm -rf "$TEMP_DIR"
