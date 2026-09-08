#!/bin/bash
# Rebuilds the disposable fixture repos + tasks.json seeds for commitImplementationIfNeeded block tests.
set -euo pipefail
cd "$(dirname "$0")"

# --- commit/: COMMIT_IMPLEMENTATION_IF_NEEDED needs a dirty task worktree waiting to be committed ---
rm -rf commit
mkdir -p commit/root/.taskTools
git init -q -b main commit/root
git -C commit/root config user.name fixture
git -C commit/root config user.email fixture@example.com
cat > commit/root/.taskTools/tasks.json <<'JSON'
[
  {
    "taskNumber": 1,
    "title": "fixture task 1",
    "schemaVersion": "1.0.1",
    "hasTests": true,
    "modifiableFiles": ["src/thing.ts"],
    "run": {
      "active": true,
      "worktree": "commit/worktree",
      "leaseRunId": "run-1",
      "history": [
        {
          "runId": "run-1",
          "startedAt": "2026-01-01T00:00:00+00:00",
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
echo fixture > commit/root/.fixture-marker
git -C commit/root add -A
git -C commit/root commit -q -m root
git -C commit/root branch staging
git -C commit/root worktree add -q -b task-1 ../worktree main
mkdir -p commit/worktree/src
echo "export const thing = 2;" > commit/worktree/src/thing.ts

# --- runTests/: RUN_TASK_TESTS needs a task branch ahead of main by one commit that adds a passing test ---
rm -rf runTests
mkdir -p runTests/root/.taskTools
git init -q -b main runTests/root
git -C runTests/root config user.name fixture
git -C runTests/root config user.email fixture@example.com
cat > runTests/root/.taskTools/tasks.json <<'JSON'
[
  {
    "taskNumber": 2,
    "title": "fixture task 2",
    "schemaVersion": "1.0.1",
    "hasTests": true,
    "files": ["tests/sentinel.test.ts"],
    "run": {
      "active": true,
      "worktree": "runTests/worktree",
      "leaseRunId": "run-1",
      "history": [
        {
          "runId": "run-1",
          "startedAt": "2026-01-01T00:00:00+00:00",
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
echo fixture > runTests/root/.fixture-marker
echo '{"name":"fixture","scripts":{"test":"node --test \"tests/**/*.test.ts\""}}' > runTests/root/package.json
git -C runTests/root add -A
git -C runTests/root commit -q -m root
git -C runTests/root branch staging
git -C runTests/root worktree add -q -b task-2 ../worktree main
mkdir -p runTests/worktree/tests
cat > runTests/worktree/tests/sentinel.test.ts <<'TS'
import { test } from "node:test";
import assert from "node:assert/strict";

test("sentinel always passes", () => {
    assert.equal(1, 1);
});
TS
git -C runTests/worktree add tests/sentinel.test.ts
git -C runTests/worktree commit -q -m "add sentinel test"

# --- amend/: AMEND_ENTRY_WITH_FAILING_TESTS needs a task with a recorded RED task-test run. No git; tasks.json only. ---
rm -rf amend
mkdir -p amend/root/.taskTools
cat > amend/root/.taskTools/tasks.json <<'JSON'
[
  {
    "taskNumber": 3,
    "title": "fixture task 3",
    "schemaVersion": "1.0.1",
    "hasTests": true,
    "files": ["src/thing.ts"],
    "codexReviewNotes": "",
    "run": {
      "active": true,
      "worktree": "amend/worktree",
      "leaseRunId": "run-1",
      "history": [
        {
          "runId": "run-1",
          "startedAt": "2026-01-01T00:00:00+00:00",
          "endedAt": null,
          "exitType": null,
          "exitNote": null,
          "modifiedFiles": [],
          "commits": [],
          "implementationNotesFile": null,
          "taskTests": {
            "stepId": "RUN_TASK_TESTS",
            "testFiles": [],
            "createdTestFiles": [],
            "deletedTestFiles": [],
            "missingTests": false,
            "passed": false,
            "output": "SENTINEL_FAILING_TESTS",
            "checkedAt": "2026-01-01T00:00:00+00:00"
          },
          "fullSuite": null
        }
      ]
    }
  }
]
JSON
mkdir -p amend/worktree/plans
cat > amend/worktree/plans/checkpoint.json <<'JSON'
{
  "taskNumber": 3, "passId": "fixture-pass", "runId": "run-1", "projectRoot": "amend/root",
  "block": "pipeline-commitImplementationIfNeeded.mmd::AMEND_ENTRY_WITH_FAILING_TESTS", "input": "",
  "state": "running", "sourceLockHeld": false, "exitType": "", "exitNote": "", "resumedFrom": null
}
JSON

# --- static/: read-only fixtures for ARE_TASK_TESTS_SKIPPED_Q, DO_TASK_TESTS_PASS_Q, ARE_2_TEST_FIXES_DONE_Q. No git; tasks.json only. ---
rm -rf static
mkdir -p static/plain/.taskTools static/withRun/.taskTools
cat > static/plain/.taskTools/tasks.json <<'JSON'
[
  { "taskNumber": 4, "title": "fixture task 4", "schemaVersion": "1.0.1", "hasTests": true, "files": ["src/thing.ts"] }
]
JSON
cat > static/withRun/.taskTools/tasks.json <<'JSON'
[
  {
    "taskNumber": 5,
    "title": "fixture task 5",
    "schemaVersion": "1.0.1",
    "hasTests": true,
    "files": ["src/thing.ts"],
    "run": {
      "active": true,
      "worktree": "static/withRun/worktree",
      "leaseRunId": "run-1",
      "history": [
        {
          "runId": "run-1",
          "startedAt": "2026-01-01T00:00:00+00:00",
          "endedAt": null,
          "exitType": null,
          "exitNote": null,
          "modifiedFiles": [],
          "commits": [],
          "implementationNotesFile": null,
          "taskTests": {
            "stepId": "RUN_TASK_TESTS",
            "testFiles": [],
            "createdTestFiles": [],
            "deletedTestFiles": [],
            "missingTests": false,
            "passed": true,
            "output": "",
            "checkedAt": "2026-01-01T00:00:00+00:00"
          },
          "fullSuite": null
        }
      ]
    }
  }
]
JSON
