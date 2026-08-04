# Task 32: Canonical-only operation branch push with ancestor check and no force

Phase 4 of the recursive repository-discovery redesign.

Create scripts/operationPush.ts: after approval, for each repeated logical repository, push only its canonical run-level operation branch, never with force. If a remote branch tip already exists, require it to be an ancestor of the pushed OID or abort before any base publication. Then fetch the canonical branch into every other occurrence and verify each is already at the same OID and the same tree.

Unique repositories' operation branches are never pushed automatically, and no base branch is ever pushed automatically.

Tests: a unique repository's operation branch is not pushed; a repeated repository pushes only its canonical branch; a non-ancestor remote tip aborts before publication; no push uses force under any path; after push, every other occurrence verifies to the same OID and tree; a push attempted before approval fails.

### scripts/operationPush.ts

(missing: file not found on disk)

### tests/operationPush.test.ts

(missing: file not found on disk)
