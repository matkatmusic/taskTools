# Task 21: Canonical ownership keys with occurrence and ancestor-gitlink effect expansion

Phase 3 of the recursive repository-discovery redesign.

Create scripts/ownershipKeys.ts: convert every declared task path into a canonical ownership key of logical repository ID plus path within that repository, then expand its effects to the synchronized occurrence paths and the affected ancestor gitlinks up to the root.

A task naming a file through one occurrence implicitly affects every other occurrence of that logical repository (through synchronization) and every gitlink on each of their parent chains. Those effects are what later grouping and ownership checks operate on, so they must be computed from the occurrence graph and logical-repository map, never from raw path strings.

New module only; no production call sites yet.

Tests: two alias paths naming the same logical file produce the same canonical key; a path inside one tmux_lib occurrence expands to all three occurrence paths; the expansion includes each distinct ancestor gitlink to the root; a path in a unique repository expands to itself plus its ancestor gitlinks; paths in different logical repositories never share a key.

### scripts/ownershipKeys.ts

(missing: file not found on disk)

### tests/ownershipKeys.test.ts

(missing: file not found on disk)
