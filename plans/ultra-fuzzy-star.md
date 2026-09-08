# Retry `agent()` on API disconnect in the tackle-tasks workflows

## Context

When the API connection drops mid-run, the Workflow harness returns `null` from
`agent()`. Every workflow script treats `null` as permanent — the task is marked
blocked / needs-clarification / rejected and the run moves on. A transient blip
costs a whole task. Two of three planner agents died this way today.

Telling the subagent "retry your connection" in its brief cannot work: when the
connection drops the subagent is already dead, so nobody is left to read it. The
retry has to happen in the script, by spawning a fresh agent.

## The change

1. Add a small `retryAgent()` helper to each self-contained workflow file.
2. Wrap the intended `agent()` calls.
3. Retry only `null`/`undefined`, up to three attempts.
4. Keep the existing fallback after all attempts fail.
5. Add focused tests for "succeeds on retry" and "stops after three failures".

Nothing else. No recovery notes, no recording of starting commit hashes, no changes to
`scripts/`, no test-file splits.

## Constraint

`skills/tackle-tasks/*.workflow.js` cannot import anything — static and dynamic
`import` both fail in the workflow sandbox (commit `d33b9c8` broke tackle-tasks
by trying). The helper is duplicated verbatim in each of the five files. That is
deliberate, not an oversight.

## The helper

Place directly above the first `agent()` call in each of the five files:

```js
// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}
```

Confirmed by running it: returns the first non-null result and stops spawning;
calls spawn exactly three times when every attempt fails; treats `undefined` as
failure; and preserves a falsy-but-valid `0`. Keep the explicit null/undefined
test — a plain `if (result)` would retry a valid `0`.

No backoff between attempts.

### What `null` actually tells us

`null` is the only signal the workflow code receives, and it does not identify a
dropped connection. Measured across recorded workflow runs, both a transient API
529 overload **and** a non-transient safety-classifier block produced a null
result. Killed, errored, and safety-blocked agents are indistinguishable at this
boundary, so all of them consume all three attempts. That is accepted: the retry
means "the harness returned nothing, try again", not "the API dropped".

## Call sites

Six sites across the five files. Each becomes `retryAgent(() => agent(…))` with
the existing arguments untouched.

| File | Line | Call |
|---|---|---|
| `plan.workflow.js` | 62 | `return agent(plannerBrief(t), options)` inside `runPlanner` |
| `verify.workflow.js` | 89 | the `agent(verifierBrief(…), {…})` inside `parallel(PLANNED.map(…))` |
| `implement.workflow.js` | 95 | `return agent(workerBrief(…), options)` inside `runWorker` |
| `test.workflow.js` | 123 | `const result = await agent(testerBrief(group, tasks), {…})` — tester |
| `test.workflow.js` | 139 | `agent(fixerBrief(…), {…})` inside `parallel(fixable.map(…))` — fixer |
| `merge.workflow.js` | 85 | `const diagnosis = await agent(diagnoseBrief, {…})` |

## Existing fallbacks stay

Every call site but one already has a fallback for a null result. None of them
move; they now mean "still nothing after three attempts". Update only the wording
so a real failure is not mistaken for a first-try death:

- `plan.workflow.js:70` — `'planner returned no result'` → `'planner returned no result after 3 attempts'`
- `verify.workflow.js:99` — same edit to the verifier `notes` string
- `implement.workflow.js:108` — same edit to the worker `summary` string
- `test.workflow.js:129` — same edit to the `'test agent returned no result'` detail
- `test.workflow.js:138-143` — the fixer has **no** fallback today; its results are
  discarded by `await parallel(...)`. Nothing to reword, just wrap the call.
- `merge.workflow.js:87-94` — the existing null-guard becomes the after-3-attempts
  path. Its current text claims *"nothing was diagnosed and nothing was fixed"*,
  which can be false: an attempt may have resolved and committed a conflict
  before dying. Replace it with text that does not claim that — say no structured
  diagnosis was returned after 3 attempts, and the repository must be inspected
  because an earlier attempt may have changed it.

## Tests

New `tests/tackleTasksRetry.test.ts`. The workflow files cannot be imported, so
read them as text and extract the helper with `new Function`:

- `test_retryAgentSucceedsOnRetry` — spawn returns `null` then `{ok: 1}`; assert
  the result is `{ok: 1}` and spawn was called exactly twice.
- `test_retryAgentStopsAfterThreeFailures` — spawn always returns `null`; assert
  the result is `null` and spawn was called exactly three times.
- `test_everyWorkflowFileDeclaresTheIdenticalRetryHelper` — extract the helper
  block from all five files and assert they are byte-identical, so the copies
  cannot drift.
- `test_everyAgentCallUsesRetryAgent` — the wiring gate. The three tests above
  all pass even if a production call is left unwrapped, because they only
  exercise an extracted helper and check that the helper exists. Assert instead
  that every `agent(` occurrence in each file sits inside a
  `retryAgent(() => agent(...))` form, with per-file expected counts
  `{plan: 1, verify: 1, implement: 1, test: 2, merge: 1}` — the second call in
  `test.workflow.js` is the easy one to miss. Include a negative fixture holding
  one direct `agent(` call and assert the check fails on it.

### Syntax gate

The earlier plan proposed
`for f in …; do bun build "$f" --target=node >/dev/null || echo "FAIL $f"; done`
as a syntax gate. **Measured: it is worthless.** Run against the five files
*unmodified*, it prints `FAIL` for all five and still exits `0`:

```
error: Top-level return cannot be used inside an ECMAScript module
```

These files deliberately use workflow-sandbox top-level `return` and top-level
`await`, which Bun's ESM build rejects outright, and `|| echo` swallows the
nonzero exit. Replace it with a test in the same new file:

- `test_everyWorkflowFileParsesInItsSandboxShape` — for each of the five files,
  strip the leading `export` from `meta`, wrap the source in
  `(async () => { … })()` so top-level `await` and `return` are legal, and assert
  `new Function(...)` does not throw.

Because it is a test, a parse error fails the run nonzero instead of printing
`FAIL` and passing. Confirmed: this wrapper parses all five current workflow
files, and a deliberately broken source throws `SyntaxError`. Keep that broken
source in the test as a negative control so the gate is proven able to fail.

## Verification

1. `bun test tests/tackleTasksRetry.test.ts` — the two retry behaviours, the
   no-drift check, the wiring gate over all six call sites, and the parse gate.
2. `npx tsc --noEmit` — unchanged; no typed surface is touched.

No live `/tackle-tasks` run is used as a gate — it would overwrite a real task's
plan file and stops being repeatable once that task closes.

## Not doing

- No recovery note, no recording of starting commit hashes, no `scripts/prepareTasks.ts` or
  `scripts/runMergePhase.ts` change. **Accepted ceiling:** a fresh attempt gets the
  same brief as the first and cannot see what its predecessor already did, so it
  may repeat side effects. This applies to every call site, not just the worker —
  the worker, the test fixer, and the merge diagnoser all stage and commit
  (`implement.workflow.js:72-75`, `test.workflow.js:103-106`,
  `merge.workflow.js:46-52`); the planner and verifier rewrite their own plan
  files, which is narrower but not nothing. Revisit only if observed in practice.
- No backoff between attempts.
- No split of `tests/mergeTaskWorktrees.test.ts` (653 lines). Pre-existing debt,
  untouched by this change.
