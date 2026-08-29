#!/bin/bash
# Rebuilds the fixture git repo and tasks.json for pipeline-failuresExit block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
git commit -q --allow-empty -m "fixture root"
git branch staging

active_task() {
    cat <<EOF
  {
    "taskNumber": $1,
    "title": "fixture",
    "run": {
      "active": true,
      "worktree": null,
      "leaseRunId": "run-fixture",
      "history": [
        {
          "runId": "run-fixture",
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
EOF
}

{
    echo "["
    active_task 900001
    echo ","
    active_task 900002
    echo ","
    active_task 900003
    echo "]"
} > tasks.json

echo "[]" > completedTasks.json
