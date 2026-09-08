#!/usr/bin/env bash
# Read-only snapshot of pipeline state. Safe to run while a run is live.
set -u
cd "$(git rev-parse --show-toplevel)"
gitdir="$(git rev-parse --git-common-dir)"
# Lock lives in the common git dir; leases and journals sit beside each task worktree under tmpdir.
wtroot="${TMPDIR:-/tmp}/taskTools-wt/$(basename "$PWD")-"

section() { printf '\n== %s ==\n' "$1"; }

section "branch"
git branch --show-current

section "git worktree list"
git worktree list

section "plans/checkpoint.json"
cat plans/checkpoint.json 2>/dev/null || echo "(missing)"

section "lock / lease / journal files"
found=0
for f in "$gitdir"/taskTools-source.lock* "$wtroot"*/*.lease "$wtroot"*/*.lease.adopt-intent "$wtroot"*/*.create-journal.json; do
    [ -e "$f" ] || continue
    found=1
    echo "--- $f"
    cat "$f"; echo
done
[ "$found" = 1 ] || echo "(none)"

section "last 5 run log entries"
log="$(ls -t .taskTools/runs/*/*run-log.json 2>/dev/null | head -1)"
if [ -n "$log" ]; then
    echo "--- $log"
    jq '.[-5:]' "$log"
else
    echo "(no run log)"
fi

section "disk free"
df -h .
