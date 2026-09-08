#!/bin/bash
# Rebuilds the throwaway git repo LOCK_SOURCE_REPO's template test locks against.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf .git
git init -q -b main
git config user.name fixture
git config user.email fixture@example.com
echo "fixture root" > .fixture-marker
git add -f .fixture-marker
git commit -q -m "root"
