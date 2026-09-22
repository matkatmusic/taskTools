#!/bin/bash
# Rebuilds the fixture git repo and tasks.json for mergeSucceededExit block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git .taskTools .worktrees
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
git commit -q --allow-empty -m "fixture root commit"
git branch staging
git update-ref refs/taskTools/merged-commits/task-42 HEAD
# The chain starts before RECORD_MERGE_COMMIT_HASHES: run active, source lock held, lease guard folder present.
cat > .git/taskTools-source.lock <<'LOCK'
{"owner":"run-abc123:42","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
LOCK
mkdir -p .worktrees

mkdir -p .taskTools
cat > .taskTools/tasks.json <<'EOF'
[
    {
        "taskNumber": 42,
        "title": "fixture task",
        "run": {
            "active": true,
            "worktree": null,
            "leaseRunId": "run-abc123",
            "history": [
                {
                    "runId": "run-abc123",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "endedAt": null,
                    "exitType": null,
                    "exitNote": null,
                    "modifiedFiles": [],
                    "commits": [],
                    "implementationNotesFile": null,
                    "taskTests": null,
                    "fullSuite": null
                }
            ]
        }
    }
]
EOF
echo '[]' > .taskTools/completedTasks.json
