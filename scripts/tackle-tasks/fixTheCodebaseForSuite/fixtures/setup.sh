#!/bin/bash
# Rebuilds the two fixture git repos for pipeline-suite block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git worktree/.git

git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "fixture root" > .fixture-marker
git add -f .fixture-marker
git commit -q -m "root"
cat > .git/taskTools-source.lock <<'EOF'
{"owner":"run-1:1","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}
EOF

mkdir -p worktree/src worktree/tests
cd worktree
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "export const thing = 1;" > src/thing.ts
cat > tests/thing.test.ts <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";

test("sentinel always passes", () => {
    assert.equal(1, 1);
});
EOF
git add src/thing.ts tests/thing.test.ts
git commit -q -m "base"
git checkout -q -b task-1
echo "export const thing = 2;" > src/thing.ts
git commit -q -am "task edit"
