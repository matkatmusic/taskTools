#!/bin/bash
# Rebuilds the disposable task fixture PLAN_THE_TASK's template test reads.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .taskTools worktree
mkdir -p .taskTools worktree/plans
cat > .taskTools/tasks.json <<'EOF'
[
    { "taskNumber": 35, "modifiableFiles": ["src/thing.ts"], "createsFiles": ["src/thing.ts"], "tests": "node --test tests/thing.test.ts", "codexReviewNotes": "" }
]
EOF
echo "[]" > .taskTools/completedTasks.json
cat > worktree/plans/brief-35.md <<'EOF'
# fixture sentinel brief for task 35
EOF
