#!/bin/bash
# Rebuilds the fixture git repo and tasks.json for mergeSucceededExit block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git .taskTools
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
git commit -q --allow-empty -m "fixture root commit"
git branch staging
git update-ref refs/taskTools/merged-commits/task-42 HEAD

mkdir -p .taskTools
cat > .taskTools/tasks.json <<'EOF'
[
    {
        "taskNumber": 42,
        "title": "fixture task",
        "run": {
            "active": false,
            "worktree": null,
            "leaseRunId": null,
            "history": [
                {
                    "runId": "run-abc123",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "endedAt": "2026-01-01T00:10:00.000Z",
                    "exitType": "completed",
                    "exitNote": "All layers merged successfully.",
                    "modifiedFiles": [],
                    "commits": [
                        { "occurrenceId": "", "hash": "abc1234", "kind": "merge" }
                    ],
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
