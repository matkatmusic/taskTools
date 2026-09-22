#!/bin/bash
# Rebuilds the static tasks.json read by the IS_TASK_BLOCKED_Q and IS_TASK_ACTIVE_Q templates.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p .taskTools
cat > .taskTools/tasks.json <<'EOF'
[
  {
    "taskNumber": 1,
    "title": "fixture task",
    "modifiableFiles": [],
    "run": {
      "active": false,
      "worktree": null,
      "leaseRunId": null,
      "history": []
    }
  }
]
EOF

# --- create-example, reset-example, resumed-example: real source repos the mutating blocks run against ---
# Each root is cut from staging with an active run-1 on task 1. A worktree cut here would fall under the tmp convention folder, so its tmp folder is cleared first.
WORKTREE_CONVENTION_DIR="$(node -p 'require("node:os").tmpdir()')/taskTools-wt"

write_tasks_json() {
  # $1 = root dir, $2 = worktree path recorded on the run (or empty for none)
  local recorded='null'
  if [ -n "$2" ]; then recorded="\"$2\""; fi
  mkdir -p "$1/.taskTools"
  cat > "$1/.taskTools/tasks.json" <<JSON
[
  {
    "taskNumber": 1,
    "title": "fixture task",
    "modifiableFiles": ["seed.txt"],
    "run": {
      "active": true,
      "worktree": $recorded,
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
}

make_root() {
  rm -rf "$1" "$1-worktree" "$WORKTREE_CONVENTION_DIR/$1-"*
  git init -q -b main "$1"
  git -C "$1" config user.name fixture
  git -C "$1" config user.email fixture@example.com
  echo seed > "$1/seed.txt"
  git -C "$1" add seed.txt
  git -C "$1" commit -q -m seed
  git -C "$1" branch staging
}

make_root create-example
write_tasks_json create-example ""

make_root reset-example
git -C reset-example worktree add -q -b task-1 ../reset-example-worktree staging
write_tasks_json reset-example "$PWD/reset-example-worktree"

make_root resumed-example
git -C resumed-example worktree add -q -b task-1 ../resumed-example-worktree staging
write_tasks_json resumed-example "$PWD/resumed-example-worktree"
