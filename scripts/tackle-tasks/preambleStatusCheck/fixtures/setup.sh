#!/bin/bash
# Rebuilds the static tasks.json read by the IS_TASK_BLOCKED_Q and IS_TASK_ACTIVE_Q templates.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p .taskTools
cat > .taskTools/tasks.json <<'EOF'
[
  {
    "taskNumber": 1,
    "title": "fixture task",
    "modifiableFiles": [],
    "run": {
      "active": false,
      "worktree": null,
      "leaseRunId": null,
      "history": []
    }
  }
]
EOF
