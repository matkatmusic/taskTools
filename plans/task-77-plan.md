# Task 77 Plan: Move the task-stats skill body into a script that emits it as a literal brief

## Context confirmed by reading

- `skills/task-stats/SKILL.md` (8 lines, read in full):
  ```
  ---
  name: task-stats
  description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
  ---

  - stats: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStats.ts"`

  Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
  ```
- `scripts/taskStatsBrief.ts` — does not exist on disk (confirmed: Read errored "File does not exist").
- `tests/taskStatsBrief.test.ts` — does not exist on disk (confirmed: Read errored "File does not exist").

The brief (`plans/brief-77.md`) describes the mirrored file `scripts/reviewPlanBrief.ts` textually (its export name `reviewerBrief`, its absolute-path idiom at lines 6-7 using `fileURLToPath(new URL("./planReviewRuling.ts", import.meta.url))` with the comment "Absolute, because the reviewer's shell has no CLAUDE_PLUGIN_ROOT to expand", and its CLI guard `process.argv[1]?.endsWith("reviewPlanBrief.ts")`). `scripts/reviewPlanBrief.ts` itself is not an owned file for this task, so the two new files below are original content built from the brief's description and the user's literal instruction ("just copy the task body directly into a `const brief = ` object that gets returned"), not copied from a file I read.

## Step 1 — Create `scripts/taskStatsBrief.ts`

New file, full content:

```ts
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const taskStatsPath = fileURLToPath(new URL("./taskStats.ts", import.meta.url));

const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();

export const brief = `- stats: ${stats}

Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
`;

if (process.argv[1]?.endsWith("taskStatsBrief.ts")) {
  process.stdout.write(brief);
}
```

Design notes (why each part is this way, resolved — nothing left for the implementer to decide):
- The prose body (the `- stats: ` line and the "Print the block above..." sentence) is copied verbatim from the current SKILL.md lines 6 and 8, with the dynamic part (the old inline `!` shell injection that ran `taskStats.ts`) replaced by the `${stats}` variable, per the brief's required 2-step job.
- `stats` is produced by actually executing `scripts/taskStats.ts` via `execFileSync("node", [taskStatsPath], ...)` — this is the "run it and embed its output" requirement; the brief text is never allowed to ship a placeholder.
- `.trimEnd()` on the captured output mirrors how the old inline `!`...`` shell substitution behaved (trailing newline stripped), so the emitted line reads `- stats: <output>` with no extra blank line before the following blank line.
- The absolute path via `fileURLToPath(new URL("./taskStats.ts", import.meta.url))` mirrors the exact idiom the brief quotes from `reviewPlanBrief.ts` (same directory, sibling script), for the same reason: the shell that eventually runs this script has no `CLAUDE_PLUGIN_ROOT` to expand.
- Export name is `brief`, per the user's literal instruction to use "a `const brief = ` object that gets returned."
- The CLI guard `process.argv[1]?.endsWith("taskStatsBrief.ts")` mirrors the brief's description of `reviewPlanBrief.ts`'s guard, keeping the module importable by its test (no stdout side effect on import) while still printing to stdout when run directly via `node scripts/taskStatsBrief.ts`.

## Step 2 — Create `tests/taskStatsBrief.test.ts`

New file, full content:

```ts
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brief } from "../scripts/taskStatsBrief.ts";

test("brief embeds live taskStats.ts output under the stats label", () => {
  const taskStatsPath = fileURLToPath(new URL("../scripts/taskStats.ts", import.meta.url));
  const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();
  expect(brief).toContain(`- stats: ${stats}`);
});

test("brief keeps the verbatim print instruction", () => {
  expect(brief).toContain(
    "Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question."
  );
});
```

Design notes:
- Uses Bun's built-in test runner (`bun:test`) per this project's stated preference for `bun` over `node`/`npm`, adding no new dependency.
- Test 1 independently re-runs `taskStats.ts` and asserts `brief` contains that exact live output under the `- stats: ` label — this proves the script embeds real, current data rather than a placeholder, without needing to know `taskStats.ts`'s internal logic.
- Test 2 proves the static prose survived the move into the script verbatim.
- No test touches `process.argv`/CLI behavior; importing `brief` must not print anything because of the `endsWith("taskStatsBrief.ts")` guard, so a plain import is safe to use directly in assertions.

## Step 3 — Edit `skills/task-stats/SKILL.md`

Current lines 5-8 (verbatim, as read):
```

- stats: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStats.ts"`

Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
```

Edit: replace lines 6-8 (the stats bullet, the blank line, and the prose line) with a single `!` block invoking the new brief script, leaving line 5's blank line untouched.

- old_string:
  ```
  - stats: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStats.ts"`

  Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
  ```
- new_string:
  ```
  !`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts"`
  ```

Resulting full file (6 lines):
```
---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts"`
```

No change to frontmatter (lines 1-4): the brief confirms this skill needs no `argument-hint` and no `allowed-tools` (it takes no `$ARGUMENTS`), so lines 1-4 are untouched.

## Verification

Run from repo root (`/Users/matkatmusicllc/Programming/taskTools`):

1. `cat skills/task-stats/SKILL.md`
   Expected: exactly the 6-line file shown above.

2. `bun test tests/taskStatsBrief.test.ts`
   Expected: both tests pass (2 pass, 0 fail).

3. `node scripts/taskStatsBrief.ts`
   Expected: stdout is `- stats: ` followed by the live output of `node scripts/taskStats.ts` on the same line, then a blank line, then the sentence `Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.`, then a trailing newline. No other output (importing does not double-print).

4. `node scripts/taskStats.ts` and compare its output to what appears after `- stats: ` in step 3's output.
   Expected: identical text, proving the brief embeds real, current data rather than a placeholder.

5. `CLAUDE_PLUGIN_ROOT="$(pwd)" bash -c 'eval "node \"${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts\""'`
   Expected: same output as step 3, proving the exact SKILL.md invocation string resolves and runs correctly.
