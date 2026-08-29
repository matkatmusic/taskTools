#!/bin/bash
# Rebuilds the disposable git fixture for runFullSuite block tests: a source repo (task 1,
# run-1 active) plus a standalone worktree repo with a dirty file to commit, a task-owned
# edit already committed, and a passing test script.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git .taskTools worktree

git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "fixture root" > .fixture-marker
git add -f .fixture-marker
git commit -q -m "root"
git branch staging
cat > .git/taskTools-source.lock <<'EOF'
{"owner":"run-1:1","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
EOF
git update-ref refs/taskTools/merged-commits/task-1 "$(git rev-parse HEAD)"

mkdir -p .taskTools
cat > .taskTools/tasks.json <<'EOF'
[
    {
        "taskNumber": 1,
        "files": ["src/thing.ts"],
        "run": {
            "active": true,
            "worktree": "scripts/tackle-tasks/runFullSuite/fixtures/worktree",
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
                    "attempts": {}
                }
            ]
        }
    }
]
EOF

mkdir -p worktree/src worktree/plans
cd worktree
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
cat > package.json <<'EOF'
{"name": "run-full-suite-fixture", "private": true, "scripts": {"test": "true"}}
EOF
echo "export const thing = 1;" > src/thing.ts
git add package.json src/thing.ts
git commit -q -m "base"
git branch staging
git checkout -q -b task-1
echo "export const thing = 2;" > src/thing.ts
git commit -q -am "task edit"
echo "brief" > plans/brief-1.md
echo "fixed" > fixed.txt
cat > plans/checkpoint.json <<'EOF'
{
  "taskNumber": 1, "passId": "fixture-pass", "runId": "run-1", "projectRoot": "scripts/tackle-tasks/runFullSuite/fixtures",
  "block": "pipeline-runFullSuite.mmd::ARE_2_SUITE_FIXES_DONE_Q", "input": "",
  "state": "running", "sourceLockHeld": false, "exitType": "", "exitNote": "", "resumedFrom": null
}
EOF
