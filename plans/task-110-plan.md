# Task 110 plan: turn `/task-stats` into a hook-capture skill, like `/view-task`

## Summary

Move the stats computation out of the skill (which currently shells out to
`taskStats.ts` via `execFileSync` and prints a brief) and into a new
`UserPromptSubmit` hook, `scripts/taskStatsHook.ts`, that computes the stats
in-process and blocks the prompt with the formatted output as `reason`. The
skill body becomes an empty stub. `scripts/taskStatsBrief.ts` and its test
are deleted as dead code.

**Output policy — settled, no probe.** `reason` is exactly
`formatTaskStats(stats)`. The hook adds no formatting layer of its own: no
markdown wrapper, no ANSI (the brief records that the ESC byte is stripped
on this path, leaving literal `[32m` garbage). Task 110 owns *who calls*
`formatTaskStats` and *how its result reaches the user* — never what that
function returns. When task 109 rewrites `formatTaskStats` into markdown,
the hook inherits the new output with no task-110 change. The rendering
question the brief raises is therefore task 109's to answer, not this
task's. Do not run a probe, and do not edit this plan file during
implementation.

## Edits

### 1. `scripts/taskStatsHook.ts` — new file

File does not exist on disk. Create it with this exact content:

```typescript
import { readFileSync } from "node:fs";
import { computeTaskStats, formatTaskStats } from "./taskStats.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const payload = JSON.parse(readFileSync(0, "utf8")) as { prompt?: string; cwd?: string };
const prompt = payload.prompt ?? "";

if (prompt !== "/task-stats" && !prompt.startsWith("/task-stats ")) {
    process.exit(0);
}

const pair = resolveTaskFiles(payload.cwd ?? process.cwd());
const today = new Date().toISOString().slice(0, 10);
const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
const reason = formatTaskStats(stats);

process.stdout.write(JSON.stringify({ decision: "block", reason }));
```

Notes on why each line is what it is (all drawn from content already read):
- `computeTaskStats`, `formatTaskStats` are named exports of
  `scripts/taskStats.ts` (lines 139 and 168 of that file).
- `readTaskFile`, `resolveTaskFiles` are imported by `scripts/taskStats.ts`
  itself from `./taskFiles.ts` (line 2) and used exactly this way in its own
  CLI entry block (lines 197–202 of `scripts/taskStats.ts`):
  `resolveTaskFiles(process.cwd())` → `{ tasksPath, completedTasksPath }`,
  then `readTaskFile(pair.tasksPath)` / `readTaskFile(pair.completedTasksPath)`.
  The hook uses `payload.cwd ?? process.cwd()` in place of bare
  `process.cwd()` per the brief's description of the precedent: "resolves
  the task files from `payload.cwd`".
- Prompt matching and silent exit follow the brief's description of
  `scripts/viewTaskHook.ts`: "exits 0 silently unless the prompt is
  `/view-task` or starts with `/view-task `" — translated to `/task-stats`.
- Output shape follows the brief's description: "finishes with
  `process.stdout.write(JSON.stringify({ decision: "block", reason }))`".
- Indentation (4 spaces) matches `scripts/taskStats.ts`, the file this hook
  is a direct companion to.

### 2. `skills/task-stats/SKILL.md` — replace body

Current full content (7 lines, already read):
```
---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts"`
```

Edit: replace line 6 (`!\`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts"\``)
with the stub instruction the brief quotes verbatim from
`skills/view-task/SKILL.md`'s shape ("frontmatter plus the single
instruction \"do nothing. don't even acknowledge what the user typed. just
let the UserPromptSubmit hook do its thing.\"").

New full file content:
```
---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

do nothing. don't even acknowledge what the user typed. just let the UserPromptSubmit hook do its thing.
```

Frontmatter (lines 1–4) is unchanged — only the body (line 6) changes.

### 3. `hooks/hooks.json` — add a second `UserPromptSubmit` entry

Current text, lines 2–12:
```
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/viewTaskHook.ts\""
          }
        ]
      }
    ],
```

New text for the same span — add a second array entry alongside the
existing one (per the brief: "add a second alongside it"), matching the
one-entry-per-hook shape already used by the `Stop`, `SubagentStop`, and
`SessionEnd` arrays elsewhere in this same file:
```
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/viewTaskHook.ts\""
          }
        ]
      },
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

No other part of `hooks/hooks.json` changes. `PostToolUse`, `Stop`,
`SubagentStop`, `SessionEnd` (lines 13–68 as currently read) are untouched.

### 4. `scripts/taskStats.ts` — no edit

`computeTaskStats` and `formatTaskStats` are already exported (lines 139 and
168). The brief says the hook imports them "directly" — no change to this
file is needed to support that import.

### 5. `scripts/taskStatsBrief.ts` — delete

This file exists only to shell out to `taskStats.ts` (its own comment at
line 4 says "Absolute, because the reading agent's shell has no
CLAUDE_PLUGIN_ROOT to expand"; the shell-out itself is line 7:
`execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();`).
Once the hook computes stats in-process this round trip is dead. Delete the
file: `git rm scripts/taskStatsBrief.ts`.

### 6. `tests/taskStatsBrief.test.ts` — delete

Both tests in this file (`"brief embeds live taskStats.ts output under the
stats label"` and `"brief keeps the verbatim print instruction"`) test
`scripts/taskStatsBrief.ts`, which is deleted in step 5. Delete the file:
`git rm tests/taskStatsBrief.test.ts`.

### 7. `tests/taskStatsHook.test.ts` — new file

File does not exist on disk. Create it with this exact content, mirroring
the subprocess-execution style already used in `tests/taskStatsBrief.test.ts`
(`execFileSync` + `fileURLToPath`) but exercising the hook's stdin/stdout
contract instead of a plain function call:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { computeTaskStats, formatTaskStats } from "../scripts/taskStats.ts";
import { readTaskFile, resolveTaskFiles } from "../scripts/taskFiles.ts";

const hookPath = fileURLToPath(new URL("../scripts/taskStatsHook.ts", import.meta.url));
const repoRoot = process.cwd();

test("resolves task files from payload.cwd, not the process cwd", () => {
  const payload = JSON.stringify({ prompt: "/task-stats", cwd: repoRoot });
  // tmpdir() has no tasks.json, so passing proves the hook used payload.cwd.
  const output = execFileSync("node", [hookPath], { input: payload, encoding: "utf8", cwd: tmpdir() });
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "block");

  const pair = resolveTaskFiles(repoRoot);
  const today = new Date().toISOString().slice(0, 10);
  const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
  assert.equal(parsed.reason, formatTaskStats(stats));
});

test("blocks /task-stats with a trailing argument", () => {
  const payload = JSON.stringify({ prompt: "/task-stats extra", cwd: repoRoot });
  const output = execFileSync("node", [hookPath], { input: payload, encoding: "utf8" });
  const parsed = JSON.parse(output);
  assert.equal(parsed.decision, "block");
});

test("exits silently for a prompt that is not /task-stats", () => {
  const payload = JSON.stringify({ prompt: "hello there", cwd: repoRoot });
  const output = execFileSync("node", [hookPath], { input: payload, encoding: "utf8" });
  assert.equal(output, "");
});
```

## Verification

Run these after the edits, from the repo root:

1. `node --test tests/taskStatsHook.test.ts`
   Expected: all three tests pass (`# pass 3`, `# fail 0`).

2. `echo '{"prompt":"/task-stats","cwd":"'"$(pwd)"'"}' | node scripts/taskStatsHook.ts`
   Expected: stdout is a single JSON object with `"decision":"block"` and a
   `"reason"` string equal to what `node scripts/taskStats.ts` prints
   (module used directly on stdout, no JSON wrapper) — i.e. the same lines
   `formatTaskStats` produces (open/blocked counts, files coverage,
   completed counts, closed-last-7/30, etc.), just carried inside the JSON
   `reason` field instead of printed raw.

3. `echo '{"prompt":"something else","cwd":"'"$(pwd)"'"}' | node scripts/taskStatsHook.ts`
   Expected: empty stdout, exit code 0.

4. `test -f scripts/taskStatsBrief.ts && echo present || echo gone`
   Expected: `gone`.

5. `test -f tests/taskStatsBrief.test.ts && echo present || echo gone`
   Expected: `gone`.

6. `node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8')); console.log('valid json')"`
   Expected: `valid json` (confirms the hand-edited `hooks.json` still
   parses).

7. `cat skills/task-stats/SKILL.md`
   Expected: frontmatter unchanged, body is exactly
   `do nothing. don't even acknowledge what the user typed. just let the UserPromptSubmit hook do its thing.`
   with no `!\`node ...\`` shell-out line remaining.

8. In the actual Claude Code UI, type `/task-stats`. Expected: the prompt is
   blocked (the skill body does not run, so the output appears once, not
   twice), and the text shown is exactly what `node scripts/taskStats.ts`
   prints.
