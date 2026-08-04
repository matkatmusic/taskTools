# Task 27 Plan: Read-only startup discovery + test-hook confirmation gate

Source: plans/brief-27.md (Phase 4 of the recursive repository-discovery redesign)

## Goal

Add `scripts/runStartup.ts` as the single entry point for startup command
interpolation. Its read-only discovery path (task + blocker discovery) must
be fully separated from any mutating preparation step (worktree creation,
branch creation, commit, push, merge, base update, task archival). Before
any mutating step runs, startup must confirm the copied taskTools test hook
(scripts/relatedTests.ts) is enabled, and that hook's entry point must be
registered in `hooks/hooks.json`.

## Non-goals / hard constraints

- No semantic commit, remote push, integration merge, base update, or task
  archival may occur anywhere in `runStartup.ts`, under any branch of logic.
  These remain the responsibility of later phases/other scripts, not startup.
- No worktree or branch is created during the read-only discovery path.

## Design

`runStartup.ts` is structured as two clearly separated phases:

1. **Discovery phase (read-only)**
   - Runs task discovery and blocker discovery (read tasks.json /
     completedTasks.json state, compute what's open/blocked).
   - Performs no filesystem writes, no git mutations, no worktree/branch
     creation.
   - Returns a discovery result object consumed by phase 2.

2. **Gate + mutating-preparation phase**
   - Before invoking any mutating preparation step, calls a
     `confirmTestHookEnabled()` guard that checks whether the copied hook
     entry point (`scripts/relatedTests.ts`, registered under
     `hooks/hooks.json`) is present and enabled.
   - If the hook is disabled/missing, startup stops immediately — no
     worktree, no branch, nothing further executes.
   - If enabled, mutating preparation steps (worktree/branch creation etc.)
     may proceed. The gate call must precede *every* such step, not just the
     first one, so a code path that skips the initial check can't slip a
     mutating step through.

This keeps the read-only/mutating boundary enforced by structure: discovery
never calls the gate or any mutating helper, and every mutating helper is
only reachable through a call site that runs the gate first.

## hooks/hooks.json change

Register the relatedTests hook's entry point alongside the existing
UserPromptSubmit hook, following the existing `hooks/hooks.json` shape shown
in the brief (command-type entries, `${CLAUDE_PLUGIN_ROOT}` path). Add an
entry invoking `scripts/relatedTests.ts` (the copied taskTools test hook) so
`confirmTestHookEnabled()` has a real registration to check against — the
brief is explicit that taskTools hooks live in `hooks/hooks.json`, never in
any `settings.json`.

## Files to touch

- `scripts/runStartup.ts` (new) — discovery phase, gate, mutating-prep
  phase, per the design above.
- `hooks/hooks.json` (edit) — register the relatedTests.ts hook entry point.
- `tests/runStartup.test.ts` (new) — tests below.

## Tests (tests/runStartup.test.ts)

1. **Hook disabled stops before worktree/branch creation** — with the test
   hook marked disabled, run startup and assert no worktree-creation or
   branch-creation helper was invoked, and startup returns/throws a
   stop-reason indicating the disabled hook.
2. **Gate precedes every mutating step** — assert `confirmTestHookEnabled()`
   (or equivalent) is called and resolved truthy before each mutating
   preparation step individually (not just before the first), e.g. by
   spying on the gate and each mutating helper and asserting call order.
3. **Read-only discovery performs no writes** — run just the discovery
   phase and assert no fs write calls, no git mutation commands (commit,
   push, merge, branch create, worktree add), no calls into task-archival
   logic occur.
4. **hooks/hooks.json registers the copied entry point** — load
   `hooks/hooks.json`, assert an entry references `scripts/relatedTests.ts`
   (mirroring the existing UserPromptSubmit/PostToolUse entry shape), so the
   registration is real and loadable.
5. **No forbidden mutation anywhere in runStartup** — a static/behavioral
   check (e.g. spy-based) asserting no code path in `runStartup.ts` calls a
   semantic-commit, remote-push, integration-merge, base-update, or
   task-archival helper.

## Notes

This plan was written from `plans/brief-27.md` only, per instruction; it
does not inspect current implementations of `scripts/relatedTests.ts`, task
discovery, or other prior-phase scripts. Before implementing, the
implementer should read those files to reuse existing discovery/branch/
worktree helpers rather than reintroducing them, and confirm the exact
shape `confirmTestHookEnabled()` should check hook state in (e.g. an
`enabled` flag read from `hooks/hooks.json` or a sibling config).
