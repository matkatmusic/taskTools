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
- Step 3 `buildWorkflowArguments(repoRoot, typecheckCommand, groups: TaskGroup[])` only
  receives `TaskGroup[]` (groupId/taskNumbers/filePaths/scope), not full `TaskRecord[]`, so a
  `PreparedTask`'s `files` is set to the whole group's `filePaths` (identical for every task in
  that group) rather than a per-task subset — the type given to the function has no per-task
  file breakdown to draw from. `writeTaskBriefFile` (which does need per-task title/description/
  files) is called separately by the CLI, once per real `TaskRecord`, before `buildWorkflowArguments`
  runs; brief/plan file *paths* inside `buildWorkflowArguments` are pure string templates keyed
  only on task number, so no `TaskRecord` access is needed to assign them.
- Step 4/5 wiring: `tackleMetrics.ts` exports only `computeArgumentsHash`/`appendRunMetricsRecord`
  (no CLI of its own, per the plan). Step 5 says these are "called by the CLI entry point of
  mergeTaskWorktrees.ts, which runs last and knows every outcome" — but merge's own CLI input
  (`WorkflowArguments`) has no done/partial/blocked/needsClarification/requeue counts, since
  those come from the plan/implement pipeline stages that run inside `workflow.js`, not from
  anything `mergeTaskWorktrees.ts` computes itself. Resolved by widening the merge CLI's parsed
  input to `WorkflowArguments & { runId?, doneCount?, partialCount?, blockedCount?,
  needsClarificationCount?, requeueCount? }` — `workflow.js` (Step 7) is expected to pass this
  superset object (not a bare `WorkflowArguments`) as the merge-stage agent's CLI argument;
  unset counts default to 0. `conflictCount` and `taskNumbers`/`groupCount` are always computed
  locally from the actual merge outcome, never trusted from input.

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

- Step 7 `tackle-tasks.workflow.js`: the runtime globals `agent`, `parallel`, `log`, `args` are
  already used unimported by the pre-existing file, confirming workflow scripts execute inside
  a harness-provided async function body, not as a normal ES module (`node --check` on both the
  old and new file reports "Illegal return statement" identically — expected, not a defect;
  verified by wrapping the body in `new AsyncFunction(...)`, which parses cleanly). `pipeline`
  is a new such global named by the plan; I could not find its contract documented anywhere on
  disk, so `planStage`/`implementStage`/`typecheckStage` write their per-task/per-group results
  into module-scope accumulator Maps/arrays as a side effect, and the final return object is
  built from those accumulators rather than from `pipeline`'s own return value — this makes the
  aggregation correct regardless of exactly what `pipeline()` itself resolves to.
- Step 7 merge stage: the plan's spec says the merge-stage agent's "entire instruction" is to
  run `node scripts/mergeTaskWorktrees.ts '<workflow arguments JSON>'`, but that script lives in
  the taskTools *plugin's* scripts/ directory, not the target repo (`ARGS.repo`) the workflow
  operates on — and workflow.js has no access to `${CLAUDE_PLUGIN_ROOT}` template substitution
  (that's a SKILL.md-body-only feature). Used `$CLAUDE_PLUGIN_ROOT` as a literal shell env-var
  reference in the agent's instructions instead, matching how the rest of this codebase already
  relies on `CLAUDE_PLUGIN_ROOT` being a real exported shell variable (e.g. checkBlockers.ts's
  invocation line in tackle-tasks/SKILL.md), not just markdown templating.
- Step 7 merge CLI input: per the Step 5 deviation above, the merge-stage agent is told to pass
  a JSON object that is `WorkflowArguments` (`repo`, `typecheckCommand`, `groups`) plus
  `runId`/`doneCount`/`partialCount`/`blockedCount`/`needsClarificationCount`/`requeueCount`,
  built from the pipeline's own accumulators. `runId` is a plain-JS random string
  (`Date.now().toString(36)` + `Math.random()...`), not `crypto.randomUUID()`, since workflow
  scripts have no Node API access.

### Open questions
- Should someone reconcile the plan's stated 331/22 figures against this run before treating
  `tackle-baseline.jsonl` as the comparison target in Step 9? Flagging, not blocking — proceeding
  with the rest of the plan's steps regardless since Step 0 is explicitly throwaway/no-tests.
