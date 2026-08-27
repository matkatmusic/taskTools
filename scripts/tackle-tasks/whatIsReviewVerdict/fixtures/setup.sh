#!/bin/bash
# Rebuilds throwaway tasks.json/plan.json/review fixtures for whatIsReviewVerdict block tests.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p worktree

cat > tasks.json <<'EOF'
[
  {
    "taskNumber": 42,
    "title": "fixture task",
    "codexReviewNotes": "",
    "run": {
      "active": true,
      "worktree": null,
      "leaseRunId": null,
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
          "attempts": {}
        }
      ]
    }
  }
]
EOF

cat > completedTasks.json <<'EOF'
[]
EOF

cat > plan.json <<'EOF'
{
  "task": 42,
  "revision": 1,
  "createsFiles": [],
  "sections": [
    { "id": "step-1", "title": "Step 1", "body": "Do the thing.", "codexNotes": "" }
  ]
}
EOF

cat > codex-review.json <<'EOF'
{
  "outcome": "OK",
  "missingFiles": [],
  "message": "",
  "issues": [],
  "fixes": [],
  "sectionsThatHoldUp": ["step-1 verified"]
}
EOF
