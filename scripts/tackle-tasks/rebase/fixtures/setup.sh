#!/bin/bash
# Rebuilds the fixture lock file and task state for pipeline-rebase block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git tasks.json rebase-worktree
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo seed > seed.txt
git add seed.txt
git commit -q -m seed
git branch staging
git worktree add -q -b task-1 rebase-worktree staging
echo "task work" > rebase-worktree/task-work.txt
git -C rebase-worktree add task-work.txt
git -C rebase-worktree commit -q -m "task work"
cat > .git/taskTools-source.lock <<'EOF'
{"owner":"run-1:1","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
EOF

cat > tasks.json <<'EOF'
[
  {
    "taskNumber": 1,
    "title": "fixture",
    "modifiableFiles": [],
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
