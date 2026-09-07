# Task 14 plan — run-step hook needs explicit timeouts and a lock-wait deadline below them

Confirmed by the official docs (https://code.claude.com/docs/en/hooks-guide#limitations): a `command` hook defaults to a 10-minute timeout; `UserPromptSubmit` lowers that default to 30 seconds. `scripts/runStepHook.ts` is registered on both event types with no `"timeout"` field of its own (`hooks/hooks.json:14-17` under `UserPromptSubmit`, `hooks/hooks.json:69-72` under `PostToolUse` matcher `"Skill"`), so it inherits whichever default applies to the firing event. Inside one hook invocation, a walk that reaches the source-repo lock wait can loop `WAIT_FOR_LOCK` (5s each) and `HAVE_15_MINUTES_PASSED_Q` for up to 15 minutes before giving up (`scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts:8`, `FIFTEEN_MINUTES_MS`) — both signal `SCRIPT_SIGNAL.CONTINUE`, so this loop stays inside `runStepHook.ts`'s own `while (true)` (`scripts/runStepHook.ts:310`) and never returns control to Claude Code until it exits. 15 minutes exceeds both the 30-second and the 10-minute default, so either firing path can be killed by Claude Code's own hook timeout while still holding (or waiting on) the source lock.

An explicit `"timeout"` field already overrides the default for a hook registered on `hooks/hooks.json`: `taskTestsHook.ts` carries `"timeout": 600` on both its own `UserPromptSubmit` (`hooks/hooks.json:22-26`) and `PostToolUse` `"Skill"` (`hooks/hooks.json:74-77`) registrations, in this same file, proving the override mechanism works regardless of event type.

## Scope confirmation

- `hooks/hooks.json`
  - Lines 14-17, today (`UserPromptSubmit`, no `timeout`):
    ```json
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts\""
          },
    ```
  - Lines 69-72, today (`PostToolUse`, matcher `"Skill"`, no `timeout`):
    ```json
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts\""
          },
    ```
  - Lines 22-26 and 74-77 (unchanged reference point): `taskTestsHook.ts`'s two registrations, each already `"timeout": 600`.

- `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts`
  - Line 8: `const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;`
  - Lines 24-32, today:
    ```ts
        const elapsedMs = Date.now() - Date.parse(parsed.lockWaitStartedAt);
        if (elapsedMs >= FIFTEEN_MINUTES_MS) {
            return {
                ...packet,
                exitType: "run-failed",
                exitNote: "the source repo lock did not come free within 15 minutes",
                next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
            };
        }
        return { ...packet, next: "WAIT_FOR_LOCK" };
    ```
  - This constant is the only cap on the lock-wait loop `runStepHook.ts:310`'s `while (true)` can spend inside a single hook invocation while `LOCK_SOURCE_REPO` keeps failing to acquire the lock.

- `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.test.ts` (read in full)
  - Lines 15-23: `test_have15MinutesPassed_waitsAgainBeforeTheCap` — elapsed 1 minute, expects `next: "WAIT_FOR_LOCK"`. Stays correct under any cap above 1 minute; no numeric edit needed.
  - Lines 25-33: `test_have15MinutesPassed_exitsRunFailedAfterTheCap` — elapsed 16 minutes, expects `next: "pipeline-failuresExit.mmd::FAILURES_EXIT"` **and** `assert.equal(result.exitNote, "the source repo lock did not come free within 15 minutes")` (line 32). The `next`/`exitType` assertions stay correct under any shorter cap, but the `exitNote` assertion is an exact string match against the current 15-minute wording — Step 1's production change to that wording breaks this test unless it is updated in the same step.

- No other caller of `FIFTEEN_MINUTES_MS` exists (`grep -n "FIFTEEN_MINUTES_MS" scripts tests` returns only the two lines above).

- `scripts/runStepHook.ts:146-155` (`runStepScript`, `spawnSync("node", nodeArguments, { ..., timeout: STEP_TIMEOUT_MS })`) and `scripts/runStepHook.ts:47` (`STEP_TIMEOUT_MS = 300_000`) — every step script this walk runs, including a slow-but-finite `RUN_TASK_TESTS`/`RUN_FULL_SUITE` block, is individually capped at 300 seconds by this same outer mechanism regardless of what it does internally. `diagrams/tackle-tasks/pipeline-commitImplementationIfNeeded.mmd:27` (`DO_TASK_TESTS_PASS_Q -- "YES<br/>difficulty 3 or less" --> LOCK_SOURCE_REPO`) and `diagrams/tackle-tasks/pipeline-areTestsFlagged.mmd:18` (`ARE_TESTS_FLAGGED -- "NO" --> LOCK_SOURCE_REPO`) confirm a run-tests/run-suite block can sit immediately before `LOCK_SOURCE_REPO` on the same walk, inside the same hook invocation — so the hook timeout this plan sets must cover that block's own worst case (up to 300s) plus the lock-wait deadline, not the lock-wait deadline alone.

- `diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd` and `diagrams/tackle-tasks/_pipeline-monolith.mmd:65,103` — the live box id/label (`HAVE_15_MINUTES_PASSED_Q` / "have 15 minutes passed?") and the monolith overview's two "wait up to 15 minutes" labels still describe the old cap; `scripts/generateSteps.ts:31` lists the box by its current name for the generated `steps.json`.

## Steps

### Step 1 — shrink the lock-wait deadline, and fix the pre-existing test its wording change breaks

`test_have15MinutesPassed_exitsRunFailedBeforeTheOldFifteenMinuteCap`, appended to `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.test.ts`:

Plain-English behavior: an elapsed lock wait of 9 minutes must already hit the new cap, even though it is well inside the old 15-minute cap. This is the RED/GREEN line: it fails against today's code (9 minutes < 15 minutes → `"WAIT_FOR_LOCK"`) and passes once the cap drops to 5 minutes (9 minutes > 5 minutes → `FAILURES_EXIT`).

```ts
test("test_have15MinutesPassed_exitsRunFailedBeforeTheOldFifteenMinuteCap", () => {
    const lockWaitStartedAt = new Date(Date.now() - 9 * 60 * 1000).toISOString();

    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    assert.equal(result.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(result.exitType, "run-failed");
});
```

In the same step, fix the pre-existing `test_have15MinutesPassed_exitsRunFailedAfterTheCap` (lines 25-33), whose exact-match `exitNote` assertion the wording change below breaks:
```ts
    assert.equal(result.exitNote, "the source repo lock did not come free within 5 minutes");
```
(replacing its current `assert.equal(result.exitNote, "the source repo lock did not come free within 15 minutes");`).

Production fix, `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts`:

```ts
// Covers only this box's own wait; Step 2 sizes the hook timeout around this plus the worst-case
// step that can precede LOCK_SOURCE_REPO in the same hook invocation, not around this value alone.
const LOCK_WAIT_DEADLINE_MS = Number(process.env.LOCK_WAIT_DEADLINE_MS ?? 5 * 60 * 1000);
```
placed where `const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;` is today (line 8), replacing that line. Comment out the old comment above it (`// Comfortably short of the operator's stuck-lock recovery script, per the diagram's rule 4.`) is retired — replace it, do not stack a second comment above the new one.

Replace the two remaining uses:
```ts
    const elapsedMs = Date.now() - Date.parse(parsed.lockWaitStartedAt);
    if (elapsedMs >= LOCK_WAIT_DEADLINE_MS) {
        return {
            ...packet,
            exitType: "run-failed",
            exitNote: "the source repo lock did not come free within 5 minutes",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
```

Export the constant so Step 2's tests can use it without duplicating the number:
```ts
export const LOCK_WAIT_DEADLINE_MS = Number(process.env.LOCK_WAIT_DEADLINE_MS ?? 5 * 60 * 1000);
```

The `LOCK_WAIT_DEADLINE_MS` env override exists purely so a test can shrink the deadline without waiting real minutes, mirroring the established `WAIT_FOR_LOCK_MS` override in the sibling file `scripts/tackle-tasks/lockSourceRepo/WAIT_FOR_LOCK.ts:8`. Step 1's own tests use the real 5-minute default with a synthetic `lockWaitStartedAt` timestamp, so they run instantly regardless of the deadline's value; Step 2's end-to-end tests are the ones that override it.

### Step 2 — set an explicit timeout on both runStepHook.ts hook registrations, sized for the whole walk, and prove it end to end with a real held lock on both event paths

The hook timeout bounds the entire `while (true)` walk (`scripts/runStepHook.ts:310`), not just time spent inside the lock-wait loop. On the two live paths that reach `LOCK_SOURCE_REPO` (`pipeline-commitImplementationIfNeeded.mmd:27`, `pipeline-areTestsFlagged.mmd:18`), a `RUN_TASK_TESTS`/`RUN_FULL_SUITE` block can run immediately before it in the same hook invocation, and that one block is itself allowed to take up to `STEP_TIMEOUT_MS` (300s, `scripts/runStepHook.ts:47`) before `runStepScript`'s own `spawnSync` kill fires. So the hook timeout must cover: one worst-case 300s step, plus `LOCK_WAIT_DEADLINE_MS` (300s after Step 1), plus a margin for `LOCK_SOURCE_REPO`/`WAS_LOCK_ACQUIRED_Q`'s own quick steps and the failure-tail write — 900 seconds (15 minutes) comfortably covers 300 + 300 = 600s with 300s of margin to spare.

`test_hookTimeouts_runStepHookHasAnExplicitTimeoutOnBothRegistrations` and `test_hookTimeouts_lockWaitDeadlineLeavesRoomForOneWorstCaseStepUnderTheHookTimeout`, in a new file `tests/hookTimeouts.test.ts` — a necessary but not sufficient check (it proves the numbers are consistent; the end-to-end tests below prove the mechanism actually reports instead of hanging):

Plain-English behavior: `hooks/hooks.json` must give `runStepHook.ts` its own timeout on both the `UserPromptSubmit` entry and the `PostToolUse` `"Skill"`-matcher entry — proving neither firing path is left on its event's ambient default. Separately, that timeout, converted to milliseconds, must be strictly greater than `LOCK_WAIT_DEADLINE_MS` plus one worst-case `STEP_TIMEOUT_MS` step — proving the timeout was sized for the whole walk, not the lock wait alone.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCK_WAIT_DEADLINE_MS } from "../scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
type HookEntry = { hooks: { command: string; timeout?: number }[]; matcher?: string };
const hooksConfig = JSON.parse(readFileSync(`${repoRoot}hooks/hooks.json`, "utf8")) as {
    hooks: { UserPromptSubmit: HookEntry[]; PostToolUse: HookEntry[] };
};

function findRunStepHookTimeout(entries: HookEntry[], matcher?: string): number | undefined {
    const group = entries.find((entry) => entry.matcher === matcher);
    if (group === undefined) throw new Error(`no hooks.json entry with matcher ${JSON.stringify(matcher)}`);
    const runStepHookEntry = group.hooks.find((hook) => hook.command.includes("runStepHook.ts"));
    if (runStepHookEntry === undefined) throw new Error(`no runStepHook.ts command under matcher ${JSON.stringify(matcher)}`);
    return runStepHookEntry.timeout;
}

test("test_hookTimeouts_runStepHookHasAnExplicitTimeoutOnBothRegistrations", () => {
    const userPromptSubmitTimeout = findRunStepHookTimeout(hooksConfig.hooks.UserPromptSubmit, undefined);
    const postToolUseSkillTimeout = findRunStepHookTimeout(hooksConfig.hooks.PostToolUse, "Skill");
    assert.equal(typeof userPromptSubmitTimeout, "number");
    assert.equal(typeof postToolUseSkillTimeout, "number");
});

const STEP_TIMEOUT_MS = 300_000; // scripts/runStepHook.ts:47, duplicated here so this test has no import cycle on runStepHook.ts.

test("test_hookTimeouts_lockWaitDeadlineLeavesRoomForOneWorstCaseStepUnderTheHookTimeout", () => {
    const userPromptSubmitTimeout = findRunStepHookTimeout(hooksConfig.hooks.UserPromptSubmit, undefined)!;
    const postToolUseSkillTimeout = findRunStepHookTimeout(hooksConfig.hooks.PostToolUse, "Skill")!;
    const worstCaseBeforeLock = STEP_TIMEOUT_MS + LOCK_WAIT_DEADLINE_MS;
    assert.ok(worstCaseBeforeLock < userPromptSubmitTimeout * 1000, `${worstCaseBeforeLock}ms is not below a ${userPromptSubmitTimeout}s hook timeout`);
    assert.ok(worstCaseBeforeLock < postToolUseSkillTimeout * 1000, `${worstCaseBeforeLock}ms is not below a ${postToolUseSkillTimeout}s hook timeout`);
});
```

`findRunStepHookTimeout`'s `UserPromptSubmit` group has no `matcher` key in `hooks/hooks.json` (line 3's array has one entry, with no `"matcher"` field) — `group.matcher === undefined` matches it correctly when called with `undefined`.

Production fix, `hooks/hooks.json`: add `"timeout": 900` to both of `runStepHook.ts`'s entries (900s covers one worst-case 300s step plus the new 300s lock-wait deadline, with 300s of margin — `taskTestsHook.ts`'s own `600` in this same file bounds a different, single-suite-run path and is not reused here):

Lines 14-17 become:
```json
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts\"",
            "timeout": 900
          },
```

Lines 69-72 become:
```json
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts\"",
            "timeout": 900
          },
```

Next, prove the mechanism itself with a real held lock, run through the real production pipeline config (no synthetic `configWith`), for both hook event paths. Append to `tests/runStepHook.test.ts`:

`test_runStepHook_reportsAHeldLockInsteadOfHangingOnUserPromptSubmit` and `test_runStepHook_reportsAHeldLockInsteadOfHangingOnPostToolUseSkill`:

Plain-English behavior: a source repo whose lock is already held by a different owner, walked from `LOCK_SOURCE_REPO` with a tiny `WAIT_FOR_LOCK_MS`/`LOCK_WAIT_DEADLINE_MS`, must come back with a failed, reported result — not a hang — through both `UserPromptSubmit` and `PostToolUse:Skill`, and must do so in well under a second of real wall-clock time.

```ts
import { acquireSourceRepoLock } from "../scripts/tackle-tasks/shared/sourceRepoLock.ts";

function heldLockRepo(): { projectRoot: string } {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "run-step-lock-")));
    spawnSync("git", ["-C", projectRoot, "init", "-q"]);
    // Held by a different owner than this test's own packet, the same way sourceRepoLock.test.ts seeds a held lock.
    acquireSourceRepoLock(projectRoot, "someone-else:99");
    return { projectRoot };
}

function heldLockPacketArgument(projectRoot: string): string {
    return JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot, worktree: projectRoot, branch: "task-1", exitType: "", exitNote: "",
    });
}

test("test_runStepHook_reportsAHeldLockInsteadOfHangingOnUserPromptSubmit", () => {
    const { projectRoot } = heldLockRepo();
    const startedAt = Date.now();
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        cwd: projectRoot,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `/run-step pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO ${heldLockPacketArgument(projectRoot)}` }),
        encoding: "utf8",
        env: { ...process.env, WAIT_FOR_LOCK_MS: "5", LOCK_WAIT_DEADLINE_MS: "20" },
    });
    const elapsedMs = Date.now() - startedAt;
    const result = JSON.parse(String(JSON.parse(spawned.stdout.trim()).hookSpecificOutput.additionalContext).split("\n")[0]);
    assert.equal(result.ok, false);
    assert.ok(elapsedMs < 5000, `took ${elapsedMs}ms`);
});

test("test_runStepHook_reportsAHeldLockInsteadOfHangingOnPostToolUseSkill", () => {
    const { projectRoot } = heldLockRepo();
    const startedAt = Date.now();
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        cwd: projectRoot,
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "run-step", args: `pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO ${heldLockPacketArgument(projectRoot)}` } }),
        encoding: "utf8",
        env: { ...process.env, WAIT_FOR_LOCK_MS: "5", LOCK_WAIT_DEADLINE_MS: "20" },
    });
    const elapsedMs = Date.now() - startedAt;
    const result = JSON.parse(String(JSON.parse(spawned.stdout.trim()).hookSpecificOutput.additionalContext).split("\n")[0]);
    assert.equal(result.ok, false);
    assert.ok(elapsedMs < 5000, `took ${elapsedMs}ms`);
});
```

Both tests run against the repo's real `scripts/steps.json` (no `RUN_STEP_CONFIG` override, so `runHook`'s usual config-file argument is omitted), which is why Step 3's rename must regenerate `steps.json` before these two tests are run — do Step 3 before running them.

### Step 3 — rename the box so the routing contract stops naming a cap of 15 minutes

Mechanical rename, `HAVE_15_MINUTES_PASSED_Q` → `HAS_LOCK_WAIT_DEADLINE_PASSED_Q`, everywhere it is the box's own identity (not a line-number or unrelated reference):

- `git mv scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts scripts/tackle-tasks/lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts`, then inside it change `box: "HAVE_15_MINUTES_PASSED_Q"` to `box: "HAS_LOCK_WAIT_DEADLINE_PASSED_Q"` (the only occurrence of the old name in this file, per Step 1's edits above).
- `git mv scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.template.json scripts/tackle-tasks/lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.template.json`, then change its `"box": "HAVE_15_MINUTES_PASSED_Q"` (in `output`) to `"box": "HAS_LOCK_WAIT_DEADLINE_PASSED_Q"`. Leave `"box": "WAS_LOCK_ACQUIRED_Q"` (in `input`) alone — that names the *previous* box, unaffected by this rename.
- `git mv scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.test.ts scripts/tackle-tasks/lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.test.ts`, then change its `import { main } from "./HAVE_15_MINUTES_PASSED_Q.ts";` to `import { main } from "./HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts";`, and rename its four test functions (the two pre-existing ones plus Step 1's two additions) from `test_have15MinutesPassed_...` to `test_hasLockWaitDeadlinePassed_...`, keeping each test's own behavior-describing suffix unchanged (e.g. `test_have15MinutesPassed_waitsAgainBeforeTheCap` → `test_hasLockWaitDeadlinePassed_waitsAgainBeforeTheCap`).
- `scripts/tackle-tasks/lockSourceRepo/WAS_LOCK_ACQUIRED_Q.ts`: change `return { ...packet, next: "HAVE_15_MINUTES_PASSED_Q" };` to `return { ...packet, next: "HAS_LOCK_WAIT_DEADLINE_PASSED_Q" };`.
- `scripts/tackle-tasks/lockSourceRepo/WAS_LOCK_ACQUIRED_Q.test.ts:34`: change `assert.equal(result.next, "HAVE_15_MINUTES_PASSED_Q");` to `assert.equal(result.next, "HAS_LOCK_WAIT_DEADLINE_PASSED_Q");`.
- `scripts/tackle-tasks/lockSourceRepo/WAIT_FOR_LOCK.template.json`: change its `"box": "HAVE_15_MINUTES_PASSED_Q"` (in `input` — the box that fed `WAIT_FOR_LOCK`) to `"box": "HAS_LOCK_WAIT_DEADLINE_PASSED_Q"`.
- `scripts/generateSteps.ts:31`: change `lockSourceRepo: ["LOCK_SOURCE_REPO", "WAS_LOCK_ACQUIRED_Q", "HAVE_15_MINUTES_PASSED_Q", "WAIT_FOR_LOCK"],` to `lockSourceRepo: ["LOCK_SOURCE_REPO", "WAS_LOCK_ACQUIRED_Q", "HAS_LOCK_WAIT_DEADLINE_PASSED_Q", "WAIT_FOR_LOCK"],`.
- `diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd`: change the box declaration `HAVE_15_MINUTES_PASSED_Q["have 15 minutes passed?"]` to `HAS_LOCK_WAIT_DEADLINE_PASSED_Q["has the lock wait deadline passed?"]`, and every other occurrence of the bare id `HAVE_15_MINUTES_PASSED_Q` on this diagram's edge lines and its `class` list to `HAS_LOCK_WAIT_DEADLINE_PASSED_Q`.
- `diagrams/tackle-tasks/_pipeline-monolith.mmd:65,103`: change both `E4_LOCK_SOURCE_REPO["lock the source repo, wait up to 15 minutes"]` and `E5_LOCK_SOURCE_REPO["lock the source repo, wait up to 15 minutes"]` to `"lock the source repo, wait up to 5 minutes"`. This overview diagram is excluded from `generateSteps.ts` (per `plans/pipeline-audit-20260905-114658/9-task.md`'s scope confirmation) — the edit is cosmetic-only and does not affect `steps.json`.
- Regenerate the generated config: `npm run steps` from the repo root (`package.json:4`, `node --no-inspect scripts/generateSteps.ts && node --no-inspect scripts/generateWorkflow.ts`). Confirm `scripts/steps.json` now names `HAS_LOCK_WAIT_DEADLINE_PASSED_Q` and no longer names `HAVE_15_MINUTES_PASSED_Q`: `grep -c "HAVE_15_MINUTES_PASSED_Q" scripts/steps.json` must print `0`.

Confirmed live, `grep -rln "HAVE_15_MINUTES_PASSED_Q" scripts tests diagrams skills` before this step returns exactly: `scripts/generateSteps.ts`, `scripts/steps.json` (generated — regenerated by this step, not hand-edited), `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.test.ts`, `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.template.json`, `scripts/tackle-tasks/lockSourceRepo/WAIT_FOR_LOCK.template.json`, `scripts/tackle-tasks/lockSourceRepo/WAS_LOCK_ACQUIRED_Q.test.ts`, `scripts/tackle-tasks/lockSourceRepo/WAS_LOCK_ACQUIRED_Q.ts`, `scripts/tackle-tasks/lockSourceRepo/HAVE_15_MINUTES_PASSED_Q.ts`, `diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd` — every one is edited or renamed above.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

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

If it does not print `all passing`, run `npm test 2>&1 | tail -50` and fix the failure before moving on; repeat until `all passing` prints, then stop — do not re-run to confirm.
