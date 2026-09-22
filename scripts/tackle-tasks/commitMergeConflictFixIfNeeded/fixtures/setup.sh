#!/bin/bash
# Rebuilds the source repo, lock file, tasks.json and a task worktree stopped mid-rebase with its conflict hand-resolved but not staged.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git worktree .taskTools
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "base" > conflict.txt
git add conflict.txt
git commit -q -m "base"
git branch staging
cat > .git/taskTools-source.lock <<'LOCK'
{"owner":"run-1:1","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
LOCK

mkdir -p .taskTools
cat > .taskTools/tasks.json <<'JSON'
[
  {
    "taskNumber": 1,
    "title": "fixture",
    "modifiableFiles": ["conflict.txt"],
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
JSON

git worktree add -q -b task-1 worktree staging
echo "task change" > worktree/conflict.txt
git -C worktree commit -q -am "task change"
git checkout -q staging
echo "staging change" > conflict.txt
git commit -q -am "staging change"
git checkout -q main
git -C worktree rebase staging > /dev/null 2>&1 || true
echo "resolved" > worktree/conflict.txt
