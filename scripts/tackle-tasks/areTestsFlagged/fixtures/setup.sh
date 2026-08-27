#!/bin/bash
# Rebuilds the fixture tasks.json for areTestsFlagged block tests.
set -euo pipefail
cd "$(dirname "$0")"

cat > tasks.json <<'EOF'
[
  { "taskNumber": 42, "files": ["src/thing.ts"], "codexReviewNotes": "" },
  { "taskNumber": 43, "files": ["src/thing.ts"], "codexReviewNotes": "" }
]
EOF
