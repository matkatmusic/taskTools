# Task 24: Opaque finalization authorization token

Phase 3 of the recursive repository-discovery redesign.

Create scripts/runAuthorization.ts: an opaque authorization value that the finalization subsystem requires before doing anything mutating. Tests may construct one directly; in production only the Phase 4 approval recorder may issue one, and it must carry the state digest it was issued against so the finalizer can reject a token that no longer matches current state.

The type must make an unauthorized call impossible to express rather than merely discouraged, and the token must not be forgeable from ordinary manifest data.

New module only; no production call sites yet.

Tests: a finalizer entry point cannot be invoked without a token; a token constructed for one digest is rejected when the digest has changed; a test-constructed token is accepted by the finalizer; assert no production module other than the Phase 4 approval recorder imports the constructor.

### scripts/runAuthorization.ts

(missing: file not found on disk)

### tests/runAuthorization.test.ts

(missing: file not found on disk)
