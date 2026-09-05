# Task 20 plan — block /tackle-tasks when the live permission_mode is plan

## Scope confirmation

- `hooks/hooks.json` — read in full. `UserPromptSubmit` is a single group whose `hooks` array today has 5 entries: `viewTaskHook.ts`, `readFileHook.ts`, `runStepHook.ts`, `taskStatsHook.ts`, `taskTestsHook.ts` (this last one carries `"timeout": 600`). No entry matches `/tackle-tasks` generically (confirmed: `grep -n "tackleTasksHook" hooks/hooks.json` returns nothing).

- `scripts/tackleTasksHook.ts` — the one file in the repo whose own header claims to be "the hook that handles the /tackle-tasks prompt": line 1, `// UserPromptSubmit hook: reports /tackle-tasks blockers and injects the skill body for the rest, so SKILL.md never re-runs.` Line 2, its own next line: `// Unregistered from hooks.json: this task-84 hook predates the v1.6 launch path, where SKILL.md emits skillBody itself.` This is dead code today — not wired into `hooks/hooks.json` or `.claude/settings.json` (confirmed: `grep -rln tackleTasksHook hooks/hooks.json .claude/settings.json` finds neither). `tests/tackleTasksHook.test.ts` is entirely commented out, with its own header: `// Disabled: scripts/tackleTasksHook.ts is unregistered from hooks.json on the v1.6 launch path; these tests assert the retired \`valid\` brief.` `git log --oneline -- scripts/tackleTasksHook.ts` confirms the unregistration was deliberate (commit `a2b7fb0`, "unregister task-84 hook").

- `skills/tackle-tasks/SKILL.md` — the actual current entry point for `/tackle-tasks`, read in full:
  ```
  ```!
  node "${CLAUDE_PLUGIN_ROOT}/scripts/tackle-tasks/shared/SkillBodyEmitter.ts" <<'TACKLETASKSEOF'
  $ARGUMENTS
  TACKLETASKSEOF
  ```
  ```
  A skill body's embedded `!\`...\`` block runs with only `$ARGUMENTS` on stdin — it never sees a hook's JSON payload, so it cannot read `permission_mode` itself. Any plan-mode gate has to be a hook, not a change to this file.

- `scripts/runStepHook.ts` — the only currently-registered `UserPromptSubmit` hook that matches any `/tackle-tasks` text at all, and only a narrow slice of it: line 433, `const payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> } = JSON.parse(readFileSync(0, "utf8"));` (no `permission_mode` field read at all today); line 443, `const resetMatch = promptText.match(/^\/tackle-tasks\s+reset\s+(\d+)(?:\s+(\S+))?\s*$/);`; lines 444–448, on a match it calls `await resetTask(...)` — a real mutation of `tasks.json` — and writes its own output and `process.exit(0)` before any other hook's decision is known. A bare `/tackle-tasks [8,13] valid` prompt does not match this regex, is not `/run-step` (`isTypedCommand`, line 440), and is not a `run-step` Skill call (`isSkillCall`, line 441 checks `toolInput.skill`, which is absent on a `UserPromptSubmit` payload) — so only the `reset` form reaches a mutation here.

  Claude Code runs every hook registered on one event independently; one hook's `decision: "block"` does not stop a sibling hook's side effect that already ran. So a separate `UserPromptSubmit` entry cannot, by itself, stop `runStepHook.ts` from calling `resetTask` for a `/tackle-tasks reset N` prompt submitted in plan mode — the guard has to run inside `runStepHook.ts` too, immediately before line 443's match is acted on.

  `tests/runStepHook.test.ts` lines 348–366, `test_runStepHook_runsTheResetForATackleTasksResetPrompt`: the existing positive-control test for this path — seeds a real `.taskTools/tasks.json` with an active run on task 7, submits `/tackle-tasks reset 7` with no `permission_mode` field, and asserts the reset happened (`"run" in task` becomes `false`). This test must keep passing unchanged (absent `permission_mode` must not block, matching every other hook's "no field means not plan" default).

**Conclusion**: no currently-registered hook gates a bare `/tackle-tasks` prompt on anything, and the reset sub-command mutates state before any other hook's block decision can matter. Resurrecting `scripts/tackleTasksHook.ts` would also resurrect its retired `checkBlockers`/`skillBody`-emission behavior, which `SKILL.md` now performs itself — re-registering it as-is would double-emit the skill body. This task instead adds one new, single-purpose hook file for the general entry gate, a small shared predicate both that hook and `runStepHook.ts`'s reset path call so the two never drift out of sync, and a guard inside `runStepHook.ts` immediately before its `resetTask` call.

- Payload field: per the task brief and the official hook reference (`https://code.claude.com/docs/en/hooks#common-input-fields`), `UserPromptSubmit` payloads carry a top-level `permission_mode` string field, sibling to `prompt` and `cwd` — the same shape every existing hook in this repo already destructures those two from (e.g. `scripts/taskTestsHook.ts` line 6: `let payload: { hook_event_name?: unknown; prompt?: unknown; cwd?: unknown; tool_input?: Record<string, unknown> };`).

## Steps

### Step 1 — red: write the new hook's test file first

Create `tests/tackleTasksPlanModeHook.test.ts`. Model: the disabled `runHook` helper in `tests/tackleTasksHook.test.ts` (spawn the hook as a real process, pipe a JSON payload on stdin, read stdout).

```ts
// tackleTasksPlanModeHook.ts blocks /tackle-tasks while the live session is in plan mode.  Run alone: node --test tests/tackleTasksPlanModeHook.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/tackleTasksPlanModeHook.ts", import.meta.url));

function runHook(prompt: string, permissionMode?: string): { code: number | null; stdout: string } {
    const payload: Record<string, unknown> = { prompt };
    if (permissionMode !== undefined) payload.permission_mode = permissionMode;
    const result = spawnSync("node", [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });
    return { code: result.status, stdout: result.stdout };
}

test("test_tackleTasksPlanModeHook_blocksWhenPermissionModeIsPlan", () => {
    // Plain-English step: the live payload says plan mode; the prompt is /tackle-tasks; the hook must block.
    const { code, stdout } = runHook("/tackle-tasks [8,13] valid", "plan");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /plan mode/i);
});

test("test_tackleTasksPlanModeHook_passesWhenPermissionModeIsDefault", () => {
    // Plain-English step: the live payload says default mode; the hook must produce no output.
    const { code, stdout } = runHook("/tackle-tasks [8,13] valid", "default");
    assert.equal(code, 0);
    assert.equal(stdout, "");
});

test("test_tackleTasksPlanModeHook_ignoresPromptsThatAreNotTackleTasks", () => {
    // Plain-English step: plan mode is live, but the prompt is unrelated; the hook must produce no output.
    const { code, stdout } = runHook("/other-command foo", "plan");
    assert.equal(code, 0);
    assert.equal(stdout, "");
});

test("test_tackleTasksPlanModeHook_recognizesThePluginNamespacedPrompt", () => {
    // Plain-English step: the prompt arrives as /taskTools:tackle-tasks, the plugin-namespaced form; plan mode still blocks it.
    const { code, stdout } = runHook("/taskTools:tackle-tasks [8,13] valid", "plan");
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
});

test("test_tackleTasksPlanModeHook_honoursAModeChangedDuringTheSession", () => {
    // Plain-English step: two independent invocations with different live payloads must not share cached state.
    const blocked = runHook("/tackle-tasks [8,13] valid", "plan");
    assert.equal(JSON.parse(blocked.stdout).decision, "block");
    const passed = runHook("/tackle-tasks [8,13] valid", "default");
    assert.equal(passed.stdout, "");
});
```

All five fail today: `scripts/tackleTasksPlanModeHook.ts` does not exist.

### Step 2 — green: write the shared predicate and the hook

`runStepHook.ts`'s reset path (Step 4/5 below) needs the exact same "/tackle-tasks" + `permission_mode === "plan"` match as the new hook — sharing one function keeps the two from drifting apart. Create `scripts/tackleTasksPlanModeGate.ts`:

```ts
// Shared by tackleTasksPlanModeHook.ts and runStepHook.ts's reset path: one place decides what counts as a blocked /tackle-tasks prompt.
export function tackleTasksPlanModeBlockReason(prompt: string, permissionMode: unknown): string | null {
    // Plugin skills reach the hook namespaced, as /taskTools:tackle-tasks.
    const normalizedPrompt = prompt.trimStart().replace(/^\/[\w-]+:/, "/");
    if (normalizedPrompt !== "/tackle-tasks" && !normalizedPrompt.startsWith("/tackle-tasks ")) return null;
    if (permissionMode !== "plan") return null;
    return "tackle-tasks cannot run in plan mode; switch to a mode that can edit files and run commands, then try again.";
}
```

Create `scripts/tackleTasksPlanModeHook.ts`:

```ts
// UserPromptSubmit hook: blocks /tackle-tasks while the live session's permission_mode is plan.
import { readFileSync } from "node:fs";
import { tackleTasksPlanModeBlockReason } from "./tackleTasksPlanModeGate.ts";

const payload: { prompt?: unknown; permission_mode?: unknown } = JSON.parse(readFileSync(0, "utf8"));
const reason = tackleTasksPlanModeBlockReason(typeof payload.prompt === "string" ? payload.prompt : "", payload.permission_mode);
if (reason === null) process.exit(0);

process.stdout.write(JSON.stringify({ decision: "block", reason }));
```

Do not infer the mode from `.claude/settings.json` or any other config file — the task brief and the audit both require reading the live `permission_mode` the payload reports on every invocation, since local, managed, and command-line sources can each override a config default, and the user can change mode mid-session.

### Step 3 — register the hook

In `hooks/hooks.json`, add one entry to the existing `UserPromptSubmit` group's `hooks` array (append after the `taskTestsHook.ts` entry, so it is the last one; ordering does not change the block decision since Claude Code blocks the prompt if any hook on the event returns `decision: "block"`):

```json
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/tackleTasksPlanModeHook.ts\""
          }
```

### Step 4 — red: prove the reset path still mutates state in plan mode

In `tests/runStepHook.test.ts`, add a new test immediately after `test_runStepHook_runsTheResetForATackleTasksResetPrompt` (lines 348–366), same fixture shape, `permission_mode: "plan"` added to the payload:

```ts
test("test_runStepHook_blocksTheResetForATackleTasksResetPromptInPlanMode", () => {
    // Setup: same repo shape as the default-mode reset test above.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-reset-plan-")));
    spawnSync("git", ["-C", cwd, "init", "-q"]);
    mkdirSync(join(cwd, ".taskTools"), { recursive: true });
    writeFileSync(join(cwd, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 7, title: "t", run: { active: false, history: [] }, codexReviewNotes: [] }]));
    writeFileSync(join(cwd, ".taskTools", "completedTasks.json"), "[]");
    const before = readFileSync(join(cwd, ".taskTools", "tasks.json"), "utf8");
    // Action: the user types the reset line while the live session is in plan mode.
    const { RUN_STEP_LOG: _unset, ...env } = process.env;
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        cwd, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "/tackle-tasks reset 7", permission_mode: "plan" }), encoding: "utf8", env,
    });
    // Verification: the hook blocks, and tasks.json is byte-for-byte unchanged — the reset never ran.
    const out = JSON.parse(spawned.stdout.trim());
    assert.equal(out.decision, "block");
    assert.match(out.reason, /plan mode/i);
    assert.equal(readFileSync(join(cwd, ".taskTools", "tasks.json"), "utf8"), before);
});
```

Fails today: `runStepHook.ts` never reads `permission_mode`, so the reset always runs and `tasks.json` changes.

### Step 5 — green: guard the reset path inside runStepHook.ts

In `scripts/runStepHook.ts`:

1. Add the import, alongside the file's other local imports:
   ```ts
   import { tackleTasksPlanModeBlockReason } from "./tackleTasksPlanModeGate.ts";
   ```
2. Line 433, widen the payload type to carry the field:
   ```ts
   // before
   const payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> } = JSON.parse(readFileSync(0, "utf8"));
   // after
   const payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown>; permission_mode?: unknown } = JSON.parse(readFileSync(0, "utf8"));
   ```
3. Insert the guard immediately before line 443's `resetMatch`, so it runs before any mutation:
   ```ts
   const planModeReason = tackleTasksPlanModeBlockReason(promptText, payload.permission_mode);
   if (planModeReason !== null) {
       process.stdout.write(`${JSON.stringify({ decision: "block", reason: planModeReason })}\n`);
       process.exit(0);
   }
   const resetMatch = promptText.match(/^\/tackle-tasks\s+reset\s+(\d+)(?:\s+(\S+))?\s*$/);
   ```
   `tackleTasksPlanModeBlockReason` only returns non-null for a `/tackle-tasks`-prefixed `promptText`, so this guard is inert for `/run-step` prompts and Skill calls — it cannot affect `isTypedCommand`/`isSkillCall` handling below it.

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

If it does not report "all passing", run `Bash(npm test 2>&1 | tail -50)` and fix the codebase until it does. Do not re-run `npm test` again once it reports "all passing".
