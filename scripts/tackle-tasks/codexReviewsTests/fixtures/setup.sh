#!/bin/bash
# Rebuilds the fixture git repos and task record CODEX_REVIEWS_TESTS's template test runs against.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git worktree

git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "fixture root" > .fixture-marker
git add -f .fixture-marker
git commit -q -m "root"

mkdir -p worktree/src worktree/tests worktree/plans
cd worktree
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "export const thing = 1;" > src/thing.ts
git add src/thing.ts
git commit -q -m "base"
git branch staging
git checkout -q -b task-1
echo "export const thing = 2;" > src/thing.ts
echo "// SENTINEL_TASK_TEST" > tests/thing.test.ts
echo "# brief" > plans/brief-1.md
echo "{}" > plans/plan.json
git add -A
git commit -q -m "task edit"
cd ..

cat > tasks.json <<JSON
[
  {
    "taskNumber": 1,
    "files": ["src/thing.ts"],
    "tests": "node --test tests/thing.test.ts",
    "run": {
      "active": true,
      "worktree": "$(pwd)/worktree",
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
          "taskTests": {
            "stepId": "RUN_TASK_TESTS",
            "testFiles": ["tests/thing.test.ts"],
            "createdTestFiles": ["tests/thing.test.ts"],
            "deletedTestFiles": [],
            "missingTests": false,
            "passed": true,
            "output": "SENTINEL_TASK_TEST_OUTPUT",
            "checkedAt": "2026-01-01T00:00:00.000Z"
          },
          "fullSuite": null
        }
      ]
    }
  }
]
JSON
