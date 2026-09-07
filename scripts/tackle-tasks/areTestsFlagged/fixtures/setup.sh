#!/bin/bash
# Rebuilds the fixture tasks.json and checkpoint for areTestsFlagged block tests.
set -euo pipefail
cd "$(dirname "$0")"

cat > tasks.json <<'EOF2'
[
  { "taskNumber": 42, "files": ["src/thing.ts"], "codexReviewNotes": "" },
  {
    "taskNumber": 43, "files": ["src/thing.ts"], "codexReviewNotes": "",
    "run": {
      "active": true, "worktree": "/abs/worktree", "leaseRunId": "run-1",
      "history": [
        {
          "runId": "run-1", "startedAt": "2026-08-18T00:00:00", "endedAt": null, "exitType": null, "exitNote": null,
          "modifiedFiles": [], "commits": [], "implementationNotesFile": null, "taskTests": null, "fullSuite": null
        }
      ]
    }
  }
]
EOF2

mkdir -p worktree/plans
cat > worktree/plans/checkpoint.json <<'EOF2'
{
  "taskNumber": 43, "passId": "fixture-pass", "runId": "run-1", "projectRoot": ".",
  "block": "pipeline-areTestsFlagged.mmd::AMEND_ENTRY_WITH_CODEX_NOTES", "input": "",
  "state": "running", "sourceLockHeld": false, "exitType": "", "exitNote": "", "resumedFrom": null
}
EOF2
