# Plan: the `/run-step` skill and its hook

> Scope: the skill and the hook, and nothing else. On approval, copy this file to
> `plans/run-step-plan.md` in the repository.

## What this builds

A skill an agent can invoke to run one or more green `[C]` pipeline script boxes:

```
/run-step "169" "run-abc" "/repo/.worktrees/task-169" "master" "/repo" "COMMIT_IF_NEEDED"
/run-step "169" "run-abc" "/repo/.worktrees/task-169" "master" "/repo" "WRITE_EXIT_TYPE_AND_NOTE" "MARK_TASK_INACTIVE_FAILURE"
```

Tokens 0 to 4 are the task run identity, in the same order the four existing skills already
use. Tokens 5 and beyond are box ids, at least one required, run in the order given, stopping
at the first failure.

Each box's output is kept and handed to every box after it in the same call, so a run of boxes
can be chained — `MERGE_WORKTREES` produces the commit hashes `RECORD_MERGE_COMMIT_HASHES`
records. The hook injects `{"ok":true,"receipts":{...}}` or
`{"ok":false,"failedBoxId":"...","receipts":{...}}` into the invoking agent's context.

Four files. No change to `pipelines.ts`, `AgentPromptEmitter.ts`, `greenBoxPolicy.ts`, or the
generated workflow — those come later, and nothing here depends on them.

| File | State |
|---|---|
| `tests/runStepHook.test.ts` | new |
| `scripts/runStepHook.ts` | new |
| `skills/run-step/SKILL.md` | new |
| `.claude/skills/run-step` | new symlink |
| `hooks/hooks.json` | modified — two registrations |

## Facts the implementer must not re-derive

- The four existing hooks (`scripts/runTaskTestsHook.ts`, `runFullSuiteHook.ts`,
  `rebaseWorktreeHook.ts`, `continueRebaseHook.ts`) share a byte-for-byte identical skeleton.
  `scripts/runStepHook.ts` copies it. Only the command name, the argument check, and the
  delegate differ.
- Two events must be registered, because a typed prompt and an agent's `Skill` tool call fire
  different ones: the `UserPromptSubmit` array, and the `PostToolUse` array whose `"matcher"`
  is `"Skill"`.
- The emitted `hookEventName` must echo `payload.hook_event_name` unchanged. A name that
  disagrees with the firing event makes the harness silently drop the injection.
- The token regex `/"[^"]*"|'[^']*'|\S+/g` is load-bearing: it keeps a worktree path with
  spaces whole. Copy it, do not simplify it.
- `plans/diagram/boxesToSourceMap.md` is stale. `readPublicationState.ts` and
  `writeClarifyRequest.ts` both exist with working command lines.
- The box table lives **inside** `scripts/runStepHook.ts`. A separate module would be a second
  file with one consumer.

## The box table's shape

Rows call each script's exported function, not its command line. Those functions are already
imported and tested across `tests/tackle-tasks/`; spawning a child process to re-parse JSON
adds a failure mode and buys nothing.

Three boxes get no row, because they are the workflow's own output rather than work against the
repository: `REPORT_CLOSURE_NOTE`, `REPORT_EXIT_TYPE_AND_NOTE`, `STOP`.

`LOCK_SOURCE_REPO` **does** get a row. `plans/diagram/boxesToSourceMap.md` was stale here too:
`scripts/tackle-tasks/lockSourceRepo.ts` already exists, already wraps the bounded acquire, and
already has a command line. Its function is async, so `runBoxScript` may return a promise and
the runner awaits every row. It has no test file of its own.

Four boxes need a value the identity arguments cannot supply. They declare it. An extra field
must be declared by at least one box named in the call, and a field no named box declares is
refused — the fence that keeps a caller from widening a box's input:

| Box id | Declared extra field names | Script function |
|---|---|---|
| `WRITE_EXIT_TYPE_AND_NOTE` | `exitType`, `exitNote` | `writeTaskExitNotes` |
| `WRITE_PUBLICATION_OUTCOME` | `exitType`, `exitNote` | `writeTaskExitNotes`, with `reopen: true` |
| `UPDATE_TASK_ENTRY` | `planReview` | `recordPlanReview` |
| `AMEND_ENTRY_WITH_CODEX_NOTES` | `testReview` | `amendEntryWithCodexNotes` |
| `WRITE_CLARIFY_REQUEST` | `clarifyRequest` | `writeClarifyRequest` |

Extra fields arrive as one trailing single-quoted token holding JSON, which the parser reads
whenever that token opens with a brace.

**Correction found while implementing:** validating extras per box made a mixed call impossible.
The exit tail runs `WRITE_EXIT_TYPE_AND_NOTE`, which needs extras, beside
`MARK_TASK_INACTIVE_FAILURE`, which declares none, so the second box refused the first box's
fields. Extras are therefore validated against the union of every named box's declared fields.

---

# Phase 1 — the failing tests

Copy the structure of `tests/runTaskTestsHook.test.ts`: spawn the hook with `spawnSync`, feed
one JSON payload on stdin, assert on stdout. Write every test below and watch it fail before
writing any of Phase 2.

### `tests/runStepHook.test.ts`

```ts
test("test_runStepHook_staysSilentForAPromptThatNamesAnotherSkill", () => {
    // Setup: a UserPromptSubmit payload whose prompt invokes /run-task-tests.
    // Test action: run scripts/runStepHook.ts against that payload.
    // Verification: stdout is empty, so the hook never injects into work it does not own.
});

test("test_runStepHook_matchesThePluginNamespacedFormOfTheSkill", () => {
    // Setup: a PostToolUse payload whose tool_input.skill is taskTools:run-step.
    // Test action: run the hook against that payload.
    // Verification: stdout carries an injection, so a plugin-namespaced call is not missed.
});

test("test_runStepHook_echoesTheFiringEventName", () => {
    // Setup: a payload whose hook_event_name is PostToolUse.
    // Test action: run the hook against that payload.
    // Verification: the emitted hookEventName is PostToolUse, because a name that disagrees
    // with the firing event makes the harness drop the injection.
});

test("test_runStepHook_reportsTheShortfallWhenNoBoxIdFollowsTheIdentityArguments", () => {
    // Setup: a prompt holding the five identity arguments and no box id after them.
    // Test action: run the hook against that prompt.
    // Verification: the injected text names the shortfall, so the caller can see what
    // it typed wrong instead of watching the hook do nothing.
});

test("test_runStepHook_keepsAWorktreePathWithSpacesAsOneArgument", () => {
    // Setup: a prompt whose worktree argument is double quoted and contains a space.
    // Test action: run the hook against that prompt.
    // Verification: the box runs against that whole path, proving the quoted-token
    // regex was copied rather than simplified.
});

test("test_runStepHook_reportsOkWhenEveryNamedBoxSucceeds", () => {
    // Setup: a fixture repository with a recorded task run, and two boxes that both succeed.
    // Test action: run the hook against a prompt naming both boxes.
    // Verification: the injected JSON reads ok true and blames no box.
});

test("test_runStepHook_stopsAtTheFirstFailingBoxAndNamesIt", () => {
    // Setup: a fixture repository where the first named box cannot succeed, followed
    // by a second box that would succeed.
    // Test action: run the hook against a prompt naming both boxes in that order.
    // Verification: the injected JSON reads ok false, names the first box, and the
    // second box left no trace, proving the run stopped rather than carried on.
});

test("test_runStepHook_feedsAnEarlierBoxsReceiptToALaterBoxInTheSameCall", () => {
    // Setup: a fixture repository where MERGE_WORKTREES will produce commit hashes, and
    // RECORD_MERGE_COMMIT_HASHES, which can only run if it is handed those hashes.
    // Test action: run the hook against a prompt naming both boxes in that order.
    // Verification: the recorded hashes match the ones the merge produced, proving the
    // first box's output reached the second rather than being discarded.
});

test("test_runStepHook_failsWhenABoxNeedsAReceiptNoEarlierBoxProduced", () => {
    // Setup: a prompt naming RECORD_MERGE_COMMIT_HASHES on its own, with no
    // MERGE_WORKTREES ahead of it to produce the commits it reads.
    // Test action: run the hook against that prompt.
    // Verification: the injected JSON reads ok false and names the missing receipt, so a
    // wiring mistake is reported rather than reaching the script as undefined.
});

test("test_runStepHook_returnsEveryReceiptItCollected", () => {
    // Setup: a prompt naming two boxes that both succeed.
    // Test action: run the hook against that prompt.
    // Verification: the injected JSON carries a receipt for each box, keyed by box id, so a
    // later /run-step call can be given a value this call produced.
});

test("test_runStepHook_reportsAnUnknownBoxId", () => {
    // Setup: a prompt naming a box id no diagram draws.
    // Test action: run the hook against that prompt.
    // Verification: the injected JSON reads ok false and names the unknown box, so a
    // typo is reported rather than silently skipped.
});

test("test_runStepHook_refusesAnExtraFieldTheBoxDoesNotDeclare", () => {
    // Setup: a prompt naming a box that declares no extra fields, with a trailing
    // JSON token supplying one anyway.
    // Test action: run the hook against that prompt.
    // Verification: the injected JSON reads ok false, because a caller must not be
    // able to widen a box's input with fields the table never sanctioned.
});

test("test_runStepHook_passesADeclaredExtraFieldThroughToTheScript", () => {
    // Setup: a prompt naming WRITE_EXIT_TYPE_AND_NOTE with a trailing JSON token
    // supplying exitType and exitNote.
    // Test action: run the hook against that prompt.
    // Verification: the task entry now holds that exit type, proving the extra
    // fields reached the script rather than being dropped.
});
```

---

# Phase 2 — the hook

### `scripts/runStepHook.ts`

Copy `scripts/runTaskTestsHook.ts` whole. Keep the stdin parse, the namespace-stripping
regexes, the quoted-token regex, the zero-token early exit, and the `inject` closure exactly as
they are. Change the command name to `run-step`, then add the three parts below.

**The identity type and the table:**

```ts
// The five arguments every green box receives, and the only inputs a row may derive from.
type TaskRunIdentity = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
};

// A row returns its script's output so a later box in the same call can read it.
// `receipts` holds every earlier box's output in this call, keyed by box id.
type StepTableRow = {
    allowedExtraFieldNames: string[];
    runBoxScript: (
        identity: TaskRunIdentity,
        extraFields: Record<string, unknown>,
        receipts: Record<string, Record<string, unknown>>,
    ) => Record<string, unknown>;
};

const STEP_TABLE: Record<string, StepTableRow> = {
    // Derives everything from identity, and reads no earlier receipt.
    COMMIT_IF_NEEDED: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity) => commitTaskWork({
            projectRoot: identity.projectRoot,
            worktreePath: identity.worktree,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            stepId: "COMMIT_IF_NEEDED",
            rootSourceBranch: identity.sourceBranch,
        }),
    },
    // Takes a value the identity cannot supply, so it declares that value.
    WRITE_EXIT_TYPE_AND_NOTE: {
        allowedExtraFieldNames: ["exitType", "exitNote"],
        runBoxScript: (identity, extraFields) => writeTaskExitNotes({
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            projectRoot: identity.projectRoot,
            exitType: extraFields.exitType as string,
            exitNote: extraFields.exitNote as string,
        }),
    },
    // Reads an earlier box's receipt: mergeTaskWorktree returns the commits this box records.
    RECORD_MERGE_COMMIT_HASHES: {
        allowedExtraFieldNames: [],
        runBoxScript: (identity, extraFields, receipts) => recordMergeCommits({
            projectRoot: identity.projectRoot,
            taskNumber: identity.taskNumber,
            runId: identity.runId,
            commits: readReceipt(receipts, "MERGE_WORKTREES").commits as TaskCommit[],
        }),
    },
    // ...one row per remaining green box
};
```

Populate the remaining rows from `plans/diagram/boxesToSourceMap.md`, checking each script's
exported function signature in `scripts/tackle-tasks/` rather than trusting that document.
`markTaskInactive`, `recordTaskModifiedFiles`, `releaseTaskRunHolds`, `writeTaskExitNotes` and
`readPublicationState` each serve two box ids, so those rows differ only in what they pass.

### The rows that read an earlier box's receipt

These are the reason `runBoxScript` returns a value at all. Each needs a receipt from a box that
is not necessarily the one immediately before it, which is why the runner keeps every receipt in
the call rather than only the last one.

| Box id | Reads | From box |
|---|---|---|
| `RECORD_MERGE_COMMIT_HASHES` | `commits` | `MERGE_WORKTREES` |
| `ARCHIVE_TASK` | `closureNote` | `BUILD_CLOSURE_NOTE`, two boxes earlier |
| `WRITE_PUBLICATION_OUTCOME` | `state` | `READ_PUBLICATION_STATE` |

A row that names a receipt its call never produced is a hard failure, not a silent `undefined` —
see `readReceipt` in the runner below.

**The runner:**

```ts
/*
  A receipt a row asks for but no earlier box produced is a wiring mistake, not a missing
  value, so it throws here rather than reaching a script as undefined.
*/
function readReceipt(
    receipts: Record<string, Record<string, unknown>>,
    boxId: string,
): Record<string, unknown> {
    const receipt = receipts[boxId];
    if (!receipt) throw new Error(`run-step: no receipt from ${boxId}; name it earlier in the same call`);
    return receipt;
}

function runStepBoxes(
    identity: TaskRunIdentity,
    boxIds: string[],
    extraFields: Record<string, unknown>,
): Record<string, unknown> {
    // Every box's output, keyed by box id, so a later row can read one that ran earlier.
    const receipts: Record<string, Record<string, unknown>> = {};
    for (const boxId of boxIds) {
        const row = STEP_TABLE[boxId];
        if (!row) return { ok: false, failedBoxId: boxId, note: `unknown box id: ${boxId}`, receipts };
        for (const fieldName of Object.keys(extraFields)) {
            if (row.allowedExtraFieldNames.includes(fieldName)) continue;
            return { ok: false, failedBoxId: boxId, note: `${boxId} does not accept the extra field ${fieldName}`, receipts };
        }
        receipts[boxId] = row.runBoxScript(identity, extraFields, receipts);
    }
    return { ok: true, receipts };
}
```

A script that fails throws, which is this repository's established style. The caller below turns
a throw into a named failure.

`receipts` rides back out in the injected JSON. The invoking agent hands it to the workflow, so
a box in a **later** `/run-step` call can be given a value an earlier call produced — the same
way `exitType` arrives today, as a declared extra field. Within one call the runner threads it
directly; across calls the workflow does.

**The delegate call, replacing the `runTaskTests` call at the bottom:**

```ts
    if (tokens.length < 6) {
        inject(`run-step: expected 5 identity arguments and at least one box id, got ${tokens.length}: ${tokens.join(" ")}`);
        process.exit(0);
    }
    const identity: TaskRunIdentity = {
        taskNumber: Number(tokens[0]),
        runId: String(tokens[1]),
        worktree: String(tokens[2]),
        sourceBranch: String(tokens[3]),
        projectRoot: String(tokens[4]),
    };
    // A trailing token that parses as a JSON object is the extra fields, never a box id.
    const trailing = tokens[tokens.length - 1] as string;
    const extraFields = trailing.startsWith("{") ? JSON.parse(trailing) : {};
    const boxIds = tokens.slice(5, trailing.startsWith("{") ? -1 : undefined) as string[];

    let result: Record<string, unknown>;
    try {
        result = runStepBoxes(identity, boxIds, extraFields);
    } catch (error) {
        result = { ok: false, failedBoxId: boxIds[0], note: String((error as Error)?.message ?? error) };
    }
    inject(JSON.stringify(result));
```

---

# Phase 3 — the skill and its symlink

No test. Neither file carries logic; Phase 1's tests already prove the behaviour.

`skills/run-step/SKILL.md`, copying the shape of `skills/run-task-tests/SKILL.md`:

```markdown
---
name: run-step
description: run one or more green pipeline script boxes and print the result, without spending a Bash tool call. Use when an agent types "/run-step <taskNumber> <runId> <worktree> <sourceBranch> <projectRoot> <boxId...>".
argument-hint: <taskNumber> <runId> <worktree> <sourceBranch> <projectRoot> <boxId...>
---

do nothing. Don't even respond.
```

Then the symlink, matching the five already in `.claude/skills/`:

```bash
ln -s ../../skills/run-step .claude/skills/run-step
```

---

# Phase 4 — register the hook

In `hooks/hooks.json`, add `runStepHook.ts` to **both** arrays, beside `runTaskTestsHook.ts` in
each:

```json
{
  "type": "command",
  "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts\""
}
```

- the `UserPromptSubmit` array — fires when a human or agent types the prompt
- the `PostToolUse` array whose `"matcher"` is `"Skill"` — fires when an agent tool-calls the
  skill

Registering only one leaves the other caller silently unserved.

---

# Phase 5 — verify

Run this skill's own tests only. Do not run the full suite — nothing here touches
`pipelines.ts`, `AgentPromptEmitter.ts`, or the generated workflow, so no other test can be
affected by these files.

```bash
# 1. types clean
npm run typecheck

# 2. this skill's tests, alone
node --test tests/runStepHook.test.ts

# 3. the hook works end to end, outside any workflow
echo '{"hook_event_name":"UserPromptSubmit","prompt":"/run-step \"169\" \"run-abc\" \"/tmp/wt\" \"master\" \"/repo\" \"MARK_TASK_INACTIVE_FAILURE\""}' \
  | node scripts/runStepHook.ts
```

Success criteria, in order:

1. `node --test tests/runStepHook.test.ts` reports zero failures.
2. Step 3 prints a JSON injection rather than nothing.
3. Typing the skill by hand in this repository runs the named box and the repository changes.

`git grep` hygiene tests only see tracked files, so `git add` the new files before calling this
done. That check runs with the full suite, which is somebody else's pass, not this one.

---

## The next plan, after this one: the hook becomes the loop

Not built here. Recorded so this plan's shape is understood as a first step, not the end state.

The hook grows from "run a box, return `{ok}`" into "run a step, decide what runs next, keep
going until an agent is needed". It runs green boxes and evaluates decisions in a loop, and
stops only when the next node is an agent prompt, a closed task, or a failure. The workflow
then becomes one `while` loop that spawns an agent per returned step, and every path decision
moves out of `pipelines.ts` and into the hook.

The next-step table is not written by hand — it is the diagrams. `scripts/mmdGraph.ts` already
parses them into `{nodes, edges, labelled}`, and `MmdEdge` already carries `{from, to, label}`.

Three gaps sit between that and the loop, all small:

1. `parseMmd` throws away node types. Its `SKIP` regex on line 13 drops every `class ... script`
   line, which is exactly what tells the loop whether to run a node now, return its prompt, or
   follow its edges.
2. The 29 decision nodes need evaluators. `ARE_2_TEST_FIXES_DONE` reads a counter that lives in
   run state, not in any diagram. One table of 29 pure functions.
3. Counters must survive between agent invocations, because the hook is a fresh process each
   time. `scripts/tackle-tasks/taskRunState.ts` already stores them.

Cross-diagram jumps come free: the 11 `*_PIPELINE` head nodes map to their file names.

This plan's hook returns `{ok, failedBoxId}` and its command line takes one box list. Both are
rewritten by that next plan. The box table built here survives unchanged.

## Deliberately out of scope

Named here so the next pass has a starting list, and so nothing below is attempted now:

- `scripts/tackle-tasks/pipelines.ts` — the `runStep` helper and the `RUN_STEP_RESULT` schema
  that let the workflow reach this skill.
- `scripts/tackle-tasks/RunStepBodyEmitter.ts` and the `run-step` case in
  `AgentPromptEmitter.ts` — the prompt that tells an agent to invoke the skill.
- `scripts/tackle-tasks/greenBoxPolicy.ts` — five dispatched scripts still sit in
  `NON_DISPATCHED_SCRIPTS`, which matters only once `pipelines.ts` calls them.
- Reconciling a lost mutating result through `scripts/tackle-tasks/reconcileStep.ts`.
