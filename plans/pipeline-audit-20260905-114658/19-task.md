# Task 19 plan — lift the difficulty >= 7 agent choice out of PLAN_THE_TASK into a decision box

Do this task after task 11 lands (task ordering requirement from the task list). Task 11 edits
only `scripts/tackle-tasks/shared/planPrompt.ts` and its test — it makes no edit to
`PLAN_THE_TASK.ts`, so there is no line-level overlap between the two tasks in that file; the
sequencing is satisfied simply by landing task 11's commit first.

## Scope confirmation

- `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts` — read in full (72 lines).
  - Lines 19-49: `function codexPlanPrompt(t: PreparedTask): string` — the whole difficulty-7+ prompt (writes `codexPromptFile`, `runScript`, `pidFile`, spawns `sh` detached, returns the "wait via polling loop" prompt via `whatToReturnSection`).
  - Line 60: `const body = Number(entry.difficulty) >= 7` — the hidden routing decision.
  - Lines 60-62:
    ```ts
    const body = Number(entry.difficulty) >= 7
        ? codexPlanPrompt(prepared)
        : `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`;
    ```
  - Line 66: `return { box: "PLAN_THE_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };` — `main()` always reports box `"PLAN_THE_TASK"` regardless of which branch ran; this is the script split, not only a diagram edit, that the task description calls out.
  - Lines 53-59 (the shared prefix of `main()`): `packet`, `prepared`, the `entry` lookup (`readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find(...)`, throwing if not found), `promptFile`, `mkdirSync`.
  - Imports used **only** inside `codexPlanPrompt` or **only** for the difficulty lookup, confirmed by reading every use in the file: `spawn` (line 2, used only at line 35), `rmSync` (line 3, used only at line 33), `type PreparedTask` (line 9, used only as `codexPlanPrompt`'s parameter type at line 20), `whatToReturnSection` (line 12, used only at line 47), `readTaskFile, resolveTaskFiles` (line 7, used only at line 56 for the `entry` lookup).
  - `spawnAgentHeader` (line 11) is imported but not called anywhere in the current file body — a pre-existing unused import from before this task; leave it untouched (per this repo's standing rule against fixing unrelated unused-import warnings).
  - `export const resetScope: ResetScope = { counters: true, generatedFiles: true };` (line 51) — both branches of the pre-split file write a generated file under `plans/` (the claude branch writes `PLAN_THE_TASK.prompt.md`; the codex branch additionally writes `PLAN_THE_TASK.codex-run.sh`, `.codex-pid`, `.codex-done`, `.codex-prompt.md`), so both post-split scripts keep this export unchanged.
- `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.template.json` — read in full. Its `input` is an `EntryPacket`-shaped sample (`box`, `scriptSignal`, `taskNumber`, `runId`, `projectRoot`, `worktree`, `branch`, `planFile`, `exitType`, `exitNote`) with no `difficulty` field inside the packet itself (difficulty lives in the sibling `tasks.json` fixture, not the packet) — this shape is unaffected by the split and needs **no edit**.
- `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.test.ts` — read in full (104 lines).
  - `test_PLAN_THE_TASK_returnsAPromptNamingTheTaskWithNoContinuationInstructions` (lines 28-45) — exercises the claude/default path (`makeFixture()`, no difficulty argument). Stays in this file, unedited: `PLAN_THE_TASK.ts`'s post-split behavior for this path is unchanged.
  - `test_PLAN_THE_TASK_startsCodexDetachedToDraftThePlanWhenDifficultyIsAtLeast7` (lines 47-86) — exercises the codex path (`makeFixture(35, 7)`). Moves to the new `PLAN_THE_TASK_CODEX.test.ts` (Step 4 below).
  - `test_PLAN_THE_TASK_runsTwiceWithTheSameInput` (lines 88-103) — exercises the claude/default path's idempotency. Stays, unedited.
  - `makeFixture(taskNumber = 35, difficulty?: number)` (lines 15-26) — writes `.taskTools/tasks.json` with a `difficulty` field. This fixture helper stays in `PLAN_THE_TASK.test.ts` (still used by the two surviving tests, which pass no `difficulty` and get `undefined`, matching today) and is duplicated (not imported cross-file) into the new `PLAN_THE_TASK_CODEX.test.ts`, matching this codebase's existing convention of each block's test file owning its own fixture helper (confirmed: no block test file in `scripts/tackle-tasks/*/` imports a fixture helper from a sibling test file).
- `scripts/tackle-tasks/whatDidThePlannerReturn/WHAT_DID_THE_PLANNER_RETURN.ts` — read in full. Confirmed by the task description and by reading the file: it never reads `packet.box`, only `additionalData.outcome`. No edit needed here — the new `IS_DIFFICULTY_7_PLUS_Q` box's `next` targets (`PLAN_THE_TASK_CODEX` or `PLAN_THE_TASK`) both end at this same next box regardless of which ran, since both post-split scripts return the same `{ box, scriptSignal: "prompt", prompt }` shape the run-step hook already expects from a `returns_a_prompt` block, and the agent's answer (`{message, additionalData: {outcome, planFile, clarifyRequest}}`) is unaffected by which of the two prompts asked for it.
- `scripts/tackle-tasks/shared/CodexReviewBodyEmitter.ts:12-16` — read in full:
  ```ts
  // Same difficulty>=7 rule PLAN_THE_TASK.ts uses to route to codex drafting; no field records this separately.
  const isCodexDraftedPlan = (t: PreparedTask): boolean => {
      const entry = readTaskFile(resolveTaskFiles(t.taskStateRoot).tasksPath).find((task) => task.taskNumber === t.number);
      return entry !== undefined && Number(entry.difficulty) >= 7;
  };
  ```
  Confirmed only used at line 68-71 to pick wording for the review prompt's role sentence — it never changes which reviewer runs. Per the task description, **leave this file exactly as is**: it independently re-derives the same `>= 7` rule for a wording choice only, and duplicating the rule here is accepted, not a bug this task fixes.
- `scripts/templateShape.ts:18` — read in full (`getTemplateShapeMismatches`, structural key/kind comparison only). Confirmed it does not special-case a `box` field, and `WHAT_DID_THE_PLANNER_RETURN.ts` never reads `packet.box` (confirmed above) — so nothing enforces that the packet's `box` field names the box that actually ran, and this task makes no change here, per the task description.
- `diagrams/tackle-tasks/pipeline-planTheTask.mmd` — read in full (23 lines). Today: one script-colored... no — `PLAN_THE_TASK["PLAN_THE_TASK"]` is the only real box, classed `returns_a_prompt` (line 21), with a dashed `next_diagram` box `WHAT_DID_THE_PLANNER_RETURN` (line 22) and one edge, `PLAN_THE_TASK --> WHAT_DID_THE_PLANNER_RETURN` (line 14).
- Every live cross-diagram entry point into this diagram, confirmed via `grep -rn "PLAN_THE_TASK" diagrams/tackle-tasks/*.mmd` (excluding `_pipeline-monolith.mmd`, which is excluded from generation per task 5's scope confirmation, and excluding `pipeline-planTheTask.mmd` itself):
  - `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` — read in full (58 lines). Line 23: `PLAN_THE_TASK["PLAN_THE_TASK"]` (dashed `next_diagram` box declaration). Line 49: `DOCUMENT_GENERATION --> PLAN_THE_TASK` (the only edge into it). Line 57: `class PLAN_THE_TASK,REPORT_ONLY_EXIT,FAILURES_EXIT next_diagram`.
  - `diagrams/tackle-tasks/pipeline-whatIsReviewVerdict.mmd` — read in full (32 lines). Line 12: `PLAN_THE_TASK["PLAN_THE_TASK"]`. Line 21: `TWO_CODEX_REVIEWS_COMPLETED_Q -- "NO<br/>replan with codex's notes" --> PLAN_THE_TASK` (the only edge into it). Line 31: `class PLAN_THE_TASK,FAILURES_EXIT,IMPLEMENT_TASK next_diagram`.
  - This matters because of how `scripts/generateSteps.ts` resolves cross-diagram arrows: `remapNextAcrossDiagrams` (lines 247-259) and `getDiagramWhereBoxHasArrows` (lines 234-244) qualify a dashed box's edge by finding **whichever diagram draws outgoing arrows from that exact box name** — they do not care which box is "first" or an "entry point" in the target diagram. If these two callers keep pointing at the bare name `PLAN_THE_TASK` while `PLAN_THE_TASK` remains a real (non-decision) box inside `pipeline-planTheTask.mmd`, both callers would walk **straight past** the new difficulty check into the claude-only path — the decision box would only ever run for callers nobody currently has. Both cross-diagram declarations and both arrows must be renamed to the new entry box, `IS_DIFFICULTY_7_PLUS_Q`, or the decision this task adds is dead on arrival for these two real callers. This renaming is required correctness for "lift the routing decision into a decision box," not scope creep beyond the task description.
  - `pipeline-preambleStatusCheck.mmd`'s caller, `DOCUMENT_GENERATION.ts` — read in full. It returns no explicit `next` at all (its own comment: `"write the task brief". One successor, so no next.`), relying on `runStepHook.ts`'s `onlySuccessor` fallback (`step.next.length === 1 ? step.next[0] : undefined`). Since its config `next` array has exactly one entry, regenerating the diagram edge alone (3b) is sufficient here — no script edit needed for this caller.
  - `pipeline-whatIsReviewVerdict.mmd`'s caller, `scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.ts` — read in full. Unlike `DOCUMENT_GENERATION.ts`, this is a decision script: it returns the literal string `"pipeline-planTheTask.mmd::PLAN_THE_TASK"` itself (confirmed via `grep -n "PLAN_THE_TASK" scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.ts`, two hits), independent of whatever the diagram's edges say. `runStepHook.ts:377` — `if (!step.next.includes(String(chosenNextBox))) return buildFailure(...)` — validates that literal against the box's config `next` array. Renaming only the diagram edge (3c) leaves this script returning a literal that regeneration will remove from `TWO_CODEX_REVIEWS_COMPLETED_Q`'s config `next` array, so every replan would fail this check at runtime. Its test (`TWO_CODEX_REVIEWS_COMPLETED_Q.test.ts`) and template (`TWO_CODEX_REVIEWS_COMPLETED_Q.template.json`) both also pin the same old literal. All three need editing — Step 3d below.
- `scripts/generateSteps.ts:11-53` — read in full. `BLOCKS_BY_OWNER_FOLDER.planTheTask` (line 19) is currently `["PLAN_THE_TASK"]`. `getOwnerFolder` (line 321) falls back to `getDefaultOwnerFolder` (lines 301-309) only for a box **not** listed in this map; `getDefaultOwnerFolder` returns `basename(diagramFile, ".mmd")` — for `pipeline-planTheTask.mmd` that is the literal string `"pipeline-planTheTask"`, not `"planTheTask"`. If the two new box names are not added to `BLOCKS_BY_OWNER_FOLDER.planTheTask`, `npm run steps` would file their stub script/template under a **new** `scripts/tackle-tasks/pipeline-planTheTask/` folder instead of the existing `scripts/tackle-tasks/planTheTask/` folder every other `PLAN_THE_TASK*` file already lives in — this must be fixed before running `npm run steps`, not after.
- `scripts/tackle-tasks/commitImplementationIfNeeded/DO_TASK_TESTS_PASS_Q.ts` and `.test.ts` — read in full; the closest live analog to the new decision box (same `Number(entry.difficulty)` comparison pattern, same `readTaskFile`/`resolveTaskFiles` lookup, same `{...packet, box, scriptSignal: SCRIPT_SIGNAL.CONTINUE}` output shape, same bare same-diagram `next` string). `WHAT_DID_THE_PLANNER_RETURN.ts` is the second close analog (same `EntryPacket`-family input, same "throw if entry undefined" guard). Both are the templates Step 1 below follows.
- `scripts/tackle-tasks/preambleStatusCheck/_packet.ts` — read in full: `EntryPacket` (`box`, `scriptSignal`, `taskNumber`, `runId`, `projectRoot`, `worktree`, `branch`, `docsMode`, `planFile`, `exitType`, `exitNote`) is exactly `PLAN_THE_TASK.ts`'s current input type and is reused, unmodified, as `IS_DIFFICULTY_7_PLUS_Q.ts`'s input type — this new box sits at the exact point in the packet lineage `PLAN_THE_TASK` sits at today.
- `scripts/steps.json` — confirmed current entries for `pipeline-planTheTask.mmd` (one entry, `PLAN_THE_TASK`, `producesPrompt: true`, `next: ["pipeline-whatDidThePlannerReturn.mmd::WHAT_DID_THE_PLANNER_RETURN"]`) and for the two caller diagrams' `next` arrays (both currently include `"pipeline-planTheTask.mmd::PLAN_THE_TASK"`). This file is **not hand-edited** by this task — Step 6 regenerates it with `npm run steps` from the diagram + script + template edits in Steps 2-5, and Step 7 verifies the regenerated content is exactly what changed.
- `package.json:4`: `"steps": "node --no-inspect scripts/generateSteps.ts && node --no-inspect scripts/generateWorkflow.ts"` — confirms `npm run steps` regenerates both `scripts/steps.json` and, via `generateWorkflow.ts`, `skills/tackle-tasks/tackle-tasks.workflow.js`.

## Steps

Edit order matters: the diagram and `generateSteps.ts` owner-folder edits (Steps 2-3) must land **before** `npm run steps` runs (Step 6), and the new scripts (Step 1) must exist on disk **before** `npm run steps` runs, so that `generateSteps()`'s `!existsSync(scriptPath)` / `!existsSync(templatePath)` guards (`generateSteps.ts:341,347`) skip stubbing and pick up the hand-authored files instead.

### Step 1 — write the new decision box, test-first

`test_main_choosesPlanTheTaskCodexWhenDifficultyIsAtLeast7` / `test_main_choosesPlanTheTaskWhenDifficultyIsBelow7` / `test_main_throwsWhenTaskIsNotInTasksJson`

- Plain-English behavior: given a task whose `tasks.json` entry has `difficulty >= 7`, the walk continues at `PLAN_THE_TASK_CODEX`; below 7, it continues at `PLAN_THE_TASK`; if the task is missing from `tasks.json` entirely, the box throws instead of guessing.
- Steps (as comments in the test body, mirroring `DO_TASK_TESTS_PASS_Q.test.ts`):
  - build a fresh temp project root with a `.taskTools/tasks.json` holding one task at a given difficulty.
  - build the same `EntryPacket`-shaped input `PLAN_THE_TASK.ts` receives today.
  - run `main()` and assert the returned packet is the input packet plus `box: "IS_DIFFICULTY_7_PLUS_Q"` and the expected `next`.
  - a task number absent from `tasks.json` throws, naming the task number.
- Failing assertion first (RED): the file `scripts/tackle-tasks/planTheTask/IS_DIFFICULTY_7_PLUS_Q.ts` does not exist yet, so the import fails.
- Minimum code (GREEN) — create `scripts/tackle-tasks/planTheTask/IS_DIFFICULTY_7_PLUS_Q.test.ts`:

```ts
// Behavioral checks for IS_DIFFICULTY_7_PLUS_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_DIFFICULTY_7_PLUS_Q.ts";

function makeProjectRoot(taskNumber: number, difficulty: number): string {
    const root = mkdtempSync(join(tmpdir(), "is-difficulty-7-plus-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber, difficulty }]));
    return root;
}

function packet(projectRoot: string, taskNumber: number) {
    return {
        box: "DOCUMENT_GENERATION", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot,
        worktree: "/abs/worktree", branch: `task-${taskNumber}`, docsMode: "AUTOGEN", planFile: "", exitType: "", exitNote: "",
    };
}

test("test_main_choosesPlanTheTaskCodexWhenDifficultyIsAtLeast7", () => {
    // Setup: tasks.json records difficulty 7 for the task.
    const root = makeProjectRoot(1, 7);
    const input = packet(root, 1);
    // Verification: the walk lands on PLAN_THE_TASK_CODEX.
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "IS_DIFFICULTY_7_PLUS_Q", next: "PLAN_THE_TASK_CODEX" });
});

test("test_main_choosesPlanTheTaskWhenDifficultyIsBelow7", () => {
    // Setup: tasks.json records difficulty 6 for the task.
    const root = makeProjectRoot(2, 6);
    const input = packet(root, 2);
    // Verification: the walk lands on the claude-authored PLAN_THE_TASK block.
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "IS_DIFFICULTY_7_PLUS_Q", next: "PLAN_THE_TASK" });
});

test("test_main_throwsWhenTaskIsNotInTasksJson", () => {
    const root = mkdtempSync(join(tmpdir(), "is-difficulty-7-plus-missing-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools/tasks.json"), "[]");
    const input = packet(root, 9);
    assert.throws(() => main(JSON.stringify(input)), /task 9 not found in tasks\.json/);
});
```

Create `scripts/tackle-tasks/planTheTask/IS_DIFFICULTY_7_PLUS_Q.ts`:

```ts
// IS_DIFFICULTY_7_PLUS_Q, from pipeline-planTheTask.mmd. Decision: does this task's difficulty route the plan to codex?
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const packet = JSON.parse(input) as EntryPacket;
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const output = { ...packet, box: "IS_DIFFICULTY_7_PLUS_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (Number(entry.difficulty) >= 7) {
        return { ...output, next: "PLAN_THE_TASK_CODEX" };
    }
    return { ...output, next: "PLAN_THE_TASK" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```

Create `scripts/tackle-tasks/planTheTask/IS_DIFFICULTY_7_PLUS_Q.template.json`:

```json
{
    "input": {
        "box": "DOCUMENT_GENERATION",
        "scriptSignal": "continue",
        "taskNumber": 35,
        "runId": "run-1",
        "projectRoot": "{{PROJECT_ROOT}}/scripts/tackle-tasks/planTheTask/fixtures",
        "worktree": "{{PROJECT_ROOT}}/scripts/tackle-tasks/planTheTask/fixtures/worktree",
        "branch": "task-35",
        "planFile": "",
        "exitType": "",
        "exitNote": ""
    },
    "output": {
        "box": "IS_DIFFICULTY_7_PLUS_Q",
        "scriptSignal": "continue",
        "taskNumber": 35,
        "runId": "run-1",
        "projectRoot": "{{PROJECT_ROOT}}/scripts/tackle-tasks/planTheTask/fixtures",
        "worktree": "{{PROJECT_ROOT}}/scripts/tackle-tasks/planTheTask/fixtures/worktree",
        "branch": "task-35",
        "planFile": "",
        "exitType": "",
        "exitNote": "",
        "next": "PLAN_THE_TASK"
    }
}
```

### Step 2 — edit `scripts/generateSteps.ts`'s owner-folder map

`BLOCKS_BY_OWNER_FOLDER.planTheTask`, line 19:

Old:
```ts
    planTheTask: ["PLAN_THE_TASK"],
```
New:
```ts
    planTheTask: ["IS_DIFFICULTY_7_PLUS_Q", "PLAN_THE_TASK", "PLAN_THE_TASK_CODEX"],
```

No test for this line: it is exercised indirectly by Step 6's `npm run steps` run landing every new file in `scripts/tackle-tasks/planTheTask/` (verified in Step 7) instead of a new `scripts/tackle-tasks/pipeline-planTheTask/` folder.

### Step 3 — edit the three diagrams

#### 3a. `diagrams/tackle-tasks/pipeline-planTheTask.mmd` — full replacement

Old (entire file, 23 lines):
```
flowchart TB
%% One orange block. The hook walks in from a dashed PLAN_THE_TASK block, prints the prompt, and stops.

  subgraph planTheTask ["Input: the task brief"]
    direction TB
    PLAN_THE_TASK["PLAN_THE_TASK"]
  end
  subgraph planTheTaskNext ["next diagram"]
    direction TB
    WHAT_DID_THE_PLANNER_RETURN["PLANNER_RESULT"]
  end
  planTheTask ~~~ planTheTaskNext

  PLAN_THE_TASK --> WHAT_DID_THE_PLANNER_RETURN

  classDef script fill:#2f7d46,stroke:#1e5c31,color:#ffffff
  classDef returns_a_prompt fill:#e07b39,stroke:#a8541f,color:#1a1a1a
  classDef fail fill:red,stroke:#254a70,color:#ffffff
  classDef output fill:#3b6ea5,stroke:#254a70,color:#ffffff
  classDef next_diagram fill:#ffffff,stroke:#3b6ea5,stroke-width:2px,stroke-dasharray:6 4,color:#1a1a1a
  class PLAN_THE_TASK returns_a_prompt
  class WHAT_DID_THE_PLANNER_RETURN next_diagram
```
New (entire file):
```
flowchart TB
%% One script box, then one orange block per branch. The hook walks in from a dashed IS_DIFFICULTY_7_PLUS_Q block, prints the prompt, and stops.

  subgraph planTheTask ["Input: the task brief"]
    direction TB
    IS_DIFFICULTY_7_PLUS_Q["is the task's difficulty 7 or more?"]
    PLAN_THE_TASK_CODEX["PLAN_THE_TASK_CODEX"]
    PLAN_THE_TASK["PLAN_THE_TASK"]
  end
  subgraph planTheTaskNext ["next diagram"]
    direction TB
    WHAT_DID_THE_PLANNER_RETURN["PLANNER_RESULT"]
  end
  planTheTask ~~~ planTheTaskNext

  IS_DIFFICULTY_7_PLUS_Q -- "YES" --> PLAN_THE_TASK_CODEX
  IS_DIFFICULTY_7_PLUS_Q -- "NO" --> PLAN_THE_TASK
  PLAN_THE_TASK_CODEX --> WHAT_DID_THE_PLANNER_RETURN
  PLAN_THE_TASK --> WHAT_DID_THE_PLANNER_RETURN

  classDef script fill:#2f7d46,stroke:#1e5c31,color:#ffffff
  classDef returns_a_prompt fill:#e07b39,stroke:#a8541f,color:#1a1a1a
  classDef fail fill:red,stroke:#254a70,color:#ffffff
  classDef output fill:#3b6ea5,stroke:#254a70,color:#ffffff
  classDef next_diagram fill:#ffffff,stroke:#3b6ea5,stroke-width:2px,stroke-dasharray:6 4,color:#1a1a1a
  class IS_DIFFICULTY_7_PLUS_Q script
  class PLAN_THE_TASK,PLAN_THE_TASK_CODEX returns_a_prompt
  class WHAT_DID_THE_PLANNER_RETURN next_diagram
```

#### 3b. `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` — rename the dashed entry box

Line 23, old:
```
    PLAN_THE_TASK["PLAN_THE_TASK"]
```
New:
```
    IS_DIFFICULTY_7_PLUS_Q["IS_DIFFICULTY_7_PLUS_Q"]
```

Line 49, old:
```
  DOCUMENT_GENERATION --> PLAN_THE_TASK
```
New:
```
  DOCUMENT_GENERATION --> IS_DIFFICULTY_7_PLUS_Q
```

Line 57, old:
```
  class PLAN_THE_TASK,REPORT_ONLY_EXIT,FAILURES_EXIT next_diagram
```
New:
```
  class IS_DIFFICULTY_7_PLUS_Q,REPORT_ONLY_EXIT,FAILURES_EXIT next_diagram
```

#### 3c. `diagrams/tackle-tasks/pipeline-whatIsReviewVerdict.mmd` — rename the dashed entry box

Line 12, old:
```
    PLAN_THE_TASK["PLAN_THE_TASK"]
```
New:
```
    IS_DIFFICULTY_7_PLUS_Q["IS_DIFFICULTY_7_PLUS_Q"]
```

Line 21, old:
```
  TWO_CODEX_REVIEWS_COMPLETED_Q -- "NO<br/>replan with codex's notes" --> PLAN_THE_TASK
```
New:
```
  TWO_CODEX_REVIEWS_COMPLETED_Q -- "NO<br/>replan with codex's notes" --> IS_DIFFICULTY_7_PLUS_Q
```

Line 31, old:
```
  class PLAN_THE_TASK,FAILURES_EXIT,IMPLEMENT_TASK next_diagram
```
New:
```
  class IS_DIFFICULTY_7_PLUS_Q,FAILURES_EXIT,IMPLEMENT_TASK next_diagram
```

#### 3d. `scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.ts` — fix the two hardcoded replan literals

This box's diagram edge (3c above) is not what decides its runtime `next` value: `TWO_CODEX_REVIEWS_COMPLETED_Q.ts` is a decision script that returns a literal `next` string itself, exactly like `IS_DIFFICULTY_7_PLUS_Q.ts` (Step 1). Confirmed live: the file returns the literal `"pipeline-planTheTask.mmd::PLAN_THE_TASK"` twice — once for "reviews not yet done" (its final `return`), once for "relaunch after a scrap" (inside the `reviewsDone` branch). `runStepHook.ts:377` — `if (!step.next.includes(String(chosenNextBox))) return buildFailure(...)` — validates a script's returned `next` against the box's config `next` array. After 3c renames the diagram edge, `scripts/steps.json`'s `TWO_CODEX_REVIEWS_COMPLETED_Q` entry's `next` array will contain `"pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q"`, not `"...::PLAN_THE_TASK"` — leaving the two hardcoded literals unchanged would make `runStepHook` reject every replan as an invalid `next` the moment `npm run steps` regenerates the config.

Old (both occurrences, confirmed via `grep -n "PLAN_THE_TASK" scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.ts`):
```ts
            return { ...output, next: "pipeline-planTheTask.mmd::PLAN_THE_TASK" };
```
(appears once inside the `if (checkpoint.resumedFrom?.exitType === "plan-scrapped")` branch, once as the function's final `return`)

New (both occurrences):
```ts
            return { ...output, next: "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q" };
```

Edit `scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.test.ts`: its three assertions naming the old literal —
```ts
    assert.equal(output.next, "pipeline-planTheTask.mmd::PLAN_THE_TASK");
```
(lines matching `test_main_replansWhenTheCounterHasNeverBeenRaised`, `test_main_replansWhenOnlyOneReviewHasHappened`, `test_main_replansOnceMoreOnTheRelaunchAfterAScrap`) — each becomes:
```ts
    assert.equal(output.next, "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q");
```

Edit `scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.template.json`: its `output.next` field —
```json
        "next": "pipeline-planTheTask.mmd::PLAN_THE_TASK"
```
becomes:
```json
        "next": "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q"
```

Add one more test to `TWO_CODEX_REVIEWS_COMPLETED_Q.test.ts`, proving this literal stays valid against the real regenerated config instead of only against itself:

`test_main_replansToABoxThatIsStillAValidSuccessorInTheCommittedConfig`
- Plain-English behavior: the literal `next` value this script returns for a replan is one of the config's declared successors for this exact box, so `runStepHook`'s `step.next.includes(...)` check never rejects it.
- Steps: read the committed `scripts/steps.json`, find this box's entry under `pipeline-whatIsReviewVerdict.mmd`, assert its `next` array includes the same literal `main()` returns for a replan.
- Failing assertion first (RED): before Step 6 regenerates `scripts/steps.json`, the committed file still lists the old `PLAN_THE_TASK` successor, so this test fails until Step 6 runs.
- Minimum code (GREEN) — append to the test file:

```ts
test("test_main_replansToABoxThatIsStillAValidSuccessorInTheCommittedConfig", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const config = JSON.parse(readFileSync(join(repoRoot, "scripts/steps.json"), "utf8"));
    const entry = config["pipeline-whatIsReviewVerdict.mmd"].find((e: { box: string }) => e.box === "TWO_CODEX_REVIEWS_COMPLETED_Q");
    assert.ok(entry.next.includes("pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q"));
});
```

The file's current imports (confirmed live) are:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./TWO_CODEX_REVIEWS_COMPLETED_Q.ts";
import { claimTask, raiseAttemptCount } from "../shared/taskRunState.ts";
import { writeCheckpoint } from "../shared/checkpoint.ts";
```
Change them to:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./TWO_CODEX_REVIEWS_COMPLETED_Q.ts";
import { claimTask, raiseAttemptCount } from "../shared/taskRunState.ts";
import { writeCheckpoint } from "../shared/checkpoint.ts";
```
(`readFileSync` joins the existing `node:fs` import, `dirname` joins the existing `node:path` import, and one new `node:url` import line is added — no import is duplicated.)

### Step 4 — split `PLAN_THE_TASK.ts`, test-first

`test_PLAN_THE_TASK_startsCodexDetachedToDraftThePlanWhenDifficultyIsAtLeast7` moves to a new file and a new import; its body and assertions do not change.

- Failing assertion first (RED): create `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK_CODEX.test.ts` importing `main` from `./PLAN_THE_TASK_CODEX.ts`, which does not exist yet.
- Minimum code (GREEN):

Create `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK_CODEX.test.ts` with exactly the body of `PLAN_THE_TASK.test.ts`'s `makeFixture` helper (lines 15-26) and the one moved test (lines 47-86), renaming only the import:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./PLAN_THE_TASK_CODEX.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "plan-the-task-codex-run-log.json");

const HERE = dirname(fileURLToPath(import.meta.url));

// Sets up a project root and worktree with a brief file, since loadPreparedTask is read-only and never creates one.
function makeFixture(taskNumber = 35): { projectRoot: string; worktree: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "plan-the-task-codex-"));
    mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(projectRoot, ".taskTools/tasks.json"), JSON.stringify([
        { taskNumber, files: ["src/thing.ts"], tests: "node --test tests/thing.test.ts", codexReviewNotes: "" },
    ]));
    writeFileSync(join(projectRoot, ".taskTools/completedTasks.json"), "[]");
    const worktree = join(projectRoot, "worktree");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), `# fixture sentinel brief for task ${taskNumber}\n`);
    return { projectRoot, worktree };
}

test("test_PLAN_THE_TASK_CODEX_startsCodexDetachedToDraftThePlan", async () => {
    const { projectRoot, worktree } = makeFixture(35);
    // A fake codex on PATH records its call, so the test proves the detached start without running the real one.
    const shimDir = join(projectRoot, "shim");
    mkdirSync(shimDir);
    const codexCallFile = join(projectRoot, "codex-call.txt");
    writeFileSync(join(shimDir, "codex"), `#!/bin/sh\nprintf '%s\\n' "$@" >${codexCallFile}\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    const packet = JSON.stringify({
        box: "IS_DIFFICULTY_7_PLUS_Q", scriptSignal: "continue", taskNumber: 35, runId: "run-1",
        projectRoot, worktree, branch: "task-35", docsMode: "AUTOGEN", planFile: "", exitType: "", exitNote: "",
    });

    try { main(packet); } finally { process.env.PATH = savedPath; }

    // Codex outruns the block's 5-minute cap: the block starts it detached, the prompt only waits for the done marker.
    const promptFile = join(worktree, "plans", "PLAN_THE_TASK.prompt.md");
    const runScript = join(worktree, "plans", "PLAN_THE_TASK.codex-run.sh");
    const doneFile = join(worktree, "plans", "PLAN_THE_TASK.codex-done");
    const pidFile = join(worktree, "plans", "PLAN_THE_TASK.codex-pid");
    const promptFileContents = readFileSync(promptFile, "utf8");
    assert.match(promptFileContents, /You are waiting on a plan agent running in the CLI\./);
    assert.doesNotMatch(promptFileContents, /nohup|setsid|run_in_background: true/);
    assert.ok(promptFileContents.includes(`[ -f ${doneFile} ]`));
    assert.doesNotMatch(promptFileContents, /codex exec/);
    assert.match(readFileSync(pidFile, "utf8"), /^\d+$/);
    const runScriptContents = readFileSync(runScript, "utf8");
    assert.match(runScriptContents, /codex exec -s workspace-write -m gpt-5\.6-terra -c 'model_reasoning_effort="high"'/);
    assert.ok(runScriptContents.includes(`echo $? >${doneFile}`));
    // macOS sh chokes on a heredoc inside $(...) holding an apostrophe, so the prompt is a file.
    const codexPromptFile = join(worktree, "plans", "PLAN_THE_TASK.codex-prompt.md");
    assert.ok(runScriptContents.includes(`"$(cat ${codexPromptFile})"`));
    assert.doesNotMatch(runScriptContents, /PLANEOF/);
    assert.match(readFileSync(codexPromptFile, "utf8"), /task 35/);
    execFileSync("sh", ["-n", runScript]);
    for (let i = 0; i < 50 && !existsSync(doneFile); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(readFileSync(doneFile, "utf8").trim(), "0");
    assert.match(readFileSync(codexCallFile, "utf8"), /task 35/);
});
```

(`taskNumber` no longer needs to carry a `difficulty` field in this fixture, since `PLAN_THE_TASK_CODEX.ts` never reads it — the difficulty check now lives entirely in `IS_DIFFICULTY_7_PLUS_Q.ts`, exercised separately by Step 1's tests.)

Create `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK_CODEX.ts` by moving `codexPlanPrompt` verbatim out of `PLAN_THE_TASK.ts` and giving it its own `main()`:

```ts
// PLAN_THE_TASK_CODEX, from pipeline-planTheTask.mmd returns_a_prompt. Difficulty 7+: codex drafts the plan, taking longer than the block's 5-minute cap, so it starts detached and waits.
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL, type ResetScope } from "../../contracts.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";
import type { PreparedTask } from "../shared/preparedTask.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

function codexPlanPrompt(t: PreparedTask): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const answerFile = `${root}/plans/PLAN_THE_TASK.codex-answer.md`;
    const doneFile = `${root}/plans/PLAN_THE_TASK.codex-done`;
    const runScript = `${root}/plans/PLAN_THE_TASK.codex-run.sh`;
    const pidFile = `${root}/plans/PLAN_THE_TASK.codex-pid`;
    const codexPromptFile = `${root}/plans/PLAN_THE_TASK.codex-prompt.md`;
    // macOS sh chokes on a heredoc inside $(...) holding an apostrophe, so the prompt is a file.
    writeFileSync(codexPromptFile, planPrompt(t));
    writeFileSync(runScript, `#!/bin/sh
cd ${root} && codex exec -s workspace-write -m gpt-5.6-terra -c 'model_reasoning_effort="high"' "$(cat ${codexPromptFile})" </dev/null >${answerFile} 2>&1
echo $? >${doneFile}
`);
    rmSync(doneFile, { force: true });
    // detached + unref: codex outlives this block; stdio ignore so the hook's spawnSync is not held open.
    const codex = spawn("sh", [runScript], { detached: true, stdio: "ignore" });
    codex.unref();
    writeFileSync(pidFile, String(codex.pid));
    return `You are waiting on a plan agent running in the CLI.
You do not edit any files. Codex is already running detached (pid ${codex.pid}). Your job is to wait for it to finish, then report.

## STEP 1 — wait. Run this exact command in the foreground with timeout: 600000. It checks every 20 seconds until codex's planning run is complete or its process is gone, then prints DONE or CODEX DIED. If the call times out before it prints either, run it again, verbatim, until it does. Never use run_in_background or Monitor: a background notification never reaches you.

\`\`\`sh
until [ -f ${doneFile} ] || ! kill -0 $(cat ${pidFile}) 2>/dev/null; do sleep 20; done; [ -f ${doneFile} ] && echo DONE || echo CODEX DIED
\`\`\`

${whatToReturnSection(`{ "outcome": "<PLAN if ${t.planFile} now exists, else CLARIFY>", "planFile": "${t.planFile}", "clarifyRequest": "<empty when outcome is PLAN; otherwise the question from ${answerFile}>" }`, `checking whether ${t.planFile} exists and reading ${answerFile} for the clarify question`, "")}
`;
}

export const resetScope: ResetScope = { counters: true, generatedFiles: true };

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/PLAN_THE_TASK.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    const body = codexPlanPrompt(prepared);
    writeFileSync(promptFile, body);
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "PLAN_THE_TASK_CODEX", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```

Note: `codexPlanPrompt` still calls `planPrompt(t)` at the line writing `codexPromptFile` — add the import `import { planPrompt } from "../shared/planPrompt.ts";` to this new file (it was already imported in the old `PLAN_THE_TASK.ts`; carry it over here since only this file's branch calls `planPrompt` for the codex prompt file's content, matching the pre-split behavior exactly).

Create `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK_CODEX.template.json` — same shape as `PLAN_THE_TASK.template.json` (its `input` needs no `difficulty` field, matching the packet type):

```json
{
    "input": {
        "box": "IS_DIFFICULTY_7_PLUS_Q",
        "scriptSignal": "continue",
        "taskNumber": 35,
        "runId": "run-1",
        "projectRoot": "{{PROJECT_ROOT}}/scripts/tackle-tasks/planTheTask/fixtures",
        "worktree": "{{PROJECT_ROOT}}/scripts/tackle-tasks/planTheTask/fixtures/worktree",
        "branch": "task-35",
        "planFile": "",
        "exitType": "",
        "exitNote": ""
    },
    "agentAnswer": {
        "message": "",
        "additionalData": {
            "outcome": "PLAN",
            "planFile": "",
            "clarifyRequest": ""
        }
    }
}
```

### Step 5 — simplify `PLAN_THE_TASK.ts` to the claude-only path

Edit `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts` in full:

Old (entire file, 72 lines, after task 5's line-1 comment fix already applied):
```ts
// PLAN_THE_TASK, from _pipeline-monolith.mmd returns_a_prompt. Same body as pipeline-planTheTask's; only the input shape changed.
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL, type ResetScope } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";
import type { PreparedTask } from "../shared/preparedTask.ts";
import { planPrompt } from "../shared/planPrompt.ts";
import { spawnAgentHeader } from "../shared/spawnAgentCli.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

// Beside the run-log, so `tail -f` on it shows the spawned agent working. The hook sets RUN_STEP_LOG for every block.
// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

// Difficulty 7+: codex drafts the plan, taking longer than the block's 5-minute cap, so it starts detached and waits.
function codexPlanPrompt(t: PreparedTask): string {
    ... (49 lines, as read above)
}

export const resetScope: ResetScope = { counters: true, generatedFiles: true };

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/PLAN_THE_TASK.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    const body = Number(entry.difficulty) >= 7
        ? codexPlanPrompt(prepared)
        : `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`;
    writeFileSync(promptFile, body);
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "PLAN_THE_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```

New (entire file):
```ts
// PLAN_THE_TASK, from _pipeline-monolith.mmd returns_a_prompt. Same body as pipeline-planTheTask's; only the input shape changed.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL, type ResetScope } from "../../contracts.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";
import { planPrompt } from "../shared/planPrompt.ts";
import { spawnAgentHeader } from "../shared/spawnAgentCli.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

// Beside the run-log, so `tail -f` on it shows the spawned agent working. The hook sets RUN_STEP_LOG for every block.
// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

// Retired (task 19): the difficulty-7+ codex path moved to ./PLAN_THE_TASK_CODEX.ts; IS_DIFFICULTY_7_PLUS_Q.ts now decides which of the two runs.

export const resetScope: ResetScope = { counters: true, generatedFiles: true };

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/PLAN_THE_TASK.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    const body = `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`;
    writeFileSync(promptFile, body);
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "PLAN_THE_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
```

(`spawnAgentHeader` stays imported-but-unused, matching the pre-existing state confirmed in Scope confirmation — this task does not touch that line.)

Edit `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.test.ts`: delete lines 47-86 (the moved `test_PLAN_THE_TASK_startsCodexDetachedToDraftThePlanWhenDifficultyIsAtLeast7` test, now living verbatim-adapted in `PLAN_THE_TASK_CODEX.test.ts` from Step 4) — this is code motion to a new file, not retirement of functionality, so delete rather than comment out, matching how Step 4 created the new file with this same content. No other line of this file changes.

### Step 6 — regenerate `scripts/steps.json` and the workflow

```sh
cd /Users/matkatmusicllc/Programming/taskTools-86
npm run steps
```

This runs `scripts/generateSteps.ts` (picking up Steps 1-3's new box names, new script/template files, and owner-folder map) followed by `scripts/generateWorkflow.ts`, rewriting `scripts/steps.json` and `skills/tackle-tasks/tackle-tasks.workflow.js`.

### Step 7 — verify the regeneration landed where expected

```sh
git status --short scripts/tackle-tasks/planTheTask/ scripts/steps.json skills/tackle-tasks/tackle-tasks.workflow.js
```
Expected: no new `scripts/tackle-tasks/pipeline-planTheTask/` folder anywhere in the diff (confirms Step 2's owner-folder edit took effect); `scripts/steps.json` and `tackle-tasks.workflow.js` both show as modified.

```sh
python3 -c "
import json
d = json.load(open('scripts/steps.json'))
print(json.dumps(d['pipeline-planTheTask.mmd'], indent=2))
"
```
Expected: three entries — `IS_DIFFICULTY_7_PLUS_Q` (`producesPrompt: false`, `next` containing both `PLAN_THE_TASK_CODEX` and `PLAN_THE_TASK`), `PLAN_THE_TASK_CODEX` (`producesPrompt: true`, `next: ["pipeline-whatDidThePlannerReturn.mmd::WHAT_DID_THE_PLANNER_RETURN"]`), `PLAN_THE_TASK` (`producesPrompt: true`, same `next`).

```sh
grep -n "IS_DIFFICULTY_7_PLUS_Q" scripts/steps.json
```
Expected: `pipeline-preambleStatusCheck.mmd`'s `DOCUMENT_GENERATION` entry's `next` and `pipeline-whatIsReviewVerdict.mmd`'s `TWO_CODEX_REVIEWS_COMPLETED_Q` entry's `next` both now read `"pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q"` instead of `"pipeline-planTheTask.mmd::PLAN_THE_TASK"`.

## Verification

```sh
cd /Users/matkatmusicllc/Programming/taskTools-86
node --test scripts/tackle-tasks/planTheTask/IS_DIFFICULTY_7_PLUS_Q.test.ts scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.test.ts scripts/tackle-tasks/planTheTask/PLAN_THE_TASK_CODEX.test.ts scripts/tackle-tasks/whatIsReviewVerdict/TWO_CODEX_REVIEWS_COMPLETED_Q.test.ts
```
Expected: every test passes — this is the task's own acceptance test ("the walk lands on the codex block at difficulty 7 and the claude block at 6") plus proof that the replan path still names a live successor.

```sh
node --test tests/generateWorkflow.test.ts tests/generateSteps.test.ts
```
Expected: `test_generateWorkflow_theCommittedWorkflowIsUpToDate`, `test_START_STEP_isAKeyInTheRepoConfig`, and (if task 5 has already landed) `test_generateSteps_theCommittedStepsJsonIsUpToDate` all pass against the regenerated files.

Full suite:
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
Expected: `all passing`.
