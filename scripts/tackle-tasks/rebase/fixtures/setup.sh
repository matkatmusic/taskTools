#!/bin/bash
# Rebuilds the fixture lock file and task state for pipeline-rebase block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git tasks.json
mkdir -p .git
cat > .git/taskTools-source.lock <<'EOF'
{"owner":"run-1:1","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
EOF

cat > tasks.json <<'EOF'
[
  {
    "taskNumber": 1,
    "title": "fixture",
    "files": [],
    "run": {
      "active": true,
      "worktree": null,
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
          "fullSuite": null
        }
      ]
    }
  }
]
EOF

mkdir -p worktree/plans
cat > worktree/plans/checkpoint.json <<'EOF'
{
  "taskNumber": 1, "passId": "fixture-pass", "runId": "run-1", "projectRoot": ".",
  "block": "pipeline-rebase.mmd::ARE_2_CONFLICT_FIXES_DONE_Q", "input": "",
  "state": "running", "sourceLockHeld": false, "exitType": "", "exitNote": "", "resumedFrom": null
}
EOF
