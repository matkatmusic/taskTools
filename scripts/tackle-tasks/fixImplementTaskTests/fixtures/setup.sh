#!/bin/bash
# Rebuilds the fixture task project and worktree for FIX_IMPLEMENT_TASK_TESTS block tests. No git needed: the block only reads tasks.json and a brief file.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf projectRoot worktree
mkdir -p projectRoot worktree/plans

cat > projectRoot/tasks.json <<'EOF'
[
  {
    "taskNumber": 1,
    "title": "fixture task",
    "modifiableFiles": ["a.ts"],
    "codexReviewNotes": "The task tests failed. Fix the cause, and change no test.\n\nfixture failing test output"
  }
]
EOF
echo "[]" > projectRoot/completedTasks.json

echo "# fixture brief" > worktree/plans/brief-1.md
echo "export const thing = 1;" > worktree/a.ts
