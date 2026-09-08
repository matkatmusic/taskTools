#!/bin/bash
# Rebuilds the fixture git repo for pipeline-mergeSucceededExit block tests.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
git commit -q --allow-empty -m "fixture root commit"
git update-ref refs/taskTools/merged-commits/task-42 HEAD
