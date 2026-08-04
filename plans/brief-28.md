# Task 28: Recorded per-run hook-disabled override requiring full suites before approval

Phase 4 of the recursive repository-discovery redesign.

Create scripts/hookOverride.ts: allow an explicit per-run override that lets a run proceed with the related-test hook disabled. Record the override in the run manifest, and require the complete suite from scripts/testPolicy.ts to run in every affected repository and every affected parent immediately before approval — not earlier, so the results describe the state being approved.

The override is explicit and recorded; there is no implicit fallback that silently skips tests.

Tests: the override is persisted in the manifest and survives a resume; with the override active, every affected repository and parent suite runs before approval and a failure blocks approval; without the override, a disabled hook still stops startup; suites run immediately before approval rather than at an earlier stage.

### scripts/hookOverride.ts

(missing: file not found on disk)

### tests/hookOverride.test.ts

(missing: file not found on disk)
