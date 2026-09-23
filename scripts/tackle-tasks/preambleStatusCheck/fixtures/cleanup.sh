#!/bin/bash
# Removes every disposable repo and worktree setup.sh built, plus the tmp worktrees the blocks cut from them.
set -euo pipefail
cd "$(dirname "$0")"
WORKTREE_CONVENTION_DIR="$(node -p 'require("node:os").tmpdir()')/taskTools-wt"
rm -rf create-example reset-example reset-example-worktree resumed-example resumed-example-worktree
rm -rf "$WORKTREE_CONVENTION_DIR"/create-example-* "$WORKTREE_CONVENTION_DIR"/reset-example-* "$WORKTREE_CONVENTION_DIR"/resumed-example-*
rm -rf continue-rebase-example continue-rebase-example-worktree "$WORKTREE_CONVENTION_DIR"/continue-rebase-example-*
