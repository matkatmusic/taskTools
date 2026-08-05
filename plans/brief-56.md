# Task 56: Produce real TestReceipts and reviewHandoffs from the test phase so the approval gate can ever open

Split out of task 53 on 2026-08-05 after codex rejected its plan twice. Root cause found while investigating: nothing in this repository ever CREATES a TestReceipt. scripts/approvalGate.ts line 16 and scripts/approvalReadiness.ts line 43 consume TestReceipt arrays, and scripts/approvalReadiness.ts line 97 refuses approval when the array is empty or any receipt is red, but the only places a receipt is ever constructed are tests/approvalGate.test.ts, tests/approvalReadiness.test.ts and tests/basePublication.test.ts. Production code has no producer. The same is true of reviewHandoffs (scripts/approvalGate.ts line 17) and occurrenceDigests (line 15). The approval gate therefore cannot open no matter what any caller passes it.

Build the producer. skills/tackle-tasks/test.workflow.js already runs the tests covering each group and returns {tests, allPassed} with a per-group passed flag and failure list; convert that into a real TestReceipt array. Decide and state where reviewHandoffs come from — the verify phase codex verdicts in skills/tackle-tasks/verify.workflow.js are the obvious source — and define a deterministic ordered occurrenceDigests algorithm rather than reusing raw baseOid values, which codex rejected explicitly.

Thread the result through the orchestrator documented in skills/tackle-tasks/SKILL.md so the merge step receives real evidence in its args. Read plans/task-53-plan.md and the task 53 codex rejection notes before starting.

### skills/tackle-tasks/test.workflow.js

```
export const meta = {
  name: 'tackle-tasks-test',
  description: 'Run the tests covering each group and have a worker fix failures until they pass',
  phases: [
    { title: 'Test', detail: 'report-only test run per group, repeated until green' },
    { title: 'Fix', detail: 'one worker per failing task between test rounds' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const DONE = ARGS.done ?? []
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const MAX_ROUNDS = ARGS.maxRounds ?? 3

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'integer' }, detail: { type: 'string' } },
        required: ['task', 'detail'],
      },
    },
  },
  required: ['passed', 'failures'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['task', 'fixed', 'summary'],
}

const testerBrief = (group, tasks) => `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = {
${tasks.map((t) => `    task ${t.number}: ${t.files.join(', ')}`).join('\n')}
}
failures = []

typecheck = run(${TYPECHECK_COMMAND})

if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
// never run the full suite

results = run(tests)

for each task in ownedFiles:
    if typecheck reported an error in that task's files, or any of its tests failed:
        failures += {task: that task number, detail: the failing test names plus a short error summary}

if typecheck is clean and every test in results passed:
    return {passed: true, failures: []}
else:
    return {passed: false, failures: failures}

You are forbidden to edit any file, to run the full suite, or to report passed
true while any test failed or typecheck reported an error.`

const planFileFor = (task) => (ARGS.approved ?? []).find((a) => a.task === task)?.planFile ?? ''

const fixerBrief = (t, group, detail) => `You implemented task #${t.number} and wrote its tests. One of them
is now failing.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = ${t.files.join(', ')}
plan = ${planFileFor(t.number) || '(no plan file recorded)'}
failure = ${detail}

read(plan)   // the fix must match what the task set out to do

if the plan is wrong:
    return {task: ${t.number}, fixed: false, summary: why the plan itself is wrong}
else if the code is wrong:
    fix the code so the test passes as written
else if the test asserts something the plan did not call for:
    correct the test to assert what the plan called for
    note in summary that you changed the test, and why

typecheck = run(${TYPECHECK_COMMAND})
results = run(the tests covering ownedFiles)

if typecheck is clean and every test passed:
    run: git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}
    run: git commit -m "task ${t.number}: fix failing test"
    return {task: ${t.number}, fixed: true, summary: what you changed}
else:
    return {task: ${t.number}, fixed: false, summary: what is still failing}

You are forbidden to touch anything outside ownedFiles; to weaken, skip, or
delete a test to make it pass; to assert the current wrong output as the
expected value; to run \`git add -A\` or \`git add .\`; to commit while anything
fails; or to redecide the plan yourself.`

async function testGroup(group) {
  const tasks = group.tasks.filter((t) => DONE.some((d) => d.task === t.number))
  if (!tasks.length) return { groupId: group.groupId, passed: true, rounds: 0, failures: [], notes: 'no implemented tasks to test' }

  const taskByNumber = new Map(tasks.map((t) => [t.number, t]))
  let outcome = null

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const result = await agent(testerBrief(group, tasks), {
      label: `test:${group.groupId}:r${round}`,
      phase: 'Test',
      effort: 'low',
      schema: TEST_SCHEMA,
    })
    outcome = result ?? { passed: false, failures: tasks.map((t) => ({ task: t.number, detail: 'test agent returned no result' })) }

    if (outcome.passed) return { groupId: group.groupId, passed: true, rounds: round, failures: [], notes: '' }
    if (round === MAX_ROUNDS) break

    const fixable = outcome.failures.filter((f) => taskByNumber.has(f.task))
    if (!fixable.length) break

    log(`group ${group.groupId} round ${round}: fixing ${fixable.length} failing task(s)`)
    await parallel(fixable.map((f) => () =>
      agent(fixerBrief(taskByNumber.get(f.task), group, f.detail), {
        label: `fix:${f.task}:r${round}`,
        phase: 'Fix',
        schema: FIX_SCHEMA,
      })))
  }

  return {
    groupId: group.groupId,
    passed: false,
    rounds: MAX_ROUNDS,
    failures: outcome?.failures ?? [],
    notes: `still failing after ${MAX_ROUNDS} round(s)`,
  }
}

log(`testing ${GROUPS.length} group(s), up to ${MAX_ROUNDS} round(s) each`)
const tests = (await parallel(GROUPS.map((g) => () => testGroup(g)))).filter(Boolean)

return { tests, allPassed: tests.every((t) => t.passed) }

```

### skills/tackle-tasks/verify.workflow.js

```
export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex, apply its suggested fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one codex verifier per planned task, one repair round each' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    revised: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'revised', 'notes'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const verifierBrief = (t, planFile) => {
  const command = `codex exec -s read-only ${JSON.stringify(codexPrompt(t, planFile))}`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

Codex prints its verdict on the first line. The only file you may ever edit
is the plan file ${planFile} — never touch a source file, and never run any
command other than the codex command above.

If the first run prints APPROVED:
  return verdict "approved", revised false, and codex's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what codex asked for — edit only that file. Then run the exact same
  codex command a second time against the now-updated plan.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put codex's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If codex said the plan cannot be fixed within the task's owned files, do not
  invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never run codex more than twice.
Return {task: ${t.number}, verdict, revised, notes}.`
}

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

const results = await parallel(PLANNED.map((p) => () =>
  agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  })))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result (killed, errored, or blocked)',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
}

```

### skills/tackle-tasks/SKILL.md

```
---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *)
---

- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`
- task details (unblocked tasks only): !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS'); [ -n "$u" ] && node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$u" || echo "none of the requested tasks are unblocked"`
- pipeline args: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — followed by `valid` and any free text. The scripts above read the whole argument string and stop at the first token that is not part of the array, so anything after it is ignored by them. Avoid apostrophes and backticks in that trailing text; it reaches the shell inside single quotes.

Do not work on any task reported as BLOCKED in the "blocked status" above — report its open blockers and move on to the next requested task that is unblocked.

Invoke `/ponytail:ponytail ultra`.

When `$ARGUMENTS` contains the word `valid`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.

## Verification

Review the task details above (each object comes from `tasks.json` if the task is open, or `completedTasks.json` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Running the pipeline

Each phase is its own workflow, launched in order. Call Workflow with the
scriptPath and args given below, and wait for each to finish before starting
the next.

The "pipeline args" JSON printed above has these keys: `repo`,
`typecheckCommand`, `groups`, `repositorySources`, `runId`, `startTimestamp`,
`mergeScript`. Every step below passes all seven of those keys through
unchanged, plus the extra keys named in that step.

**Step 1 — plan.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/plan.workflow.js`,
args = the pipeline args JSON exactly as printed, no additions.
Returns `{plans, planned, needsClarification, notRelevant}`.

**Step 2 — verify.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/verify.workflow.js`,
args = the pipeline args JSON plus one added key:
- `planned`: the `planned` array from step 1, verbatim.

Reviews each plan with codex. On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns `{verified, approved, rejected, revisedCount}`. If `approved` is
empty, stop and report — there is nothing to implement. Report `revisedCount`
so the user knows how many plan files codex rewrote.

**Step 3 — implement.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/implement.workflow.js`,
args = the pipeline args JSON plus one added key:
- `approved`: the `approved` array from step 2, verbatim.

Returns `{results, done, partial, blocked, requeueCount}`.

**Step 4 — test.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/test.workflow.js`,
args = the pipeline args JSON plus:
- `done`: the `done` array from step 3, verbatim.
- `approved`: the `approved` array from step 2, so a failing test goes back to
  the implementer with the plan it implemented rather than to a cold agent.
- `maxRounds` (optional): test-then-fix rounds before giving up, default 3.

Returns `{tests, allPassed}`.

**Step 5 — approval.** Present `needsClarification`, `rejected`, `partial`,
`blocked` and `tests` to the user, and ask every needsClarification question
with AskUserQuestion. **Do not launch the merge workflow until the user
approves the work.**

**Step 6 — merge.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/merge.workflow.js`,
args = the pipeline args JSON plus:
- `approvedByUser`: `true` — only after the user approved in step 5. The
  workflow refuses to merge without it.
- `doneCount`: length of `done` from step 3.
- `partialCount`: length of `partial` from step 3.
- `blockedCount`: length of `blocked` from step 3.
- `needsClarificationCount`: length of `needsClarification` from step 1.
- `rejectedCount`: length of `rejected` from step 2.
- `requeueCount`: `requeueCount` from step 3.

The workflow runs `mergeTaskWorktrees.ts` in a subagent. If that fails —
non-zero exit or a non-empty `conflicts` array — a second subagent diagnoses
the cause and fixes what it can, and the merge script then runs again. Do none
of that yourself; it stays in the workflow.

Returns `{merged, conflicts, fixedBlockers, blockers, decisions, summary}`.

- `fixedBlockers` is `null` when the first run was clean, `true` when a
  subagent cleared the blockers and the retry ran, `false` when it could not.
- **`decisions` is the one you must act on.** Each entry is a choice the
  subagent deliberately refused to make for the user — conflicting logic, a
  missing source branch, something destructive. Ask every entry with
  AskUserQuestion, then launch this step again with the user's answers added
  to the args as `decisions`, so the retry has them.
- `blockers` are non-decision failures. Report them; the merge is incomplete.

A merge that returns a non-empty `decisions` or `blockers` did not finish — do
not report it as merged, and do not invoke close-tasks for its tasks.

Present merged and conflicts to the user. ONLY after the user approves, invoke
close-tasks once for all merged tasks.

There is no serial fallback path. One task or ten, the same code path runs.

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its `tasks.json` entry stale, with **one** invocation of the `close-tasks` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — `[268,270,281]` — followed by your reasoning for the `closureNote`s, naming each task (`#268 …, #270 …`) when the reasons differ.

If the user requests adding tasks, invoke the `create-task` skill once per task — never edit `tasks.json` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside `close-tasks`, after the user approves closing.

## Commit message

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`

```

### scripts/approvalReadiness.ts

```
// approvalReadiness.ts: gates readyForApproval on task/ownership/typecheck/sync checks, green test receipts, and per-group reviewer exercise methods.

export type TaskCompletionState = "done" | "partial" | "blocked" | "needs-clarification";

export interface SelectedTaskStatus {
    taskId: string | number;
    state: TaskCompletionState;
}

export interface OwnershipCheckOutcome {
    passed: boolean;
}

export interface TypecheckOutcome {
    passed: boolean;
}

export interface OccurrenceConvergenceOutcome {
    converged: boolean;
}

export interface TestReceipt {
    groupId: string;
    status: "green" | "red";
}

export type ExerciseMethod =
    | { kind: "url"; url: string }
    | { kind: "command"; command: string; workingDirectory: string }
    | { kind: "note"; text: string };

export interface GroupReviewResult {
    groupId: string;
    methods: ExerciseMethod[];
}

export interface ApprovalReadinessInput {
    groupIds: string[];
    selectedTasks: SelectedTaskStatus[];
    ownership: OwnershipCheckOutcome;
    typecheck: TypecheckOutcome;
    occurrenceConvergence: OccurrenceConvergenceOutcome;
    testReceipts: TestReceipt[];
    groupReviews: GroupReviewResult[];
}

export type ApprovalBlockReason =
    | "partial"
    | "blocked"
    | "clarification"
    | "ownership"
    | "typecheck"
    | "sync"
    | "test"
    | "missing-review"
    | "non-actionable-review";

export interface ApprovalReadinessResult {
    readyForApproval: boolean;
    blockedBy: ApprovalBlockReason[];
}

export interface GroupExerciseFacts {
    groupId: string;
    workingDirectory: string;
    liveServerUrl?: string;
    verificationCommand?: string;
}

export function isActionableExerciseMethod(method: ExerciseMethod): boolean {
    if (method.kind === "url") return method.url !== "";
    if (method.kind === "command") return method.command !== "" && method.workingDirectory !== "";
    return false;
}

export function reviewGroupExerciseMethod(facts: GroupExerciseFacts): GroupReviewResult {
    const methods: ExerciseMethod[] = [];
    if (facts.liveServerUrl) methods.push({ kind: "url", url: facts.liveServerUrl });
    if (facts.verificationCommand) {
        methods.push({ kind: "command", command: facts.verificationCommand, workingDirectory: facts.workingDirectory });
    }
    if (methods.length === 0) {
        methods.push({ kind: "note", text: "no actionable exercise method available" });
    }
    return { groupId: facts.groupId, methods };
}

export function assessApprovalReadiness(input: ApprovalReadinessInput): ApprovalReadinessResult {
    const blockedBy: ApprovalBlockReason[] = [];

    if (input.selectedTasks.some((task) => task.state === "partial")) blockedBy.push("partial");
    if (input.selectedTasks.some((task) => task.state === "blocked")) blockedBy.push("blocked");
    if (input.selectedTasks.some((task) => task.state === "needs-clarification")) blockedBy.push("clarification");
    if (!input.ownership.passed) blockedBy.push("ownership");
    if (!input.typecheck.passed) blockedBy.push("typecheck");
    if (!input.occurrenceConvergence.converged) blockedBy.push("sync");
    if (input.testReceipts.length === 0 || input.testReceipts.some((receipt) => receipt.status === "red")) {
        blockedBy.push("test");
    }

    let missingReview = false;
    let nonActionableReview = false;
    for (const groupId of input.groupIds) {
        const review = input.groupReviews.find((candidate) => candidate.groupId === groupId);
        if (!review) {
            missingReview = true;
            continue;
        }
        if (!review.methods.some(isActionableExerciseMethod)) nonActionableReview = true;
    }
    if (missingReview) blockedBy.push("missing-review");
    if (nonActionableReview) blockedBy.push("non-actionable-review");

    return { readyForApproval: blockedBy.length === 0, blockedBy };
}

```

### tests/approvalReadiness.test.ts

```
// Behavioral checks for approvalReadiness.ts: readiness gating and reviewer exercise-method handoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assessApprovalReadiness,
    isActionableExerciseMethod,
    reviewGroupExerciseMethod,
} from "../scripts/approvalReadiness.ts";
import type { ApprovalReadinessInput } from "../scripts/approvalReadiness.ts";

function baseGreenInput(): ApprovalReadinessInput {
    return {
        groupIds: ["group-1"],
        selectedTasks: [{ taskId: 1, state: "done" }],
        ownership: { passed: true },
        typecheck: { passed: true },
        occurrenceConvergence: { converged: true },
        testReceipts: [{ groupId: "group-1", status: "green" }],
        groupReviews: [
            {
                groupId: "group-1",
                methods: [{ kind: "command", command: "npx tsc --noEmit", workingDirectory: "/repo" }],
            },
        ],
    };
}

test("test_partialTaskPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.selectedTasks = [{ taskId: 1, state: "partial" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("partial"));
});

test("test_blockedTaskPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.selectedTasks = [{ taskId: 1, state: "blocked" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("blocked"));
});

test("test_clarificationNeededTaskPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.selectedTasks = [{ taskId: 1, state: "needs-clarification" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("clarification"));
});

test("test_ownershipViolationPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.ownership = { passed: false };
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("ownership"));
});

test("test_typecheckFailurePreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.typecheck = { passed: false };
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("typecheck"));
});

test("test_unconvergedOccurrencePreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.occurrenceConvergence = { converged: false };
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("sync"));
});

test("test_redTestReceiptPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.testReceipts = [{ groupId: "group-1", status: "red" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("test"));
});

test("test_missingTestReceiptPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.testReceipts = [];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("test"));
});

test("test_missingGroupReviewPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.groupReviews = [];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("missing-review"));
});

test("test_nonActionableGroupReviewPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.groupReviews = [{ groupId: "group-1", methods: [{ kind: "note", text: "looks good" }] }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("non-actionable-review"));
});

test("test_fullyGreenRunWithActionableMethodPerGroupIsReadyForApproval", () => {
    const result = assessApprovalReadiness(baseGreenInput());
    assert.equal(result.readyForApproval, true);
    assert.deepEqual(result.blockedBy, []);
});

test("test_liveServerUrlMethodIsActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "url", url: "http://localhost:3000" }), true);
});

test("test_commandWithWorkingDirectoryIsActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "command", command: "bun test", workingDirectory: "/repo" }), true);
});

test("test_commandWithoutWorkingDirectoryIsNotActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "command", command: "bun test", workingDirectory: "" }), false);
});

test("test_proseOnlyNoteIsNotActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "note", text: "looks fine" }), false);
});

test("test_reviewerReturnsUrlWhenLiveServerUrlFactProvided", () => {
    const result = reviewGroupExerciseMethod({
        groupId: "group-1",
        workingDirectory: "/repo",
        liveServerUrl: "http://localhost:4000",
    });
    assert.ok(result.methods.some((method) => method.kind === "url" && isActionableExerciseMethod(method)));
});

test("test_reviewerReturnsCommandWhenVerificationCommandFactProvided", () => {
    const result = reviewGroupExerciseMethod({
        groupId: "group-1",
        workingDirectory: "/repo",
        verificationCommand: "npx tsc --noEmit",
    });
    const method = result.methods.find((candidate) => candidate.kind === "command");
    assert.ok(method && isActionableExerciseMethod(method));
    assert.equal(method?.kind === "command" ? method.workingDirectory : undefined, "/repo");
});

test("test_reviewerReturnsNonActionableNoteWhenNoFactsProvided", () => {
    const result = reviewGroupExerciseMethod({ groupId: "group-1", workingDirectory: "/repo" });
    assert.equal(result.methods.length, 1);
    assert.equal(result.methods[0].kind, "note");
    assert.equal(isActionableExerciseMethod(result.methods[0]), false);
});

test("test_reviewerPerformsNoWrites", async () => {
    const { default: fs } = await import("node:fs");
    const writeShapedMethods = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "rm", "rmSync"] as const;
    const originals = writeShapedMethods.map((name) => [name, (fs as Record<string, unknown>)[name]] as const);
    for (const name of writeShapedMethods) {
        (fs as Record<string, unknown>)[name] = () => {
            throw new Error(`unexpected write-shaped fs call: ${name}`);
        };
    }
    try {
        const result = reviewGroupExerciseMethod({
            groupId: "group-1",
            workingDirectory: "/repo",
            liveServerUrl: "http://localhost:4000",
        });
        assert.equal(result.groupId, "group-1");
    } finally {
        for (const [name, original] of originals) (fs as Record<string, unknown>)[name] = original;
    }
});

```

### scripts/approvalGate.ts

```
// approvalGate.ts: the single whole-run approval gate -- records approval, issues authorization, invalidates it on drift.
import { createHash } from "node:crypto";
import type { RepositoryManifest } from "./repositoryManifest.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { issueRunAuthorization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";
import { runFinalizer } from "./runFinalizer.ts";
import type { FinalizationRunInput, FinalizationRunResult } from "./runFinalizer.ts";

export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
    baseRef: string;
    occurrenceDigests: string[];
    testReceipts: TestReceipt[];
    reviewHandoffs: string[];
};

export type Approval = {
    digest: string;
    recordedAt: string;
};

export type RunState = {
    readyForApproval: boolean;
    status: string;
    digestInput: ApprovalDigestInput;
    approval?: Approval;
    authorization?: RunAuthorizationToken;
};

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const entries = keys.map(
            (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
        );
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}

export function computeApprovalDigest(input: ApprovalDigestInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function recordApproval(runState: RunState): Approval {
    if (!runState.readyForApproval) {
        throw new Error("cannot record approval: run is not readyForApproval");
    }
    if (runState.approval !== undefined) {
        throw new Error("cannot record approval: this run already has an approval recorded");
    }
    const approval: Approval = {
        digest: computeApprovalDigest(runState.digestInput),
        recordedAt: new Date().toISOString(),
    };
    runState.approval = approval;
    return approval;
}

export function issueApprovalAuthorization(runState: RunState): RunAuthorizationToken {
    if (runState.approval === undefined) {
        throw new Error("cannot issue authorization before an approval is recorded");
    }
    const authorization = issueRunAuthorization(runState.approval.digest);
    runState.authorization = authorization;
    return authorization;
}

// Recomputes the digest; a mismatch invalidates approval/authorization and returns the run to review.
export function checkAuthorizationDrift(runState: RunState): boolean {
    if (runState.authorization === undefined) return true;
    const currentDigest = computeApprovalDigest(runState.digestInput);
    if (currentDigest === runState.authorization.stateDigest) return true;
    runState.authorization = undefined;
    runState.approval = undefined;
    runState.status = "review";
    return false;
}

export function finalizeApprovedRun(
    runState: RunState,
    finalizationInput: FinalizationRunInput,
): FinalizationRunResult {
    if (runState.authorization === undefined) {
        throw new Error("cannot finalize: run has no issued authorization");
    }
    return runFinalizer(finalizationInput, runState.authorization, computeApprovalDigest(runState.digestInput));
}

```

### skills/tackle-tasks/merge.workflow.js

```
export const meta = {
  name: 'tackle-tasks-merge',
  description: 'Run the merge script, and on failure have a subagent diagnose and fix the blockers before running it again',
  phases: [
    { title: 'Merge', detail: 'run mergeTaskWorktrees.ts' },
    { title: 'Unblock', detail: 'diagnose and fix merge blockers, then merge again' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    merged: { type: 'array' },
    conflicts: { type: 'array' },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'error'],
}

const DIAGNOSE_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'summary', 'blockers', 'decisions'],
}

// The orchestrator gets the user's approval before this workflow is ever launched.
if (!ARGS.approvedByUser) {
  return { merged: [], conflicts: [], refused: 'merge workflow launched without approvedByUser' }
}

const mergeCliInput = {
  repo: ARGS.repo,
  typecheckCommand: ARGS.typecheckCommand ?? 'npx tsc --noEmit',
  groups: ARGS.groups ?? [],
  repositorySources: ARGS.repositorySources,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
}

const command = `node "${ARGS.mergeScript}" '${JSON.stringify(mergeCliInput)}'`

const runBrief = `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

result = run(${command})

if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged or conflicts values on the success branch.`

const diagnoseBrief = (run) => `The merge failed.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

repo = ${ARGS.repo}
failedCommand = ${command}
report = ${JSON.stringify({ ok: run.ok, conflicts: run.conflicts ?? [], error: run.error ?? '' })}

decisions = []
blockers = []

for each conflict in report.conflicts:
    if conflict.submoduleConflicts is not empty:
        run scripts/resolveGitlinkConflicts against conflict.worktree
    else if conflict.conflictedFilePaths is not empty:
        for each path in conflict.conflictedFilePaths:
            resolve path in conflict.worktree, keeping BOTH sides' intent
        stage only those paths, then commit

if report.error names a gitlink or submodule path:
    run scripts/resolveGitlinkConflicts against the named worktree
else if report.error names unmerged paths, an unfinished merge, or an unclean tree:
    complete the in-progress merge, or abort it, so the tree is clean
else if report.error is unrecognized:
    identify the real cause
    fix it only if the fix is as concrete and reversible as the branches above

if a blocker needs a user decision (both sides changed the same logic, a
recorded source branch is missing, or the only way forward destroys work):
    leave the repo exactly as you found it
    decisions += the choice itself, with the options you saw
    // example: "group-1 rewrote validateInput() while main deleted it:
    //           keep group-1's version, keep the deletion, or merge both?"

if something else stopped you (a tool failed, no permission, a state you could
not reach):
    blockers += one sentence naming it

if decisions is empty and blockers is empty:
    return {fixed: true, summary: what you changed, blockers: [], decisions: []}
else:
    return {fixed: false, summary: how far you got, blockers: blockers, decisions: decisions}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
failedCommand yourself; or to decide anything in decisions on the user's
behalf. Each entry in decisions must be answerable without opening the repo.
Returning a decision is a correct outcome, not a failure.`

const runMergeScript = (attempt) =>
  agent(runBrief, { label: `merge:run${attempt}`, phase: 'Merge', effort: 'low', schema: RUN_SCHEMA })

const MERGE_OK = 'OK'
const MERGE_FAILED = 'FAILED'

function mergeResultCode(run) {
  if (run === null || run === undefined) return MERGE_FAILED
  if (run.ok !== true) return MERGE_FAILED
  if ((run.conflicts?.length ?? 0) > 0) return MERGE_FAILED
  return MERGE_OK
}

log(`merging ${mergeCliInput.groups.length} group(s)`)
const firstMergeAttempt = await runMergeScript(1)

if (mergeResultCode(firstMergeAttempt) === MERGE_OK) {
  return { merged: firstMergeAttempt.merged, conflicts: [], fixedBlockers: null, blockers: [], decisions: [] }
}

log('merge failed — diagnosing')
const diagnosis = await agent(
  diagnoseBrief(firstMergeAttempt ?? { ok: false, conflicts: [], error: 'merge agent returned no result' }),
  { label: 'merge:unblock', phase: 'Unblock', schema: DIAGNOSE_SCHEMA },
)

const diagnosisMissing = diagnosis === null || diagnosis === undefined
const diagnosisFixed = diagnosisMissing ? false : diagnosis.fixed
const diagnosisSummary = diagnosisMissing
  ? 'the diagnosing agent returned no result, so nothing was diagnosed and nothing was fixed'
  : diagnosis.summary

// A pending decision blocks the retry even when the agent reported fixed.
const decisionsPending = diagnosisMissing ? false : (diagnosis.decisions?.length ?? 0) > 0

if (diagnosisFixed === false || decisionsPending === true) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    fixedBlockers: false,
    blockers: diagnosisMissing ? ['the diagnosing agent returned no result'] : diagnosis.blockers,
    decisions: diagnosisMissing ? [] : diagnosis.decisions,
    summary: diagnosisSummary,
  }
}

log('blockers cleared — merging again')
const retry = await runMergeScript(2)
const retryFailed = mergeResultCode(retry) === MERGE_FAILED

return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}

```

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
};

export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };

export type MergeOutcome = {
    groupId: number;
    merged: boolean;
    conflictedFilePaths: string[];
    submoduleConflicts: SubmoduleConflict[];
    worktree: string;
    failureReason: string | null;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitErrorText(error: unknown): string {
    const failure = error as { stderr?: string; message?: string };
    return (failure.stderr || failure.message || "git merge failed").trim();
}

export type TaskWorktree = { path: string; branch: string };

function parseWorktreeListPorcelain(output: string): TaskWorktree[] {
    const blocks = output.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const worktrees: TaskWorktree[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
        if (!pathLine) continue;
        if (!branchLine) continue;
        worktrees.push({
            path: pathLine.slice("worktree ".length),
            branch: branchLine.slice("branch refs/heads/".length),
        });
    }
    return worktrees;
}

export function listTaskWorktrees(repoRoot: string): TaskWorktree[] {
    const conventionDir = join(tmpdir(), "taskTools-wt", basename(repoRoot));
    // git resolves symlinks in the paths it reports (e.g. macOS /var -> /private/var); match on the resolved form.
    if (!existsSync(conventionDir)) return [];
    const conventionRoot = realpathSync(conventionDir);
    const output = git(repoRoot, "worktree", "list", "--porcelain");
    return parseWorktreeListPorcelain(output).filter((worktree) => {
        if (!worktree.path.startsWith(`${conventionRoot}/`)) return false;
        return /^group-\d+$/.test(basename(worktree.path));
    });
}

function unmergedCommitCount(repoRoot: string, sourceBranch: string, branch: string): number {
    return Number(git(repoRoot, "rev-list", "--count", `${sourceBranch}..${branch}`).trim());
}

function commitChangedFiles(repoRoot: string, sourceBranch: string, branch: string): string[] {
    return git(repoRoot, "diff", "--name-only", `${sourceBranch}...${branch}`).split("\n").filter(Boolean);
}

// Porcelain v1 rename lines read "R  old -> new"; every other status line is "XY path".
function uncommittedChangedFiles(worktreePath: string): string[] {
    return git(worktreePath, "status", "--porcelain").split("\n").filter(Boolean).map((line) => {
        const path = line.slice(3);
        if (!path.includes(" -> ")) return path;
        return path.split(" -> ")[1];
    });
}

export type UnmergedTaskWorktree = {
    worktree: string;
    branch: string;
    unmergedCommitCount: number;
    hasUncommittedChanges: boolean;
    changedFilePaths: string[];
    matchedTaskNumbers: number[];
};

export function findUnmergedTaskWorktrees(
    repoRoot: string,
    sourceBranch: string,
    openTasks: TaskRecord[],
): UnmergedTaskWorktree[] {
    const results = listTaskWorktrees(repoRoot).map((worktree) => {
        const commitChanged = commitChangedFiles(repoRoot, sourceBranch, worktree.branch);
        const uncommittedChanged = uncommittedChangedFiles(worktree.path);
        const changedFilePaths = [...new Set([...commitChanged, ...uncommittedChanged])];
        const matchedTaskNumbers = openTasks
            .filter((task) => declaredFiles(task).some((file) => changedFilePaths.includes(file)))
            .map((task) => task.taskNumber);
        return {
            worktree: worktree.path,
            branch: worktree.branch,
            unmergedCommitCount: unmergedCommitCount(repoRoot, sourceBranch, worktree.branch),
            hasUncommittedChanges: uncommittedChanged.length > 0,
            changedFilePaths,
            matchedTaskNumbers,
        };
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    git(repoRoot, "checkout", sourceBranch);
    const outcome = { groupId: group.groupId, submoduleConflicts: [], worktree: group.worktree };
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
        const failureReason = resolution.startFailed ? gitErrorText(error) : null;
        return { ...outcome, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, failureReason };
    }
}

export function resolveGitlinkConflicts(
    repoRoot: string,
    submodulePaths: string[],
): { resolved: boolean; unexpectedConflicts: string[]; startFailed: boolean } {
    const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    // No unmerged paths means the merge never started, so there is nothing to abort, stage, or commit.
    if (conflictedPaths.length === 0) return { resolved: false, unexpectedConflicts: [], startFailed: true };
    const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
    if (unexpectedConflicts.length > 0) {
        git(repoRoot, "merge", "--abort");
        return { resolved: false, unexpectedConflicts, startFailed: false };
    }
    for (const path of conflictedPaths) git(repoRoot, "add", path);
    git(repoRoot, "commit", "--no-edit");
    return { resolved: true, unexpectedConflicts: [], startFailed: false };
}

export function mergeSubmoduleBranchIntoRepo(
    mainSubmodulePath: string,
    worktreeSubmodulePath: string,
    sourceBranch: string,
): { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null } {
    const groupBranch = currentBranchName(worktreeSubmodulePath);
    git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
    git(mainSubmodulePath, "checkout", sourceBranch);
    try {
        git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
        return { merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        // Same rule as the parent repo: with no unmerged paths there is no merge in progress to abort.
        if (conflictedFilePaths.length === 0) return { merged: false, conflictedFilePaths, failureReason: gitErrorText(error) };
        git(mainSubmodulePath, "merge", "--abort");
        return { merged: false, conflictedFilePaths, failureReason: null };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runDiscoverCli(): void {
    const repoRoot = process.cwd();
    const sourceBranch = currentBranchName(repoRoot);
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    process.stdout.write(JSON.stringify(results));
}

function runMergeCli(worktreePath: string): void {
    const repoRoot = process.cwd();
    const repositorySources = collectRepositorySources(repoRoot);
    const parentSource = repositorySources.find((source) => source.path === "");
    if (!parentSource) throw new Error(`no recorded source branch for repository path "${repoRoot}"`);
    const submodulePathsDeepestFirst = repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const branch = currentBranchName(worktreePath);
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

function runPipelineCli(): void {
    const input: CliInput = JSON.parse(process.argv[2]);
    const workflowArguments: WorkflowArguments = {
        repo: input.repo,
        typecheckCommand: input.typecheckCommand,
        groups: input.groups,
        repositorySources: input.repositorySources,
    };
    const sortedGroups = [...workflowArguments.groups].sort((a, b) => a.groupId - b.groupId);
    const submodulePathsDeepestFirst = workflowArguments.repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const findSourceBranch = (path: string): string => {
        const found = workflowArguments.repositorySources.find((source) => source.path === path);
        if (!found) throw new Error(`no recorded source branch for repository path "${path}"`);
        return found.sourceBranch;
    };

    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        for (const submodulePath of submodulePathsDeepestFirst) {
            const outcome = mergeSubmoduleBranchIntoRepo(
                join(workflowArguments.repo, submodulePath),
                join(group.worktree, submodulePath),
                findSourceBranch(submodulePath),
            );
            if (!outcome.merged) submoduleConflicts.push({ path: submodulePath, conflictedFilePaths: outcome.conflictedFilePaths, failureReason: outcome.failureReason });
        }
        if (submoduleConflicts.length > 0) {
            conflicts.push({ groupId: group.groupId, merged: false, conflictedFilePaths: [], submoduleConflicts, worktree: group.worktree, failureReason: null });
            continue;
        }
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
    }
    const endTimestamp = new Date().toISOString();
    appendRunMetricsRecord(workflowArguments.repo, {
        runId: input.runId ?? endTimestamp,
        startTimestamp: input.startTimestamp ?? null,
        endTimestamp,
        durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
        taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)),
        groupCount: sortedGroups.length,
        doneCount: input.doneCount ?? 0,
        partialCount: input.partialCount ?? 0,
        blockedCount: input.blockedCount ?? 0,
        needsClarificationCount: input.needsClarificationCount ?? 0,
        requeueCount: input.requeueCount ?? 0,
        conflictCount: conflicts.length,
        argumentsHash: computeArgumentsHash(workflowArguments),
    });
    process.stdout.write(JSON.stringify({ merged, conflicts }));
}

function runAsCli(): void {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    runPipelineCli();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```
