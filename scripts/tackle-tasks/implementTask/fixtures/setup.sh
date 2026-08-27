#!/bin/bash
# Rebuilds the fixture task and brief IMPLEMENT_TASK's template test reads.
set -euo pipefail
cd "$(dirname "$0")"

rm -f worktree/plans/IMPLEMENT_TASK.prompt.md
mkdir -p .taskTools worktree/plans
cat > .taskTools/tasks.json <<'EOF'
[
    { "taskNumber": 42, "files": ["src/thing.ts"] }
]
EOF
cat > worktree/plans/brief-42.md <<'EOF'
# Brief for task 42

Write `src/thing.ts`.
EOF
