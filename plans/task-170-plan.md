# Task 170 plan: gate the beginNextLap branch on outstandingEntries.size === 0

## Problem

In `scripts/tackleTasksBrief.ts`, the generated brief's merge-queue step 3
unconditionally tells the orchestrator to call `beginNextLap(queue)` whenever
`shouldEndQueue` prints `"continue"` and `queue.carryover` is non-empty. It
never checks whether a workflow (e.g. task B still planning) is outstanding.
That defeats task 148's outstanding-workflow exception: task A can start lap
2 against an unchanged source tip while task B's approval is still pending,
burning A's retry ceiling for nothing.

## Edit 1: scripts/tackleTasksBrief.ts, line 148

Current text (the full line, a single template-literal numbered list item):

```
3. Run \`shouldEndQueue(queue, workflowOutstanding)\`. If it prints \`"done"\`, no pending or retryable work remains: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. If it prints \`"stuck"\`, a lap merged zero tasks and nothing is outstanding: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user the same way. If it prints \`"continue"\` and \`queue\`'s \`carryover\` is non-empty, run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, and go back to step 1. If it prints \`"continue"\` and \`carryover\` is empty, a task is still planning, implementing, or waiting on its own gate — wait for the next enqueue or completion notification, then go back to step 1.
```

Becomes (only the last two sentences change; everything up to and including
the `"stuck"` sentence stays byte-identical):

```
3. Run \`shouldEndQueue(queue, workflowOutstanding)\`. If it prints \`"done"\`, no pending or retryable work remains: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. If it prints \`"stuck"\`, a lap merged zero tasks and nothing is outstanding: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user the same way. If it prints \`"continue"\` and \`queue\`'s \`carryover\` is non-empty and \`outstandingEntries.size === 0\`, run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, and go back to step 1. If it prints \`"continue"\` and either \`carryover\` is empty or \`outstandingEntries.size\` is greater than \`0\`, a task is still planning, implementing, or waiting on its own gate, or another task's workflow is still outstanding — wait for the next enqueue or completion notification, then go back to step 1.
```

Use the Edit tool with `old_string` set to the "Current text" block above
(the exact line, escaped backticks included, no surrounding fence) and
`new_string` set to the "Becomes" block above. This is the only edit to
this file — no other line in `scripts/tackleTasksBrief.ts` mentions
`beginNextLap` or the carryover/outstanding logic.

## Edit 2: tests/tackleTasksBrief.test.ts, after line 85

Current text at lines 84-87:

```
  assert.doesNotMatch(brief, /close-tasks/);
});

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
```

Insert a new test between the `});` on line 85 and the blank line 86, so
the file becomes:

```
  assert.doesNotMatch(brief, /close-tasks/);
});

test("merge queue: the next-lap branch waits for an outstanding workflow instead of starting another lap against the same tip", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /carryover` is non-empty and `outstandingEntries\.size === 0`, run `beginNextLap\(queue\)`/);
  assert.match(brief, /either `carryover` is empty or `outstandingEntries\.size` is greater than `0`, a task is still planning, implementing, or waiting on its own gate, or another task's workflow is still outstanding — wait for the next enqueue or completion notification/);
});

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
```

Use the Edit tool with `old_string`:

```
  assert.doesNotMatch(brief, /close-tasks/);
});

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
```

and `new_string`:

```
  assert.doesNotMatch(brief, /close-tasks/);
});

test("merge queue: the next-lap branch waits for an outstanding workflow instead of starting another lap against the same tip", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /carryover` is non-empty and `outstandingEntries\.size === 0`, run `beginNextLap\(queue\)`/);
  assert.match(brief, /either `carryover` is empty or `outstandingEntries\.size` is greater than `0`, a task is still planning, implementing, or waiting on its own gate, or another task's workflow is still outstanding — wait for the next enqueue or completion notification/);
});

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
```

This is the only edit to this file. No existing assertion in
`tests/tackleTasksBrief.test.ts` references `beginNextLap`, `carryover`, or
`outstandingEntries.size`, so none of the other regexes (lines 39-111,
covering the sliding-window launch, the gate section, and the merge-queue
section's step-1 text) match against step 3's wording and none of them
break from this edit.

## tests/runMergePhase.test.ts: no edit

`shouldEndQueue`'s signature and return values (`"done"` / `"stuck"` /
`"continue"`) are unchanged by this task — the fix is entirely in the prose
`tackleTasksBrief.ts` generates for the human/orchestrator to follow when
driving the merge queue by hand; `outstandingEntries` is a plain object the
orchestrator tracks in the conversation, not a value `runMergePhase.ts`
computes or returns. The existing coverage at lines 104-111
(`test_shouldEndQueueDoesNotEndTheQueueWhenALapMergesZeroTasksButAWorkflowIsOutstanding`)
already exercises the one relevant runMergePhase.ts behavior — that
`shouldEndQueue(queue, true)` returns `"continue"` — and that behavior does
not change. There is no production function in `runMergePhase.ts` for a new
test to target, so this file needs no edit.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npm test
```

Expected: all tests pass, including the new test
`"merge queue: the next-lap branch waits for an outstanding workflow instead of starting another lap against the same tip"`
in `tests/tackleTasksBrief.test.ts`, and every pre-existing test in
`tests/tackleTasksBrief.test.ts` and `tests/runMergePhase.test.ts` (node's
test runner reports 0 failing).

Also confirm the generated brief text directly:

```
node --input-type=module -e "import { tackleTasksBrief } from './scripts/tackleTasksBrief.ts'; const b = tackleTasksBrief('[1]', 'task 1: unblocked'); console.log(b.includes('outstandingEntries.size === 0'), b.includes('outstandingEntries.size` is greater than `0'));"
```

Expected output: `true true`.
