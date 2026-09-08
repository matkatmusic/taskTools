# Task 18 plan — sandbox-execute the workflow's four error branches; make the two non-conflict answer consumers act on their meaningful field

Codex-corrected scope (`plans/pipeline-audit-codex-20260905-113523.md`, "High: task 18 confuses shape validation with semantic validation"): the workflow has **four** error returns, not five — `outcome.next === null` (`scripts/generateWorkflow.ts:92-95`, confirmed live) is the normal **success** return, not a fifth failure branch. The claim that a missing `message`/`additionalData` silently reaches a consumer is also false: `runStepHook.ts:302-305` already rejects a start-input contract mismatch before any consumer script runs, and `tests/runStepHook.test.ts` already proves it (see Scope confirmation). The real, unfixed defect is semantic: two consumers receive a meaningful field in `additionalData` and discard it before it can affect anything.

Depends on task 7: no direct code dependency (this plan does not call `readJsonFile` or `writeJsonAtomically`), but land task 7 first per the parent instructions.

Does **not** touch `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts` — task 22 owns that file's consumption of the conflict receipt exclusively. This plan's two consumer fixes are `COMMIT_IMPLEMENTATION_IF_NEEDED.ts` and `COMMIT_SUITE_FIX_IF_NEEDED.ts` only.

## Scope confirmation

- **`scripts/generateWorkflow.ts`**, lines 61–99, today (`buildWorkflowScript`'s returned script body) — confirmed live, four early returns inside the `while (true)` loop:
  - `if (result === null) { return { ok: false, ran, errors: [...agent died or was skipped], ... } }`
  - `if (typeof result === 'string') { return { ok: false, ran, errors: [...agent answered with text..., result], ... } }`
  - `if (result.ok === false) { return { ok: false, ran, errors: result.errors, ..., outcome: result.outcome, report: result.report } }`
  - `if (result.ran.length === 0) { return { ok: false, ran, errors: [...agent answered without a hook output/payload/packet], ... } }`
  - `if (result.outcome.next === null) { return { ok: true, ran, errors: [], ... } }` — the fifth `if` in the file, and the only one that returns `ok: true`. This is the loop's normal exit, not a failure branch; no test in this plan treats it as one.
  - No existing test in the repo actually **executes** this generated script with a mocked `agent()` — `tests/generateWorkflow.test.ts` only regex-matches the source text (confirmed: every `test_buildWorkflowScript_*` test there calls `assert.match`/`assert.doesNotMatch` on the string `buildWorkflowScript()`, never `new Function` or any execution).
  - `tests/tackleTasksRetry.test.ts` (cited by the task's own text as "already sandbox-executes the file via new Function") in fact sandbox-executes a **different, frozen** set of files: `WORKFLOW_NAMES = ["blockers", "tackle-tasks"]` reading from `skills/tackle-tasks-v1_1/${name}.workflow.js` (confirmed live, line 8 and line 16), not `scripts/generateWorkflow.ts`'s live output at `skills/tackle-tasks/tackle-tasks.workflow.js`. Its own comment says why: "The v1.5 rebuild moved tackle-tasks off the blanket retry rule... These gates therefore watch the frozen v1.1 copy." Its `new Function` calls (lines 28 and 98) either compile an extracted `retryAgent` helper or merely parse-check a workflow body — neither actually runs a full pass with a mocked `agent()`, and neither file it reads has this task's four-branch shape at all (the v1.1 files retry every `agent()` call; the live `buildWorkflowScript()` output does not). **This plan does not add anything to `tackleTasksRetry.test.ts`** — the task's own pointer to that file does not hold up against the live code; the four-branch tests belong in `tests/generateWorkflow.test.ts`, beside the other `buildWorkflowScript()` coverage, and actually execute the generated script this time.

- **`scripts/tackle-tasks/commitImplementationIfNeeded/COMMIT_IMPLEMENTATION_IF_NEEDED.ts`**, lines 12–27, today (full body of `main`):
  ```ts
  export function main(input: string): CommitImplementationIfNeededPacket {
      const { message: _message, additionalData: _additionalData, next: _next, ...packet } = JSON.parse(input) as Input;
      ...
      commitTaskWork({...});
      return { ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
  }
  ```
  `additionalData` is destructured to `_additionalData` and never read — confirmed live at line 13. `implemented: false` changes nothing about what runs next.
  - `implemented: false` is not an operational error — `IMPLEMENT_TASK.ts:109,126` states it plainly: "An open question that blocks the plan is a reason to return `implemented: false`, not a reason to guess" and "Returning `implemented: false` is a correct outcome when the plan is impossible as written." A `throw` here becomes a generic `buildFailure` (`runStepHook.ts:333-343`, confirmed live: `if (!stepRun.ok) { ... return buildFailure(...) }`, triggered by this box's spawned process exiting non-zero) — not the pipeline's actual `FAILURES_EXIT` box (`diagrams/tackle-tasks/pipeline-failuresExit.mmd`, confirmed live), which is what durably releases the worktree lease, releases the source repo lock, marks the task inactive, and records the exit type/note in `tasks.json`. A throw skips every one of those, leaving the run's lock and lease held and the task stuck "active" — exactly the stranding behavior this audit exists to close. This box must instead route to `FAILURES_EXIT` through the diagram, the same way `WHAT_IS_REVIEW_VERDICT.ts:65-69` already does on its own `"ERROR"` verdict (`next: "pipeline-failuresExit.mmd::FAILURES_EXIT"`, `exitType`, `exitNote` all set on the returned packet, no throw).
  - `scripts/steps.json`'s `COMMIT_IMPLEMENTATION_IF_NEEDED` entry declares one static `next`: `["ARE_TASK_TESTS_SKIPPED_Q"]` (confirmed live via `jq`). Routing to `FAILURES_EXIT` on `implemented: false` needs a second entry in that array; once an entry has more than one declared `next`, `runStepHook.ts:177-185`'s `onlySuccessor` auto-pick no longer applies (it only fires when `step.next.length === 1`), so **every** return from this box must now explicitly set `next`, not just the failure path.
  - `FAILURES_EXIT.template.json`'s declared `input` (`box, scriptSignal, taskNumber, runId, projectRoot, worktree, branch, exitType, exitNote`, confirmed live) is already a subset of `CommitImplementationIfNeededPacket`'s fields (`_packet.ts`, confirmed: this type already carries `exitType`/`exitNote`) — no packet-shape change is needed, only setting those two fields to real values on the failure path.
  - **This box has two predecessors with two different answer shapes** (found while tracing every caller, not named by the task text): `jq` against `scripts/steps.json` shows both `pipeline-implementTask.mmd::IMPLEMENT_TASK` and `pipeline-fixImplementTaskTests.mmd::FIX_IMPLEMENT_TASK_TESTS` declare `COMMIT_IMPLEMENTATION_IF_NEEDED` as their only `next`. `IMPLEMENT_TASK.ts:128`'s prompt asks for `additionalData: { implemented: <boolean>, notes: "<...>" }`; `FIX_IMPLEMENT_TASK_TESTS.ts:73`'s prompt asks for `additionalData: { fixSummary: "..." }` — no `implemented` key at all. `COMMIT_IMPLEMENTATION_IF_NEEDED.template.json`'s own declared `input.additionalData` is just `{}` (confirmed live), so the generic per-block contract check (`templateShape.ts`) never enforces which of the two shapes actually arrived — a malformed or incomplete answer from either predecessor (neither an `implemented` boolean nor a `fixSummary` string present) would silently fall through unnoticed today. This box therefore checks for `implemented` first, and when it is absent, requires `fixSummary` to be present instead of assuming the test-fix path by default; an answer matching neither shape throws.
  - Existing tests' fixtures (`COMMIT_IMPLEMENTATION_IF_NEEDED.test.ts`, lines 43-53 and 55-63) use `additionalData: { ok: true }` and `additionalData: {}` respectively — **neither matches either real answer shape** and both would now be rejected by the "matches at least one known shape" guard above; Step 2 updates both fixtures to a real `fixSummary`-bearing shape (matching the `FIX_IMPLEMENT_TASK_TESTS` predecessor) rather than leaving them as placeholder data, and both existing tests' assertions gain the new, now-mandatory `next` field.

- **`scripts/tackle-tasks/runFullSuite/COMMIT_SUITE_FIX_IF_NEEDED.ts`**
  - Lines 9–15, today, the `Input` type: `{ taskNumber, runId, projectRoot, worktree, branch }` — no `message` or `additionalData` field declared at all, even though this box's only entry point supplies both.
  - Lines 23–43, today (full body of `main`): `const packet = JSON.parse(input) as Input;` then builds a brand-new return object listing only `box, scriptSignal, taskNumber, runId, projectRoot, worktree, branch` — `message`/`additionalData.fixSummary`, present in the real runtime input, are silently absent from both the typed shape and the returned packet.
  - `jq` against `scripts/steps.json` confirms `COMMIT_SUITE_FIX_IF_NEEDED` has exactly **one** predecessor: `pipeline-fixTheCodebaseForSuite.mmd::FIX_THE_CODEBASE_FOR_SUITE -> ["pipeline-runFullSuite.mmd::COMMIT_SUITE_FIX_IF_NEEDED"]`. `FIX_THE_CODEBASE_FOR_SUITE.ts:82`'s prompt asks for `additionalData: { fixSummary: "..." }` unconditionally — so, unlike the implement box above, `additionalData.fixSummary` is **always** present here; no branching needed.
  - `fixSummary` is free-form prose ("one paragraph naming which failures you fixed... and why"), not a boolean — there is no pass/fail signal to gate on. `jq` also confirms `COMMIT_SUITE_FIX_IF_NEEDED`'s only `next` is `RUN_FULL_SUITE` — the audit's own phrase, "the next full-suite run gives an independent result," is this exact box: whether the fix actually worked is verified for real by `RUN_FULL_SUITE`, not by trusting this box's prose. `RUN_FULL_SUITE.ts`'s own `Input` type does not declare `fixSummary` at all, and its result is persisted durably via `updateCurrentTaskRun(..., { fullSuite: {...} }, ...)` (`scripts/tackle-tasks/shared/runFullSuite.ts:82`, confirmed live) independent of anything this box carries forward — so carrying `fixSummary` onto this box's own output packet has no downstream semantic effect; it is not what makes this box's fix real. The fix this box needs is the validation itself: a malformed or missing `fixSummary` throws instead of silently proceeding, matching task 7's "validated before the next state transition" principle. Carrying the validated string forward onto the output packet costs one line, is harmless, and is visible in this run's own diagnostic packet JSON for a human debugging that run — worth keeping, but it is a minor courtesy, not the fix.
  - Existing tests (`COMMIT_SUITE_FIX_IF_NEEDED.test.ts`, all three) construct their input JSON with **no** `message`/`additionalData` fields at all (confirmed: lines 31, 50, 69 all list only `taskNumber, runId, projectRoot, worktree, branch`) — these three fixtures do not reflect the real runtime input shape (which always includes `message`/`additionalData.fixSummary`, per the single-predecessor check above) and must be updated in Step 3 alongside the production change, or the new required-field check would fail all three.
  - `COMMIT_SUITE_FIX_IF_NEEDED.template.json`'s own `output` section (today: `{box, scriptSignal, taskNumber, runId, projectRoot, worktree, branch}`) does not need to change — `scripts/templateShape.ts`'s `getTemplateShapeMismatches` ignores extra keys on the actual value (confirmed by reading the whole file: "Every key the template lists must arrive with the right kind. Extra keys on actual are ignored"), so adding `fixSummary` to the box's printed output is not a contract-breaking addition.

## Steps

### Step 1 — sandbox-execute the four workflow branches

`test_buildWorkflowScript_reportsAgentDeathWhenAgentReturnsNull` (add to `tests/generateWorkflow.test.ts`, near the other `buildWorkflowScript` tests):
- Step: run the generated script (helper below) with a mocked `agent()` that resolves to `null` on its first call.
- Assert: the script's result deep-equals `{ ok: false, ran: [], errors: ["PREAMBLE_STATUS_CHECK: agent died or was skipped"], prompt: result.prompt, outcome: null }` (assert the four named fields; `prompt` only needs to be a non-empty string, since its exact text is covered by other tests).

`test_buildWorkflowScript_reportsATextAnswerWhenAgentReturnsAString`:
- Step: mocked `agent()` resolves to `"the agent's raw text"` on its first call.
- Assert: `result.ok === false`, `result.errors` deep-equals `["PREAMBLE_STATUS_CHECK: agent answered with text, not the hook output", "the agent's raw text"]`, `result.outcome === null`.

`test_buildWorkflowScript_stopsAndForwardsTheReportWhenTheHookOutputSaysNotOk`:
- Step: mocked `agent()` resolves to `{ ok: false, ran: ["one.mmd::A"], errors: ["boom"], outcome: null, report: "see the run for detail" }` on its first call.
- Assert: `result.ok === false`, `result.ran` deep-equals `["one.mmd::A"]`, `result.errors` deep-equals `["boom"]`, `result.report === "see the run for detail"`.

`test_buildWorkflowScript_reportsEmptyRanWhenTheAgentSkippedTheHook`:
- Step: mocked `agent()` resolves to `{ ok: true, ran: [] }` on its first call.
- Assert: `result.ok === false`, `result.errors` deep-equals `["PREAMBLE_STATUS_CHECK: agent answered without a hook output/payload/packet"]`, `result.outcome === null`.

`test_buildWorkflowScript_stopsSuccessfullyWhenOutcomeNextIsNull` (the fifth, non-failure branch — proves the "four errors, not five" correction directly):
- Step: mocked `agent()` resolves to `{ ok: true, ran: ["one.mmd::A"], outcome: { next: null, payload: "/tmp/p.json" } }` on its first call.
- Assert: `result.ok === true`, `result.errors` deep-equals `[]`, `result.outcome` deep-equals `{ next: null, payload: "/tmp/p.json" }`.

Test helper, added once near the top of `tests/generateWorkflow.test.ts`, below the existing `buildProject` helper:
```ts
// Runs the generated workflow the way the harness would: async body, args/agent/phase as free names.
// Reuses tackleTasksRetry.test.ts's exact "export const meta" -> "const meta" rewrite for the same reason:
// the harness's sandbox never sees a top-level `export`.
function runWorkflowScript(script: string, args: Record<string, unknown>, agentResults: unknown[]): Promise<Record<string, unknown>> {
    let call = 0;
    const agent = () => Promise.resolve(agentResults[call++]);
    const phase = () => {};
    const body = script.replace("export const meta", "const meta");
    return new Function("args", "agent", "phase", `return (async () => {\n${body}\n})()`)(args, agent, phase);
}
```
No production code changes in this step — `buildWorkflowScript()` already produces the four branches; this step only proves them by execution instead of by regex.

### Step 2 — `COMMIT_IMPLEMENTATION_IF_NEEDED.ts` routes `implemented: false` to `FAILURES_EXIT` through the diagram

`scripts/steps.json`, widen this box's declared `next` (JSON has no comment syntax, so this is a plain value replacement, not a comment-out):

Current text, the `COMMIT_IMPLEMENTATION_IF_NEEDED` entry's `next` array:
```json
"next": [
    "ARE_TASK_TESTS_SKIPPED_Q"
]
```
New text:
```json
"next": [
    "ARE_TASK_TESTS_SKIPPED_Q",
    "pipeline-failuresExit.mmd::FAILURES_EXIT"
]
```

`diagrams/tackle-tasks/pipeline-commitImplementationIfNeeded.mmd` — add the new edge (this diagram already declares `FAILURES_EXIT` as a next-diagram node, confirmed live):
```
// add, alongside the existing COMMIT_IMPLEMENTATION_IF_NEEDED --> ARE_TASK_TESTS_SKIPPED_Q line
COMMIT_IMPLEMENTATION_IF_NEEDED -- "NO<br/>implementation incomplete" --> FAILURES_EXIT
```

`test_main_throwsWhenAdditionalDataMatchesNeitherKnownAnswerShape` (add to `COMMIT_IMPLEMENTATION_IF_NEEDED.test.ts`):
- Step: build the existing fixture (`makeFixture`).
- Step: `const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "?", additionalData: { ok: true } };` (today's own fixture value — neither `implemented` nor `fixSummary`).
- Step: call `main(JSON.stringify(input))`.
- Assert: it throws, matching `/neither/` (or equivalent wording naming both `"implemented"` and `"fixSummary"`).

`test_main_routesToFailuresExitWhenImplementedIsFalse`:
- Step: build the existing fixture, no dirty file needed.
- Step: `const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "gave up", additionalData: { implemented: false, notes: "an open question blocks the plan" } };`
- Step: `const output = main(JSON.stringify(input));`
- Assert: `output.next === "pipeline-failuresExit.mmd::FAILURES_EXIT"`, `output.exitType !== ""`, `output.exitNote === "an open question blocks the plan"`.
- Assert: `getCurrentTaskRun(taskNumber, projectRoot)?.commits` is still `[]` — `commitTaskWork` must not run on this path (nothing was verified done, so nothing should be recorded as landed work).

`test_main_doesNotThrowWhenReachedFromTheTestFixPathWithNoImplementedKey` (negative control, proves the fix does not regress the `FIX_IMPLEMENT_TASK_TESTS` path):
- Step: build the existing fixture.
- Step: `const input = { ...corePacket(projectRoot, worktree, taskNumber), message: "fixed the failing test", additionalData: { fixSummary: "renamed the assertion" } };`
- Step: call `main(JSON.stringify(input))`.
- Assert: it does not throw, and `output.next === "ARE_TASK_TESTS_SKIPPED_Q"`.

The two pre-existing tests, `test_main_commitsADirtyWorktreeAndDropsTheAgentAnswer` and `test_main_returnsCleanlyWhenTheWorktreeIsAlreadyClean`, both currently build `additionalData: { ok: true }` and `additionalData: {}` — neither matches a real answer shape and both now throw under the new "matches at least one known shape" guard (`runStepHook.ts:177-185`'s `onlySuccessor` auto-pick also no longer fires once `steps.json` declares two `next` candidates, so both tests' expected output needs the field regardless). Update both in place: change `additionalData` to `{ implemented: true, notes: "" }`, and add `next: "ARE_TASK_TESTS_SKIPPED_Q"` to each test's expected `deepEqual` object (their remaining assertions are unchanged — this is what proves the true-implemented path still commits and still routes onward, so no separate test is needed for that path).

Production code, `scripts/tackle-tasks/commitImplementationIfNeeded/COMMIT_IMPLEMENTATION_IF_NEEDED.ts`:
```ts
// before
export function main(input: string): CommitImplementationIfNeededPacket {
    const { message: _message, additionalData: _additionalData, next: _next, ...packet } = JSON.parse(input) as Input;
    // const rootSourceBranch = ...
    const rootSourceBranch = "staging";
    commitTaskWork({...});
    return { ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}
// after
export function main(input: string): CommitImplementationIfNeededPacket {
    const { message: _message, additionalData, next: _next, ...packet } = JSON.parse(input) as Input;
    if (typeof additionalData.implemented !== "boolean") {
        if (typeof additionalData.fixSummary !== "string") {
            throw new Error(`COMMIT_IMPLEMENTATION_IF_NEEDED: additionalData holds neither a boolean "implemented" nor a string "fixSummary"`);
        }
    }
    if (typeof additionalData.implemented === "boolean") {
        if (!additionalData.implemented) {
            return {
                ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
                exitType: "implementation-incomplete", exitNote: String(additionalData.notes ?? ""),
                next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
            };
        }
    }
    // const rootSourceBranch = ...
    const rootSourceBranch = "staging";
    commitTaskWork({...});
    return { ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "ARE_TASK_TESTS_SKIPPED_Q" };
}
```
(Single condition per `if`, nested rather than combined, per the user's branching guide: "does the shape match a known protocol at all" is one decision, "is `implemented` present" the next, "is it false" the last.)

No template.json change needed: `COMMIT_IMPLEMENTATION_IF_NEEDED.template.json`'s declared `output` does not list `next`, and `templateShape.ts` ignores extra keys on the actual value (confirmed in Scope confirmation above), so the generic `test_stepTemplate_..._producesItsOutputContract` test (which runs this exact script against the template's own `additionalData: {}` fixture input) is unaffected by the new `next` field — that template fixture's `additionalData: {}` matches neither shape, though, so it would now hit the new throw; **update `COMMIT_IMPLEMENTATION_IF_NEEDED.template.json`'s `input.additionalData`** from `{}` to `{ "implemented": true }` so the generic template-driven test still exercises a real answer shape instead of failing on this task's own new validation.

### Step 3 — `COMMIT_SUITE_FIX_IF_NEEDED.ts` validates `fixSummary` before the next transition

`test_main_throwsWhenAdditionalDataHasNoStringFixSummary` (add to `COMMIT_SUITE_FIX_IF_NEEDED.test.ts`):
- Step: `seedActiveTask` and worktree fixture, as the existing tests do.
- Step: `const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: \`task-${taskNumber}\`, message: "", additionalData: {} });`
- Step: call `main(input)`.
- Assert: it throws, matching `/additionalData holds no string "fixSummary"/`.

`test_main_carriesFixSummaryForwardOnTheOutputPacket`:
- Step: same fixture as `test_COMMIT_SUITE_FIX_IF_NEEDED_commitsDirtyWorkAndForwardsTheCorePacket` (dirty `fixed.txt`).
- Step: `const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: \`task-${taskNumber}\`, message: "fixed it", additionalData: { fixSummary: "renamed the failing assertion" } });`
- Step: `const output = main(input);`
- Assert: `output.fixSummary === "renamed the failing assertion"`.

Production code, `scripts/tackle-tasks/runFullSuite/COMMIT_SUITE_FIX_IF_NEEDED.ts`:
```ts
// before
type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};
...
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const attempts = getAttemptCount(packet.taskNumber, "suiteFix", packet.projectRoot);
    commitTaskWork({...});
    return {
        box: "COMMIT_SUITE_FIX_IF_NEEDED",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktree: packet.worktree,
        branch: packet.branch,
    };
}
// after
type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    message: string;
    additionalData: Record<string, unknown>;
};
...
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    if (typeof packet.additionalData.fixSummary !== "string") {
        throw new Error(`COMMIT_SUITE_FIX_IF_NEEDED: additionalData holds no string "fixSummary"`);
    }
    const attempts = getAttemptCount(packet.taskNumber, "suiteFix", packet.projectRoot);
    commitTaskWork({...});
    return {
        box: "COMMIT_SUITE_FIX_IF_NEEDED",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktree: packet.worktree,
        branch: packet.branch,
        fixSummary: packet.additionalData.fixSummary,
    };
}
```

Then update the three existing tests' input JSON so the new required field does not break them — each of the three `JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: \`task-${taskNumber}\` })` calls (lines 31, 50, 69 today) gains `message: "", additionalData: { fixSummary: "fixed it" }`:
```ts
// before (each of the three call sites)
const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}` });
// after
const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}`, message: "", additionalData: { fixSummary: "fixed it" } });
```
No assertion in these three existing tests changes; `getTemplateShapeMismatches(template.output, output)` in `test_COMMIT_SUITE_FIX_IF_NEEDED_commitsDirtyWorkAndForwardsTheCorePacket` still passes because the template does not list `fixSummary` and extra keys are ignored (confirmed in Scope confirmation above).

## Verification

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```

If it does not print `all passing`, run `npm test 2>&1 | tail -50` and fix the codebase (never the tests, unless a test is fraudulent) until it does.
