# Task 15 plan — resume into ARCHIVE_TASK can never succeed (missing closureNote)

Session task 15 (`/Users/matkatmusicllc/.claude/tasks/taskTools-86/15.json`). Spec: exit audit
MSE-19 / codex-review "High: task 16's proposed lease assertion..." context. `findResumeEntry`'s
row 3 (`scripts/tackle-tasks/shared/resumeRun.ts:29-38`) resumes an inactive run straight into
`ARCHIVE_TASK` with a 5-field packet that satisfies `BUILD_CLOSURE_NOTE`'s input contract but not
`ARCHIVE_TASK`'s (missing `closureNote`), so `getStartInputMismatches` rejects every retry forever.
`resumeRun.test.ts:166-181` asserts that broken payload as the expected value.

## Scope confirmation

- `scripts/tackle-tasks/shared/resumeRun.ts` — read in full. Lines 29-38 today:
  ```ts
      if (newest !== null && newest.exitType === "completed") { // row 3
          const input = JSON.stringify({
              box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
              projectRoot, taskNumber, runId: newest.runId,
          });
          const block = state.active
              ? "pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE"
              : "pipeline-mergeSucceededExit.mmd::ARCHIVE_TASK";
          return { block, input };
      }
  ```
  The `input` object is byte-for-byte `CLEAN_UP_WORKTREES`'s own output shape (confirmed against
  `scripts/tackle-tasks/mergeSucceededExit/CLEAN_UP_WORKTREES.template.json`'s `output`, which is
  `{box, scriptSignal, projectRoot, taskNumber, runId}`), and it is also byte-for-byte
  `BUILD_CLOSURE_NOTE.template.json`'s `input` (same five fields, same values). It is **not**
  `ARCHIVE_TASK.template.json`'s `input`, which additionally requires `closureNote`.
  `scripts/steps.json`'s `pipeline-mergeSucceededExit.mmd` array confirms the real box order is
  `CLEAN_UP_WORKTREES -> BUILD_CLOSURE_NOTE -> MARK_TASK_INACTIVE_SUCCESS -> ARCHIVE_TASK ->
  REPORT_CLOSURE_NOTE -> STOP` — `BUILD_CLOSURE_NOTE` is the box that actually follows
  `CLEAN_UP_WORKTREES`, never `ARCHIVE_TASK` directly.
  `scripts/tackle-tasks/mergeSucceededExit/BUILD_CLOSURE_NOTE.ts` is annotated "Read-only: runs
  correctly even after CLEAN_UP_WORKTREES deletes the worktree" and
  `scripts/tackle-tasks/shared/markTaskInactive.ts:9-19` (`MARK_TASK_INACTIVE_SUCCESS`'s
  implementation) already short-circuits to the prior result when `!existing.active &&
  newest.runId === input.runId && newest.endedAt !== null` — i.e. it is idempotent when the run is
  already inactive. So retargeting row 3 to always land on `BUILD_CLOSURE_NOTE` is safe whether
  `state.active` is true or false: the walk simply replays `BUILD_CLOSURE_NOTE` (harmless
  re-derivation) and `MARK_TASK_INACTIVE_SUCCESS` (harmless no-op when already inactive) before
  reaching `ARCHIVE_TASK` with a freshly-built, contract-satisfying `closureNote`.
- `scripts/tackle-tasks/shared/resumeRun.test.ts` — read in full (402 lines).
  Lines 166-181 today:
  ```ts
  test("test_findResumeEntry_resumesTheMergeTailAtArchiveTaskWhenInactive", () => {
      const rootOrigin = makeSourceRepoWithSubmodule();
      const taskNumber = 9204;
      const runId = "run-9204";
      seedTaskAndClaim(rootOrigin, taskNumber, "merge tail inactive", runId, []);
      updateCurrentTaskRun(taskNumber, runId, { exitType: "completed" }, rootOrigin);
      endTaskRun(taskNumber, runId, rootOrigin);

      const { tasksPath } = resolveTaskFiles(rootOrigin);
      const entry = findResumeEntry(taskNumber, tasksPath);

      assert.deepEqual(entry, {
          block: "pipeline-mergeSucceededExit.mmd::ARCHIVE_TASK",
          input: JSON.stringify({ box: "CLEAN_UP_WORKTREES", scriptSignal: "continue", projectRoot: rootOrigin, taskNumber, runId }),
      });
  });
  ```
  This pins the broken payload as correct. It must be replaced (not merely have its expected value
  edited) with a test that also runs the resumed input through the real shape-contract checker, per
  the task's own instruction ("Replace the test with one that runs the resumed input through the
  real contract check"), because a hand-typed expected object can drift from the template again
  without anyone noticing.
  The sibling test at lines 150-164, `test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhileActive`,
  already expects `BUILD_CLOSURE_NOTE` for the active case and needs no change.
- `scripts/tackle-tasks/mergeSucceededExit/BUILD_CLOSURE_NOTE.template.json` — read-only reference;
  its `input` field is the contract the new test checks the resumed payload against.
- `scripts/templateShape.ts` — read-only reference; `getTemplateShapeMismatches(template, actual)` is
  exported and already used by `runStepHook.ts`'s own `getStartInputMismatches` for exactly this
  check, so the new test reuses it instead of re-deriving shape-comparison logic.

No other file needs an edit for this task. `scripts/tackle-tasks/shared/taskRunState.ts`,
`scripts/tackle-tasks/mergeSucceededExit/ARCHIVE_TASK.ts`, and
`scripts/tackle-tasks/mergeSucceededExit/MARK_TASK_INACTIVE_SUCCESS.ts` are read-only references
cited above to justify the fix's safety; task 16 is the plan that adds new machinery
(`tailCursor`) to `taskRunState.ts` and `resumeRun.ts` on top of this task's result.

## Steps

### Step 1 — replace the test that pins the broken ARCHIVE_TASK payload (RED)

Test name: `test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhenInactiveAndSatisfiesItsContract`.

Plain-English steps (write as comments in the test body, matching this file's existing style):
- a task is claimed, then its run is marked `exitType: "completed"` and ended (`state.active === false`), with no worktree ever attached — this is the exact "crash after ARCHIVE_TASK or after the worktree is gone" shape MSE-19 describes.
- `findResumeEntry` is called for that task.
- it must resume at `BUILD_CLOSURE_NOTE`, not `ARCHIVE_TASK`, regardless of `active` being false.
- the resumed `input`, parsed as JSON, must satisfy `BUILD_CLOSURE_NOTE.template.json`'s `input`
  contract with zero mismatches — the "real contract check" the task asks for.

In `scripts/tackle-tasks/shared/resumeRun.test.ts`:
1. Add two imports at the top: `import { readFileSync } from "node:fs";` (extend the existing
   `node:fs` import at line 5, which currently imports `mkdirSync, utimesSync, writeFileSync`) and
   `import { getTemplateShapeMismatches } from "../../templateShape.ts";`.
2. Replace the test at lines 166-181 with:
   ```ts
   test("test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhenInactiveAndSatisfiesItsContract", () => {
       const rootOrigin = makeSourceRepoWithSubmodule();
       const taskNumber = 9204;
       const runId = "run-9204";
       seedTaskAndClaim(rootOrigin, taskNumber, "merge tail inactive", runId, []);
       updateCurrentTaskRun(taskNumber, runId, { exitType: "completed" }, rootOrigin);
       endTaskRun(taskNumber, runId, rootOrigin);

       const { tasksPath } = resolveTaskFiles(rootOrigin);
       const entry = findResumeEntry(taskNumber, tasksPath);

       assert.deepEqual(entry, {
           block: "pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE",
           input: JSON.stringify({ box: "CLEAN_UP_WORKTREES", scriptSignal: "continue", projectRoot: rootOrigin, taskNumber, runId }),
       });

       const templatePath = join(import.meta.dirname, "../mergeSucceededExit/BUILD_CLOSURE_NOTE.template.json");
       const template = JSON.parse(readFileSync(templatePath, "utf8"));
       assert.deepEqual(getTemplateShapeMismatches(template.input, JSON.parse(entry!.input)), []);
   });
   ```
   `import.meta.dirname` is available because this test file already imports nothing that would
   conflict; `join` is already imported from `node:path` at line 7.

Run `npm test -- scripts/tackle-tasks/shared/resumeRun.test.ts` and confirm this one test fails
(RED) — it still asserts `BUILD_CLOSURE_NOTE` while production code returns `ARCHIVE_TASK`.

### Step 2 — retarget row 3 to always resume at BUILD_CLOSURE_NOTE (GREEN)

In `scripts/tackle-tasks/shared/resumeRun.ts`, replace lines 29-38:
```ts
    if (newest !== null && newest.exitType === "completed") { // row 3
        const input = JSON.stringify({
            box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            projectRoot, taskNumber, runId: newest.runId,
        });
        const block = state.active
            ? "pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE"
            : "pipeline-mergeSucceededExit.mmd::ARCHIVE_TASK";
        return { block, input };
    }
```
with:
```ts
    if (newest !== null && newest.exitType === "completed") { // row 3
        const input = JSON.stringify({
            box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            projectRoot, taskNumber, runId: newest.runId,
        });
        // Always BUILD_CLOSURE_NOTE, active or not: ARCHIVE_TASK needs a closureNote this packet
        // never carries, and BUILD_CLOSURE_NOTE / MARK_TASK_INACTIVE_SUCCESS are both idempotent,
        // so replaying them before ARCHIVE_TASK is always safe (MSE-19).
        return { block: "pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE", input };
    }
```
Do not remove `state.active` from the function entirely — it is still read at row 4
(`if (state.active) { // row 4`), a few lines below; leave that branch untouched.

Run `npm test -- scripts/tackle-tasks/shared/resumeRun.test.ts` again: the new test and
`test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhileActive` (lines 150-164) both pass;
no other test in the file references `ARCHIVE_TASK`, confirmed via
`grep -n ARCHIVE_TASK scripts/tackle-tasks/shared/resumeRun.test.ts`.

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
If not all passing, follow up with `npm test 2>&1 | tail -50` and fix, repeating until green.
