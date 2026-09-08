# Task 101: Add a rate-task skill that scores a task's difficulty and split-worthiness on the 1-10 scale

## Goal

**This task is considered done when all of these are true:**

- `/rate-task <taskNum>` prints a difficulty score and a split-worthiness score, both on the 1-10 scale
- the two scores are computed independently; a high difficulty does not raise the split score
- BOTH scores are written back to the task record in .taskTools/tasks.json
- a split-worthiness of 5 or more also prints split points shaped for `/split-task <taskNum> <numSplits>`
- `/rate-task` with no argument rates every open task

## User request

[split-task-child] This task is being created by `/split-task` as one of an already-requested set of 3 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `skills/rate-task/SKILL.md`, `scripts/rateTask.ts`, `tests/rateTask.test.ts`.

TITLE: Add a rate-task skill that scores a task's difficulty and split-worthiness on the 1-10 scale

This is child 3 of 3 split out of parent task 66 ("Widen the difficulty scale from 1-5 to 1-10 and add a rate-task skill that scores difficulty and split-worthiness"). Child 1 (task 99) remaps the stored numbers to 1-10; child 2 (task 100) rewrites the scale anchor prose. This child builds the new skill that produces ratings on that widened scale.

WHAT THE SKILL DOES: rate-task evaluates a task's `description`, `readOnlyFiles` and `modifiableFiles` and produces TWO numbers, both on the 1-10 scale but kept as distinct fields:

- `difficulty` — persisted back into the task record.
- a split-worthiness score — NOT persisted, reported in chat only. When it is 5 or higher, the skill also suggests concrete split points suitable for feeding into `/split-task`.

A task can be hard yet perfectly atomic, so a high difficulty must NOT automatically produce a high split score. The two numbers are computed independently.

WRITE-BACK: rate-task mutates only the task's `difficulty` in .taskTools/tasks.json — note the task list lives under .taskTools/, not the repo root. That mutation belongs in a new scripts/rateTask.ts which reuses `readTaskFile` and `resolveTaskFiles` from scripts/taskFiles.ts and writes with `JSON.stringify(..., null, 2) + "\n"`, the same pattern scripts/taskArchival.ts uses, rather than hand-editing JSON with Edit. The split score and split points are never written to disk.

INVOCATION: `/rate-task <taskNum>`. With no argument it rates every open task, mirroring the optional-argument shape of skills/pick-a-task/SKILL.md line 6. Pull task records with `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>`, passing all task numbers in one call, exactly as skills/pick-a-task/SKILL.md line 14 does.

DISCOVERY: skills are auto-discovered from skills/<name>/SKILL.md — .claude-plugin/plugin.json has no skills array and there is no commands/ directory — so this needs one new skill directory and no manifest edit.

SUGGESTED SPLIT POINTS must be shaped so they can be handed straight to `/split-task <taskNum> <numSplits>`; check skills/split-task/SKILL.md for what that skill actually consumes and match it.

INPUT KEY NAMES: `modifiableFiles` and `readOnlyFiles` come from task 58, along with the shared accessor that falls back to the legacy `files` key. Read tasks through that accessor rather than assuming which key is present.

TESTS: fixture tasks.json with two tasks — one sprawling multi-subsystem task and one one-line mechanical task. Assert rate-task gives the sprawling one a split score >= 6 plus at least two named split points, and the mechanical one a score < 6 with no split points. (Threshold stated on the new 1-10 scale.)

DIFFICULTY: 3 on the OLD 1-5 scale.

BLOCKED BY: task 58 — it introduces the `modifiableFiles` / `readOnlyFiles` keys and the shared accessor that falls back to the legacy `files` key; those key names are inputs this skill reads and they do not exist yet. Also blocked by task 65 — it adds the split-task skill whose `<taskNum> <numSplits>` interface the suggested split points feed into, so the output format has to match what split-task consumes. Also blocked by task 100 (child 2) — the ten scale anchors must exist before this skill can rate anything against them.

Child 3 of 3 split from parent task 66, and the only one that adds new code. Children 1 (task 99, data remap) and 2 (task 100, scale anchor prose) touch disjoint files.

Blocker status verified at creation time: tasks 58 and 65 are BOTH already closed and present in completedTasks.json, so the `modifiableFiles` / `readOnlyFiles` keys, the shared accessor with its legacy-`files` fallback, and the split-task skill all exist today. Only task 100 remains as a live blocker — the ten scale anchors must be written before this skill can rate against them.

Two scores, deliberately independent. `difficulty` is persisted; split-worthiness is reported in chat and never written to disk. Independence matters because a task can be genuinely hard and still perfectly atomic — the implementation must not derive one score from the other or let a high difficulty drag the split score up. Split points are only emitted once split-worthiness reaches the mid-scale threshold.

New files: skills/rate-task/SKILL.md (skills are auto-discovered from skills/<name>/SKILL.md — .claude-plugin/plugin.json carries no skills array and there is no commands/ directory, so no manifest edit is needed), scripts/rateTask.ts, tests/rateTask.test.ts.

Persistence contract: the write lives in scripts/rateTask.ts, not in the skill body. It reuses `readTaskFile` and `resolveTaskFiles` from scripts/taskFiles.ts and serializes with `JSON.stringify(value, null, 2) + "\n"`, matching scripts/taskArchival.ts. Hand-editing the JSON with Edit is explicitly rejected. Only the `difficulty` key of the targeted task may change; .taskTools/tasks.json is the target path, not a repo-root tasks.json.

Interface shape follows existing skills rather than inventing one: the optional-argument form (no argument = rate every open task) mirrors skills/pick-a-task/SKILL.md line 6, and record retrieval batches every task number into a single `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` call as skills/pick-a-task/SKILL.md line 14 does.

Output coupling: emitted split points must be directly consumable by `/split-task <taskNum> <numSplits>`; read skills/split-task/SKILL.md for the real input shape rather than assuming.

Task reads must go through the shared accessor so both the new key names and legacy `files`-only records resolve.

**AMENDMENT (user, 2026-08-08) — supersedes the persistence rule above.**

The `goal` field on this task is authoritative. **BOTH scores are persisted to the task record**, not difficulty alone. The statements above that split-worthiness "is NOT persisted", "reported in chat only", and "never written to disk" are withdrawn.

Unchanged: the two scores are still computed independently — a hard but atomic task must still score low on split-worthiness — and split points are still emitted only when split-worthiness reaches 5 or more. Adding the second key to the task record is deliberate; nothing else reads it yet.

**AMENDMENT 2 (orchestrator, 2026-08-08) — the "shared accessor" is resolved. Do not search for it again.**

Three planning rounds were spent hunting for this accessor. These are its verified facts, read directly from the source:

- It is declared at scripts/taskGroups.ts:15 as `export function declaredFiles(task: TaskRecord): string[]`.
- Its entire body is `return Array.isArray(task.files) ? (task.files as string[]) : [];`.
- From scripts/rateTask.ts, import it as `import { declaredFiles } from "./taskGroups.ts";`.

**Correction to this task's premise.** There is NO `modifiableFiles` / `readOnlyFiles` fallback anywhere in the codebase today. Task 58's key rename never reached the readers: `declaredFiles` reads the legacy `files` key and nothing else, and task 98 — open, and running in this same batch — is the child that starts draining that legacy key. Every statement above that rate-task "evaluates a task's `readOnlyFiles` and `modifiableFiles`", or that the accessor "falls back to the legacy `files` key", describes a future state, not the current one. Do not plan against it.

**What to build instead.** scripts/rateTask.ts calls `declaredFiles(task)` to get the file list, and scores from that list plus the task's `description`. Do not reimplement the accessor, do not read `task.files` directly, and do not add any `modifiableFiles` / `readOnlyFiles` handling of your own — when `declaredFiles` gains the fallback later, rate-task inherits it for free.

scripts/taskGroups.ts has been added to this task's readable files so the import can be confirmed. Treat it as READ-ONLY; it is not this task's to edit.

## Files

### skills/rate-task/SKILL.md

(missing: file not found on disk)

### scripts/rateTask.ts

(missing: file not found on disk)

### tests/rateTask.test.ts

(missing: file not found on disk)

@scripts/taskFiles.ts
@scripts/taskArchival.ts
@scripts/getTaskDetails.ts
@skills/pick-a-task/SKILL.md
@skills/split-task/SKILL.md
@scripts/ownershipKeys.ts
@scripts/addTaskFiles.ts
@scripts/prepareTasks.ts
@scripts/taskGroups.ts