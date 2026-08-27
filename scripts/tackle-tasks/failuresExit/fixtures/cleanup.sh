#!/bin/bash
# Undoes setup.sh's git init; a .git here hides this whole folder from git.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .git worktree/.git
