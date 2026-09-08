#!/bin/bash
# Rebuilds the fixture tasks.json for whatDidThePlannerReturn block tests.
set -euo pipefail
cd "$(dirname "$0")"

cat > tasks.json <<'EOF'
[
    {
        "taskNumber": 1,
        "files": ["src/owned.ts"],
        "clarifyRequest": "",
        "run": {
            "active": true,
            "worktree": "/tmp/fake-worktree",
            "leaseRunId": "run-1",
            "history": [
                {
                    "runId": "run-1",
                    "startedAt": "2026-01-01T00:00:00.000Z",
                    "endedAt": null,
                    "exitType": null,
                    "exitNote": null,
                    "modifiedFiles": [],
                    "commits": [],
                    "implementationNotesFile": null,
                    "taskTests": null,
                    "fullSuite": null,
                    "attempts": { "clarify": 0 }
                }
            ]
        }
    }
]
EOF
