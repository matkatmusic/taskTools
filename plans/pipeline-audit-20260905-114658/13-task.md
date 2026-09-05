# Task 13 plan — preflight disk-space check before MARK_TASK_ACTIVE

## Scope confirmation

- `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` — read in full (58 lines).
  - Line 8: `IS_TASK_ACTIVE_Q["is the task active?"]` — the box immediately before the insertion point.
  - Line 9: `MARK_TASK_ACTIVE["mark the task active in tasks.json"]` — the box the task claim happens in; per the task brief, the new check must sit before this box runs, because after it the packet has no worktree yet and routing a failure into `FAILURES_EXIT` would crash `READ_FAILURES_PUBLICATION_STATE.ts` and `RECORD_MODIFIED_FILES_FAILURE.ts`, both of which assume a real worktree.
  - Line 34: `IS_TASK_ACTIVE_Q -- "NO" --> MARK_TASK_ACTIVE` — the one edge that must be retargeted at the new box.
  - Line 56: the `class ...  script` line listing every box in this diagram for the green fill — the new box must join it.
  - Confirmed live: `sed -n '1,58p' diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` matches all four lines above exactly.

- `scripts/tackle-tasks/preambleStatusCheck/` — 14 existing box scripts, each `<BOX>.ts` + `<BOX>.template.json` + `<BOX>.test.ts`, one shared `_packet.ts` defining `EntryPacket`:
  ```ts
  export type EntryPacket = {
      box: string; scriptSignal: string; taskNumber: number; runId: string; projectRoot: string;
      worktree: string; branch: string; docsMode: string; planFile: string; exitType: string; exitNote: string;
  };
  ```
  - `IS_TASK_ACTIVE_Q.ts`, in full today:
    ```ts
    export function main(input: string): EntryPacket & { next: string } {
        const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
        if (readTaskRunState(packet.taskNumber, packet.projectRoot).active) {
            return { ...packet, box: "IS_TASK_ACTIVE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType: "already-active", exitNote: "a previous run left the task active", next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT" };
        }
        return { ...packet, box: "IS_TASK_ACTIVE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "MARK_TASK_ACTIVE" };
    }
    ```
    Line with `next: "MARK_TASK_ACTIVE"` is the literal this task must retarget — the diagram edge alone does not change what this script prints.
  - `IS_TASK_ACTIVE_Q.template.json`, `output.next` today reads `"MARK_TASK_ACTIVE"` — must track the script edit, or `stepTemplates.test.ts`'s `producesItsOutputContract` test for this box fails (it runs the real script against `template.input` and diffs the real output against `template.output`).
  - `IS_TASK_ACTIVE_Q.test.ts`, line `assert.equal(output.next, "MARK_TASK_ACTIVE");` inside `test_IS_TASK_ACTIVE_Q_continuesToMarkTaskActiveWhenNotActive` — must track the same edit.
  - `IS_PREVIOUS_RUN_RESUMABLE_Q.ts`/`.template.json` read as the shape model for a decision box that routes across diagrams (`next: "pipeline-failuresExit.mmd::FAILURES_EXIT"` for its NO branch), matching the `diagram.mmd::BOX` convention this task's own cross-diagram edge to `REPORT_ONLY_EXIT` must use.
  - `_packet.ts` — the type every box script imports; unchanged by this task (the new box carries the same `EntryPacket` shape, no new field).

- `scripts/tackle-tasks/reportOnlyExit/REPORT_ONLY_EXIT.ts`, in full today:
  ```ts
  export function main(input: string): Record<string, unknown> {
      const packet = JSON.parse(input) as EntryPacket;
      return { ...packet, box: "REPORT_ONLY_EXIT", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
  }
  ```
  Reads `packet.exitType`/`packet.exitNote` implicitly (they pass through the spread) and does not require a worktree — confirming this box is safe to route into before a worktree exists, unlike `FAILURES_EXIT`.

- `scripts/generateSteps.ts`
  - Lines 12–17, `BLOCKS_BY_OWNER_FOLDER.preambleStatusCheck`, today lists all 14 existing boxes by name. A box missing from this map still gets a correct owner folder via `getDefaultOwnerFolder` (line 301, first diagram that draws it) — so listing the new box here is not required for correctness, but every real box in this diagram is listed today and leaving the new one out would be the one silent exception; add it for consistency with the existing pattern.
  - Line 341–353: an existing `<BOX>.ts`/`<BOX>.template.json` is never overwritten by `generateSteps`; a missing one is stubbed. This is how `npm run steps` creates the new box's starting files after the diagram edit.
  - Lines 148–175, `seedInputTemplatesFromPredecessors`: for a **new** template only, copies the predecessor's `output` into the new template's `input`. Since `IS_TASK_ACTIVE_Q`'s current `output.projectRoot` is `"{{PROJECT_ROOT}}/scripts/tackle-tasks/preambleStatusCheck/fixtures"` (a real, existing directory — confirmed via `cat scripts/tackle-tasks/preambleStatusCheck/IS_TASK_ACTIVE_Q.template.json`), the new box's auto-seeded `input.projectRoot` will point at that same real fixture directory.

- `scripts/generateWorkflow.ts` — fully generated from `scripts/steps.json`; no manual edit needed once `npm run steps` (which chains `generateSteps.ts` then `generateWorkflow.ts` per `package.json`'s `"steps"` script) has run.

- `tests/stepTemplates.test.ts` — read in full. This is the seam gate every box in `scripts/steps.json` is checked against, generated dynamically per box:
  - `test_stepTemplate_<diagram>_<box>_producesItsOutputContract` (lines 79–85): runs the real script (not mutating boxes only) against its own `template.input`, and shape-checks the real printed output against `template.output` via `getTemplateShapeMismatches` (`scripts/templateShape.ts` — key/kind match only, not value equality). The new box is not mutating (no writes), so it is included; its `template.output` must describe the branch the real check actually takes against the real fixture directory's real free disk space — on any real machine this is the "sufficient" branch, so `template.output.next` must be `"MARK_TASK_ACTIVE"` with `exitType`/`exitNote` empty.
  - `test_stepEdge_<box>_to_<targetBox>_agreesOnTheShape` (lines 99–115): checks `IS_TASK_ACTIVE_Q`'s handed-on shape (its template's `output`, minus `next`) against the new box's `template.input` — satisfied automatically by the auto-seed described above, since both share the `EntryPacket` shape.
  - `test_stepTemplate_<box>_everyNextLiteralIsADeclaredEdge` (lines 133–151): regex-extracts every literal `next: "..."` from the box's own source and asserts each one is in the edge set `scripts/steps.json` computes for that script from the diagram. This is what makes editing `IS_TASK_ACTIVE_Q.ts`'s literal (Step 3 below) mandatory, not optional — leaving the diagram edge changed but the script's literal unchanged fails this exact test (`"MARK_TASK_ACTIVE" not one of IS_DISK_SPACE_SUFFICIENT_Q, pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT"`). This is the gate the user's own notes call out by name for a migration like this one — get it right in the same pass as the diagram edit, not after.

## Steps

New box name: `IS_DISK_SPACE_SUFFICIENT_Q` (matches the `_Q` convention already used for every yes/no box in this diagram).

### Step 1 — edit the diagram

In `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd`:

1. Line 8→9, insert a new node declaration between `IS_TASK_ACTIVE_Q` and `MARK_TASK_ACTIVE`:
   ```
   IS_TASK_ACTIVE_Q["is the task active?"]
   IS_DISK_SPACE_SUFFICIENT_Q["is there enough disk space for a worktree?"]
   MARK_TASK_ACTIVE["mark the task active in tasks.json"]
   ```
2. Line 34, replace:
   ```
   IS_TASK_ACTIVE_Q -- "NO" --> MARK_TASK_ACTIVE
   ```
   with:
   ```
   IS_TASK_ACTIVE_Q -- "NO" --> IS_DISK_SPACE_SUFFICIENT_Q
   IS_DISK_SPACE_SUFFICIENT_Q -- "NO<br/>low-disk" --> REPORT_ONLY_EXIT
   IS_DISK_SPACE_SUFFICIENT_Q -- "YES" --> MARK_TASK_ACTIVE
   ```
3. Line 56, add `IS_DISK_SPACE_SUFFICIENT_Q` to the `class` list, immediately after `IS_TASK_ACTIVE_Q`:
   ```
   class PREAMBLE_STATUS_CHECK,IS_TASK_BLOCKED_Q,IS_TASK_ACTIVE_Q,IS_DISK_SPACE_SUFFICIENT_Q,MARK_TASK_ACTIVE,DOES_WORKTREE_EXIST_Q,CREATE_WORKTREE,TAKE_WORKTREE_LEASE,IS_WORKTREE_SAFE_TO_USE_Q,TAKE_WORKTREE_LEASE_BEFORE_RESET,RESET_WORKTREE,IS_PREVIOUS_RUN_RESUMABLE_Q,DOES_FENCE_COVER_WORKTREE_Q,INIT_SUBMODULES_RECURSIVELY,DOCUMENT_GENERATION script
   ```

### Step 2 — register the box's owner folder (consistency, not correctness)

In `scripts/generateSteps.ts`, line 13, add the new box name to the existing list:
```ts
"PREAMBLE_STATUS_CHECK", "IS_TASK_BLOCKED_Q", "IS_TASK_ACTIVE_Q", "IS_DISK_SPACE_SUFFICIENT_Q", "MARK_TASK_ACTIVE", "DOES_WORKTREE_EXIST_Q",
```

### Step 3 — run the generator to create the stub

```sh
npm run steps
```
This writes `scripts/tackle-tasks/preambleStatusCheck/IS_DISK_SPACE_SUFFICIENT_Q.ts` (a stub `main` that echoes its input) and `IS_DISK_SPACE_SUFFICIENT_Q.template.json` (with `input` auto-seeded from `IS_TASK_ACTIVE_Q`'s current `output`), regenerates `scripts/steps.json`, and rewrites `skills/tackle-tasks/tackle-tasks.workflow.js`. Both new files are then author-owned — a second `npm run steps` run will not touch them again.

### Step 4 — retarget `IS_TASK_ACTIVE_Q`'s own literal

`IS_TASK_ACTIVE_Q.ts`, the `return` for the not-active branch:
```ts
// before
return { ...packet, box: "IS_TASK_ACTIVE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "MARK_TASK_ACTIVE" };
// after
return { ...packet, box: "IS_TASK_ACTIVE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "IS_DISK_SPACE_SUFFICIENT_Q" };
```

`IS_TASK_ACTIVE_Q.template.json`, `output.next`: `"MARK_TASK_ACTIVE"` → `"IS_DISK_SPACE_SUFFICIENT_Q"`.

`IS_TASK_ACTIVE_Q.test.ts`, in `test_IS_TASK_ACTIVE_Q_continuesToMarkTaskActiveWhenNotActive`:
```ts
// before
assert.equal(output.next, "MARK_TASK_ACTIVE");
// after
assert.equal(output.next, "IS_DISK_SPACE_SUFFICIENT_Q");
```
The other test in that file, `test_IS_TASK_ACTIVE_Q_exitsWhenAPreviousRunLeftTheTaskActive`, asserts the already-active branch (`next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT"`) — untouched by this task, no edit.

### Step 5 — red: write `IS_DISK_SPACE_SUFFICIENT_Q.test.ts`

Overwrite the generator's stub test with (the generator does not create a `.test.ts`, so this is a new file):

```ts
// IS_DISK_SPACE_SUFFICIENT_Q.ts is "is there enough disk space for a worktree?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/IS_DISK_SPACE_SUFFICIENT_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, type StatsFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_DISK_SPACE_SUFFICIENT_Q.ts";
import { main as isTaskActiveMain } from "./IS_TASK_ACTIVE_Q.ts";
import { readTaskRunState } from "../shared/taskRunState.ts";

function packet(projectRoot: string): string {
    return JSON.stringify({
        box: "IS_TASK_ACTIVE_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot,
        worktree: "", branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "IS_DISK_SPACE_SUFFICIENT_Q",
    });
}

function fakeStatfs(bavail: number, bsize: number): (path: string) => StatsFs {
    return () => ({ bavail, bsize } as StatsFs);
}

test("test_IS_DISK_SPACE_SUFFICIENT_Q_continuesToMarkTaskActiveWhenSpaceIsSufficient", () => {
    // Plain-English step: a fake statfs reports 3 GB free; the box must continue to MARK_TASK_ACTIVE.
    const output = main(packet("/tmp"), fakeStatfs(3 * 1024 * 1024, 1024));
    assert.equal(output.next, "MARK_TASK_ACTIVE");
    assert.equal(output.exitType, "");
});

test("test_IS_DISK_SPACE_SUFFICIENT_Q_exitsWithLowDiskWhenSpaceIsInsufficient", () => {
    // Plain-English step: a fake statfs reports 1 GB free, under the 2 GB floor; the box must route to REPORT_ONLY_EXIT.
    const output = main(packet("/tmp"), fakeStatfs(1 * 1024 * 1024, 1024));
    assert.equal(output.next, "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT");
    assert.equal(output.exitType, "low-disk");
    assert.match(output.exitNote, /1024 MB free/);
    assert.match(output.exitNote, /does not guarantee/);
});

test("test_IS_DISK_SPACE_SUFFICIENT_Q_leavesTheTaskInactiveWhenRoutedFromIsTaskActiveQWithLowDiskSpace", () => {
    // Plain-English step: an inactive task passes through IS_TASK_ACTIVE_Q, then hits low disk space; the task must never be marked active.
    const root = mkdtempSync(join(tmpdir(), "IS_DISK_SPACE_SUFFICIENT_Q-route-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber: 1 }]));
    const activeInput = JSON.stringify({
        box: "IS_TASK_BLOCKED_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot: root,
        worktree: "", branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "IS_TASK_ACTIVE_Q",
    });
    const activeOutput = isTaskActiveMain(activeInput);
    // Verification: the first decision's next is the disk check, matching the diagram order.
    assert.equal(activeOutput.next, "IS_DISK_SPACE_SUFFICIENT_Q");
    const { next: _next, ...activePacket } = activeOutput;
    const diskOutput = main(JSON.stringify(activePacket), fakeStatfs(1 * 1024 * 1024, 1024));
    // Verification: the disk check routes to REPORT_ONLY_EXIT, and the task was never claimed.
    assert.equal(diskOutput.next, "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT");
    assert.equal(diskOutput.exitType, "low-disk");
    assert.equal(readTaskRunState(1, root).active, false);
});
```

This last test pins the safety property the box exists for, not just its own return strings: it drives a real `IS_TASK_ACTIVE_Q` decision into a real `IS_DISK_SPACE_SUFFICIENT_Q` decision against a real `tasks.json`, and checks `readTaskRunState` — the same function `MARK_TASK_ACTIVE.ts` and `IS_TASK_ACTIVE_Q.ts` both read — never saw a claim. A future change that reordered the diagram or let a different box call `claimTask` before the disk check would fail this test even if the two unit tests above stayed green.

All three fail today: the file does not exist (Step 3's stub only has the CLI-echo behavior, no `MINIMUM_FREE_BYTES` logic, and does not accept a second `statfs` argument).

### Step 6 — green: fill in the real box script

Overwrite `scripts/tackle-tasks/preambleStatusCheck/IS_DISK_SPACE_SUFFICIENT_Q.ts` (the stub from Step 3):

```ts
// IS_DISK_SPACE_SUFFICIENT_Q, from pipeline-preambleStatusCheck.mmd. "is there enough disk space for a worktree?"
import { existsSync, realpathSync, statfsSync, type StatsFs } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../prepareTasks.ts";
import type { EntryPacket } from "./_packet.ts";

const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

// The worktree parent may not exist yet; statfs needs a real path, so walk up until one exists.
function nearestExistingAncestor(path: string): string {
    if (existsSync(path)) return path;
    return nearestExistingAncestor(dirname(path));
}

// A second argument lets tests fake the syscall; production always uses the real one.
export function main(input: string, statfs: (path: string) => StatsFs = statfsSync): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const worktreeParent = resolveTaskWorktreeConventionDirectory(packet.projectRoot);
    const ancestor = nearestExistingAncestor(worktreeParent);
    const stats = statfs(ancestor);
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < MINIMUM_FREE_BYTES) {
        const freeMb = Math.floor(freeBytes / (1024 * 1024));
        return {
            ...packet,
            box: "IS_DISK_SPACE_SUFFICIENT_Q",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            exitType: "low-disk",
            exitNote: `only ${freeMb} MB free at "${ancestor}"; the pipeline requires at least 2048 MB free but this check does not guarantee enough capacity for the repository and its test suite`,
            next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT",
        };
    }
    return { ...packet, box: "IS_DISK_SPACE_SUFFICIENT_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "MARK_TASK_ACTIVE" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```

`resolveTaskWorktreeConventionDirectory` is reused, not re-derived: it is the exact function `createWorktreeForGroup` calls to place a task's worktree (`scripts/prepareTasks.ts` line 377), so this check inspects the real volume `CREATE_WORKTREE` will write to, including the sha256-hashed-repo-path convention. The CLI invocation at the bottom calls `main(input)` with no second argument, so production always uses the real `statfsSync`; only the test file passes a fake.

### Step 7 — fill in the new box's template output

Overwrite `scripts/tackle-tasks/preambleStatusCheck/IS_DISK_SPACE_SUFFICIENT_Q.template.json`'s `output` field (its `input` field is left as Step 3 auto-seeded it — do not hand-edit `input`):

```json
{
    "input": { "...": "left as auto-seeded by npm run steps in Step 3" },
    "output": {
        "box": "IS_DISK_SPACE_SUFFICIENT_Q",
        "scriptSignal": "continue",
        "taskNumber": 1,
        "runId": "",
        "projectRoot": "{{PROJECT_ROOT}}/scripts/tackle-tasks/preambleStatusCheck/fixtures",
        "worktree": "",
        "branch": "task-1",
        "docsMode": "",
        "planFile": "",
        "exitType": "",
        "exitNote": "",
        "next": "MARK_TASK_ACTIVE"
    }
}
```
This must be the "sufficient space" branch: `tests/stepTemplates.test.ts`'s `producesItsOutputContract` test runs the real script against this exact `input` on the real machine running the suite, and any real machine has far more than 2 GB free at `{{PROJECT_ROOT}}` — the "low-disk" branch is exercised only by Step 5's fake-statfs unit test, never by the real-script contract test.

### Step 8 — regenerate once more and confirm no drift

```sh
npm run steps
```
Expected: no diff to any file this task already wrote by hand (`git status --porcelain` shows nothing new under `scripts/tackle-tasks/preambleStatusCheck/` or `scripts/steps.json` beyond what Steps 3–7 produced) — this run is a no-op confirmation that the diagram, `steps.json`, and `skills/tackle-tasks/tackle-tasks.workflow.js` all agree.

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

Pay particular attention to every `test_stepTemplate_preambleStatusCheck_*` and `test_stepEdge_*` line in the log if the run is not clean — these are the seam-gate tests this plan's Step 4 and Step 7 exist specifically to keep green. If it does not report "all passing", run `Bash(npm test 2>&1 | tail -50)` and fix the codebase until it does. Do not re-run `npm test` again once it reports "all passing".

## Draft on disk from another session

Uncommitted work from another session (task-list items 30 to 32) overlaps this plan:
- diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd lines 9, 35-37, 59: a PREFLIGHT_OK_Q box between IS_TASK_ACTIVE_Q and MARK_TASK_ACTIVE, routing NO to REPORT_ONLY_EXIT.
- scripts/tackle-tasks/preambleStatusCheck/PREFLIGHT_OK_Q.ts, .test.ts, .template.json (untracked): checkDiskSpace (5 GB, statfs on projectRoot), checkPlanModeDefault (reads settings files), checkDuplicateHookRegistration (script basename per event).
- scripts/steps.json and IS_TASK_ACTIVE_Q.template.json regenerated for that box.
- This plan owns the disk check. Its box replaces PREFLIGHT_OK_Q on the IS_TASK_ACTIVE_Q edge; the draft box leaves the diagram, and its script files are commented out. The plan-mode and duplicate-hook checks in the draft are owned by plans 20 and 21.
This plan is the spec. Before step 1, read that draft. Keep only what this plan's steps produce. Comment out the rest; never delete it. Do not state that the edits are the result of the draft.
