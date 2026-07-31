## 2026-07-31:00:00:00 — Rebuild tackle-tasks as an executable pipeline
Chat title: pipeline-rebuild worktree implementation
Path to JSONL log: /Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools/bf123ec9-1e47-4a01-9658-26970d3fa6d8.jsonl

### References
Plan file: /Users/matkatmusicllc/.claude/plans/encapsulated-enchanting-pillow.md
Worktree: /Users/matkatmusicllc/Programming/taskTools-worktrees/pipeline-rebuild (branch pipeline-rebuild)

### Design decisions
- Step 0 throwaway extractor written to scratchpad only (never in scripts/), imports
  `leadingTaskNumbers` from the real `scripts/taskFiles.ts` to parse `<command-args>` text
  (handles both `[268,270]` and bare-space-separated historical formats) instead of
  reimplementing number parsing.
- `endTimestamp`/boundary handling: some JSONL records at session/run boundaries (types like
  `file-history-snapshot`, `queue-operation`) carry no `timestamp` field. Added a
  nearest-previous-timestamped-record fallback so every run gets a real `endTimestamp`.
- Test runner note: bare `node --test tests/` errors in this environment's Node v26.5.0
  (`Cannot find module 'tests'` — it treats the path as a module id, not a search root).
  `node --test tests/*.test.ts` (shell-glob expanded) and bare `node --test` (auto-discovery)
  both work and were used for every green-check in this implementation.

### Deviations
- **Step 0 numbers don't match the plan's "confirmed by inspection" figures.** The plan states
  "189 session files, 331 tackle-tasks invocations across 102 sessions, 22 close-tasks
  invocations" for the main RevEng directory. Direct inspection with the plan's own exact
  marker (`<command-name>/(taskTools:)?tackle-tasks</command-name>`, top-level `*.jsonl` only,
  no recursion into `<sessionId>/` or `memory/`) finds only ~114 invocations across 102
  sessions and 7 close-tasks invocations in that directory. Across all six directories the
  extractor produced 116 runs total, 106 distinct sessions, 6 reached close-tasks. I did not
  alter the detection rule to chase the stated 331/22 — the plan's own detection spec (exact
  marker, no recursion) is unambiguous and I followed it literally. The 331/22 figures were
  likely produced by a looser or recursive count during the plan's own drafting. Proceeding
  with the literally-specified rule; `plans/tackle-baseline.jsonl` (116 lines) reflects it.

### Tradeoffs
- Chose nearest-backward-timestamp fallback over dropping runs with an untimestamped boundary
  record — keeps every run in the baseline for later comparison rather than silently losing
  samples.

### Open questions
- Should someone reconcile the plan's stated 331/22 figures against this run before treating
  `tackle-baseline.jsonl` as the comparison target in Step 9? Flagging, not blocking — proceeding
  with the rest of the plan's steps regardless since Step 0 is explicitly throwaway/no-tests.
