# Task 84 plan: `/tackle-tasks` blocked-task interceptor hook

## Summary

Add a `UserPromptSubmit` hook, `scripts/tackleTasksHook.ts`, that intercepts
`/tackle-tasks [<numbers>] ...` invocations, reports each requested task's
**direct** open blockers, and — when at least one requested task remains
unblocked — hands the agent the dynamically generated skill body (from
`scripts/tackleTasksBrief.ts`) as `additionalContext`, scoped to only the
unblocked task numbers, with `decision: "block"` so `SKILL.md` never expands
on top of it. When every requested task is blocked, the hook prints the
report and stops (no `additionalContext`, nothing to continue with). Prompts
that are not `/tackle-tasks` exit 0 with no output. Register the new hook in
`hooks/hooks.json`. Add `tests/tackleTasksHook.test.ts` covering the behavior.

No changes to `scripts/viewTaskHook.ts`, `scripts/checkBlockers.ts`,
`scripts/taskFiles.ts`, or `scripts/tackleTasksBrief.ts` — all four are
reused unchanged (the first as a structural precedent only; the other three
by import / subprocess call).

## Design decisions (resolved, not left to the implementer)

1. **Single output mechanism for every requested-count.** The goal's bullet
   "the same output format is used whether one task number or many were
   passed" plus the amendment's blanket statement "Multi-task invocations no
   longer pass through silently" (not qualified to "only when something is
   blocked") together mean the hook always intercepts a parseable
   `/tackle-tasks` invocation — 1 number or many, blocked or not — rather
   than adding a separate "pass through if nothing blocked" branch. This is
   also the smaller diff: one code path, no extra early-exit special case.
   - If nothing requested is blocked: `reason` is omitted, `additionalContext`
     carries the full generated brief for the original set. This subsumes the
     original prose's point 3 ("single number, not blocked → inject body") as
     the zero-blocked case of the general rule, so it needs no separate branch.
   - If some but not all are blocked: `reason` carries the blocked-lines +
     run line; `additionalContext` carries the brief scoped to the remaining
     unblocked numbers only.
   - If all requested are blocked: `reason` only, no `additionalContext` —
     matches goal bullet "when no task is left unblocked, the hook prints the
     list and stops the run."
   - If the prompt has zero parseable task numbers (e.g. bare
     `/tackle-tasks`): exit 0, nothing to check.

2. **Direct blockers only, reusing `checkBlockers.ts` as a subprocess.**
   `openBlockersOf` in `scripts/checkBlockers.ts` is a private closure, not
   exported, and the file has no CLI-entry guard (unlike
   `scripts/tackleTasksBrief.ts`), so importing it would run its top-level
   code as a side effect. `scripts/tackleTasksBrief.ts` already establishes
   the pattern of invoking it as a subprocess via `execFileSync` and treating
   its stdout as the source of truth; the skill body it emits already
   documents the exact text format
   (`task N: BLOCKED by open task(s) [{"taskNum":M,"reason":"..."}]` /
   `task N: unblocked`) as something downstream is expected to parse. The
   hook reuses that same format. No cycle guard is needed in the hook itself
   — only one level is walked, so no infinite loop is possible; the amendment
   explicitly withdrew the transitive-walk requirement this guard existed for.

3. **`cwd` must be passed explicitly to both subprocess calls.** Both
   `checkBlockers.ts` and (indirectly, for its own internal check)
   `tackleTasksBrief.ts`'s CLI resolve tasks via `resolveTaskFiles(process.cwd())`
   — the *subprocess's* OS cwd, not any payload field. `execFileSync` does
   not inherit a useful cwd by default in a hook context, so the hook passes
   `{ cwd: root }` explicitly, where `root` is `payload.cwd` (falling back to
   `process.cwd()`) — the exact same fallback line `scripts/viewTaskHook.ts`
   already uses at line 44.

4. **`tackleTasksBrief` is imported and called directly, not shelled out.**
   `scripts/tackleTasksBrief.ts` exports `tackleTasksBrief(argsValue,
   blockedStatus)` as a plain function with no side effects at module-load
   time; its CLI-only code is gated behind
   `if (process.argv[1]?.endsWith("tackleTasksBrief.ts"))`, which is false
   when imported from the hook. The hook computes `blockedStatus` itself for
   the unblocked-only `argsValue` (mirroring exactly what the CLI branch of
   `tackleTasksBrief.ts` does at its own line 199) and calls the exported
   function directly — no new subprocess, no re-implementation of brief text.

5. **`hookSpecificOutput.additionalContext` shape.** Per the brief: "It can
   block, or it can add `hookSpecificOutput.additionalContext`... The two can
   be emitted together in one JSON object." The standard Claude Code hook
   JSON shape for this is
   `{ decision: "block", reason?, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }`.
   `reason` is included only when there is at least one blocked line to show
   (it is user-facing prose, so an empty/absent report should not print an
   empty message); `hookSpecificOutput` is included only when at least one
   requested task remains unblocked.

6. **Prompt matching.** Copy `scripts/viewTaskHook.ts`'s exact technique:
   strip a leading plugin-namespace prefix with
   `.replace(/^\/[\w-]+:/, "/")`, then require the prompt to equal
   `/tackle-tasks` or start with `/tackle-tasks ` (with the trailing space) —
   this correctly excludes sibling commands `/tackle-tasks-v2` and
   `/tackle-unblocked-tasks`, which do not share that exact prefix boundary.

7. **Task-number parsing.** Reuse `leadingTaskNumbers` from
   `scripts/taskFiles.ts` unchanged, per the brief's explicit instruction, on
   the whitespace-split tokens following `/tackle-tasks`. To build the
   continuation `argsValue` (numbers replaced, trailing free text like
   `valid` preserved), the hook locates the same token boundary
   `leadingTaskNumbers` stops at, using the identical per-token regex
   (`/^["'[\]\d,]+$/`) inline — `leadingTaskNumbers` returns only the parsed
   numbers, not the consumed-token count, and its signature is used by other,
   unowned callers (`scripts/checkBlockers.ts`'s own CLI entry, at minimum),
   so it is not changed.

## File-by-file plan

### scripts/tackleTasksHook.ts — new file

Create with this exact content:

```ts
// UserPromptSubmit hook: reports /tackle-tasks blockers and injects the skill body for the rest, so SKILL.md never re-runs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { leadingTaskNumbers } from "./taskFiles.ts";
import { tackleTasksBrief } from "./tackleTasksBrief.ts";

const checkBlockersPath = fileURLToPath(new URL("./checkBlockers.ts", import.meta.url));

type Blocker = { taskNum: number; reason: string };
type BlockerReport = { blockedTasks: Map<number, Blocker[]>; unblockedTasks: number[] };

function parseBlockerReport(output: string): BlockerReport {
  const blockedTasks = new Map<number, Blocker[]>();
  const unblockedTasks: number[] = [];
  for (const line of output.trim().split("\n")) {
    const blocked = line.match(/^task (\d+): BLOCKED by open task\(s\) (.+)$/);
    if (blocked) {
      blockedTasks.set(Number(blocked[1]), JSON.parse(blocked[2]) as Blocker[]);
      continue;
    }
    const unblocked = line.match(/^task (\d+): unblocked$/);
    if (unblocked) unblockedTasks.push(Number(unblocked[1]));
  }
  return { blockedTasks, unblockedTasks };
}

let payload: { prompt?: unknown; cwd?: unknown };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
// Plugin skills reach the hook namespaced, as /taskTools:tackle-tasks.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (prompt !== "/tackle-tasks" && !prompt.startsWith("/tackle-tasks ")) process.exit(0);

const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const tokens = prompt.slice("/tackle-tasks".length).trim().split(/\s+/).filter(Boolean);
const requested = leadingTaskNumbers(tokens);
if (requested.length === 0) process.exit(0);

let report: BlockerReport;
try {
  const output = execFileSync("node", [checkBlockersPath, JSON.stringify(requested)], { encoding: "utf8", cwd: root });
  report = parseBlockerReport(output);
} catch {
  process.exit(0);
}

const blockedLines: string[] = [];
const blockerNumbers: number[] = [];
for (const n of requested) {
  const blockers = report.blockedTasks.get(n);
  if (!blockers) continue;
  for (const b of blockers) {
    blockedLines.push(`[${n}] blocked by: ${b.taskNum}: ${b.reason}`);
    if (!blockerNumbers.includes(b.taskNum)) blockerNumbers.push(b.taskNum);
  }
}

const result: { decision: "block"; reason?: string; hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string } } = {
  decision: "block",
};
if (blockedLines.length > 0) {
  result.reason = [...blockedLines, `run 'tackle-tasks [${blockerNumbers.join(",")}] valid' first`].join("\n");
}
if (report.unblockedTasks.length > 0) {
  const splitIndex = tokens.findIndex(t => !/^["'[\]\d,]+$/.test(t));
  const trailing = splitIndex === -1 ? "" : tokens.slice(splitIndex).join(" ");
  const argsValue = JSON.stringify(report.unblockedTasks) + (trailing ? ` ${trailing}` : "");
  const blockedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8", cwd: root }).trimEnd();
  result.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: tackleTasksBrief(argsValue, blockedStatus) };
}
process.stdout.write(JSON.stringify(result) + "\n");
```

### hooks/hooks.json — edit

Current lines 12–20:

```
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsHook.ts\""
          }
        ]
      }
    ],
```

Replace with:

```
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsHook.ts\""
          }
        ]
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/tackleTasksHook.ts\""
          }
        ]
      }
    ],
```

This adds a third `UserPromptSubmit` hook entry alongside `viewTaskHook.ts`
and `taskStatsHook.ts`, same shape, same array. Nothing else in the file
changes.

### tests/tackleTasksHook.test.ts — new file

Create with this exact content:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/tackleTasksHook.ts", import.meta.url));

function withProject(tasks: unknown[], run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tackle-tasks-hook-"));
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(dir, "completedTasks.json"), "[]");
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(prompt: string, cwd: string): { code: number | null; stdout: string } {
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify({ prompt, cwd }),
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout };
}

test("non /tackle-tasks prompt exits 0 with no output", () => {
  withProject([], dir => {
    const { code, stdout } = runHook("/other-command foo", dir);
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

test("single blocked task prints its direct blocker and stops the run", () => {
  withProject(
    [
      { taskNumber: 75, title: "t75" },
      { taskNumber: 84, title: "t84", blockedBy: [{ taskNum: 75, reason: "needs 75 first" }] },
    ],
    dir => {
      const { code, stdout } = runHook("/tackle-tasks [84] valid", dir);
      assert.equal(code, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.decision, "block");
      assert.equal(out.reason, "[84] blocked by: 75: needs 75 first\nrun 'tackle-tasks [75] valid' first");
      assert.equal(out.hookSpecificOutput, undefined);
    },
  );
});

test("multi-task run reports only the blocked tasks and continues with the rest", () => {
  withProject(
    [
      { taskNumber: 2, title: "t2" },
      { taskNumber: 3, title: "t3", blockedBy: [{ taskNum: 2, reason: "r" }] },
      { taskNumber: 4, title: "t4" },
      { taskNumber: 5, title: "t5", blockedBy: [{ taskNum: 2, reason: "r" }] },
      { taskNumber: 8, title: "t8" },
      { taskNumber: 12, title: "t12" },
    ],
    dir => {
      const { code, stdout } = runHook("/tackle-tasks [3,4,5,8,12] valid", dir);
      assert.equal(code, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.decision, "block");
      assert.equal(out.reason, "[3] blocked by: 2: r\n[5] blocked by: 2: r\nrun 'tackle-tasks [2] valid' first");
      assert.ok(out.hookSpecificOutput.additionalContext.includes("[4,8,12] valid"));
    },
  );
});

test("fully unblocked run still hands the agent the generated skill body", () => {
  withProject([{ taskNumber: 84, title: "t84" }], dir => {
    const { code, stdout } = runHook("/tackle-tasks [84] valid", dir);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
    assert.equal(out.reason, undefined);
    assert.ok(out.hookSpecificOutput.additionalContext.includes("[84] valid"));
  });
});

test("plugin-namespaced prompt is recognized the same as the bare command", () => {
  withProject([{ taskNumber: 84, title: "t84" }], dir => {
    const { code, stdout } = runHook("/taskTools:tackle-tasks [84] valid", dir);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
  });
});
```

### scripts/viewTaskHook.ts, scripts/checkBlockers.ts, scripts/taskFiles.ts, scripts/tackleTasksBrief.ts — no edits

Read-only for this task:
- `viewTaskHook.ts` is the structural precedent this hook is modeled on
  (payload parsing, prompt-boundary matching, `payload.cwd` fallback) — not
  imported, not modified.
- `checkBlockers.ts` is invoked as a subprocess via `execFileSync`, exactly
  as `tackleTasksBrief.ts` already does; its stdout text format is consumed
  as-is.
- `taskFiles.ts`'s `leadingTaskNumbers` is imported and called unchanged.
- `tackleTasksBrief.ts`'s exported `tackleTasksBrief` function is imported
  and called unchanged.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `node --test tests/tackleTasksHook.test.ts`
   Expected: all 5 tests pass, process exits 0.

2. `npm test`
   Expected: full suite passes (no regression in other test files).

3. Manual smoke test of the amendment's own worked example:

```
DIR=$(mktemp -d)
cat > "$DIR/tasks.json" <<'EOF'
[{"taskNumber":2,"title":"t2"},{"taskNumber":3,"title":"t3","blockedBy":[{"taskNum":2,"reason":"r"}]},{"taskNumber":4,"title":"t4"},{"taskNumber":5,"title":"t5","blockedBy":[{"taskNum":2,"reason":"r"}]},{"taskNumber":8,"title":"t8"},{"taskNumber":12,"title":"t12"}]
EOF
echo '[]' > "$DIR/completedTasks.json"
echo "{\"prompt\":\"/tackle-tasks [3,4,5,8,12] valid\",\"cwd\":\"$DIR\"}" | node scripts/tackleTasksHook.ts
```

Expected stdout: a single JSON object with `"decision":"block"`, a `"reason"`
field whose value (after JSON-decoding) is exactly:

```
[3] blocked by: 2: r
[5] blocked by: 2: r
run 'tackle-tasks [2] valid' first
```

and a `hookSpecificOutput.additionalContext` string containing the substring
`[4,8,12] valid`.

4. `echo '{"prompt":"/other-command"}' | node scripts/tackleTasksHook.ts; echo "exit:$?"`
   Expected: no stdout, `exit:0`.
