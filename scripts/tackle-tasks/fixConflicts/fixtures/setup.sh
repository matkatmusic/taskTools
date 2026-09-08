#!/bin/bash
# Rebuilds the fixture source repo, lock file, and mid-merge-conflict worktree for FIX_CONFLICTS.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git worktree/.git

git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
git commit -q --allow-empty -m "root"
cat > .git/taskTools-source.lock <<'EOF'
{"owner":"run-1:1","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
EOF

mkdir -p worktree
cd worktree
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "line one" > conflict.txt
git add conflict.txt
git commit -q -m "base"
git checkout -q -b feature
echo "feature change" > conflict.txt
git commit -q -am "feature"
git checkout -q main
echo "main change" > conflict.txt
git commit -q -am "mainchange"
git merge feature -q -m "Merge branch 'feature'" || true
