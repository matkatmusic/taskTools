# Task 12: LogicalRepository records overlaid on the occurrence graph

Phase 2 of the recursive repository-discovery redesign.

Create scripts/logicalRepository.ts: a LogicalRepository record holding the normalized upstream identity from scripts/submoduleUrlIdentity.ts, all occurrence IDs sharing it, the selected base, the canonical occurrence, the last-writer occurrence, the convergence digest, and consolidation state. Persist the equivalence classes in the run manifest.

The occurrence tree stays intact. Logical equivalence must never collapse distinct parent chains: three checkouts of tmux_lib remain three occurrences with three different parents and three different paths, grouped under one logical repository. Support an arbitrary number of occurrences — no code path may assume one or two.

New module only; no production call sites yet.

Tests: a fixture with tmux_lib at tmux_lib, jfred/external/tmux_lib, and jfred/jfredToolsPlugin/external/tmux_lib produces one logical repository with three occurrence IDs; each occurrence keeps its own parent edge and path; two occurrences each of claude_plugin_lib and scenarios form their own classes; a unique repository forms a one-member class; assert no occurrence is dropped, merged, or reparented by the overlay.

### scripts/logicalRepository.ts

(missing: file not found on disk)

### tests/logicalRepository.test.ts

(missing: file not found on disk)
