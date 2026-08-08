# Task 110: Turn /task-stats into a UserPromptSubmit hook capture with a stub skill body, like /view-task

## User request

task-stats should be a skill-blocking hook-capture, like sync-jsonl-projects, not a skill.  the skill body would become an empty stub.  If hook output can support markdown formatting, or ANSI color coding, use that to make the output pretty/formatted.  otherwise just move the ${stats} output to the hook's output.

**The precedent named in the request is not in this repo, but an exact in-repo equivalent already exists.** `sync-jsonl-projects` belongs to jfredToolsPlugin. The pattern to copy is scripts/viewTaskHook.ts, which reads the hook payload from stdin with `readFileSync(0, "utf8")`, exits 0 silently unless the prompt is `/view-task` or starts with `/view-task `, resolves the task files from `payload.cwd`, and finishes with `process.stdout.write(JSON.stringify({ decision: "block", reason }))`. Its companion skills/view-task/SKILL.md is ALREADY the empty stub this request describes — frontmatter plus the single instruction "do nothing. don't even acknowledge what the user typed. just let the UserPromptSubmit hook do its thing." Copy both halves verbatim in shape.

**Wiring.** hooks/hooks.json already has a `UserPromptSubmit` array containing one entry (viewTaskHook.ts); add a second alongside it. Per the memory note for this repo, hooks live in hooks/hooks.json and never in any settings.json.

**What this deletes.** scripts/taskStatsBrief.ts exists only to shell out to taskStats.ts with execFileSync (:7) and wrap the result in a brief for the skill body. Once the hook computes the stats in-process, that round trip and its test are dead — remove scripts/taskStatsBrief.ts and tests/taskStatsBrief.test.ts rather than leaving them orphaned. The hook should import `computeTaskStats` / `formatTaskStats` from scripts/taskStats.ts directly.

**The open question, and the exact way to settle it.** The hook's `reason` field is documented as shown to the USER and explicitly not added to the model's context, which is the whole point here — but whether that surface renders markdown is unverified. Settle it with the same probe that settled task 109: have the hook emit a heading, `**bold**`, `` `code` `` and a small table in `reason`, type `/task-stats`, and look. Two outcomes, both already anticipated by the request: if markdown renders, task 109's markdown formatter is reused unchanged; if it does not, emit the plain `formatTaskStats` string. Do NOT reach for ANSI as the fallback — task 109 established experimentally that the ESC byte is stripped on the paths to the user's screen, leaving literal `[32m` garbage, and there is no reason to expect the `reason` surface to differ.

**Behavioural constraints inherited from the precedent.** Any prompt that is not a `/task-stats` invocation must exit 0 silently (viewTaskHook.ts does this by prefix check). Blocking is required, not optional: without `decision: "block"` the stub skill would also expand and the user would see the output twice.

Related: task 109 rewrites `formatTaskStats` into markdown sections and task 108 adds blocker-chain lines to the same function. This task changes only who calls that function and how the result reaches the user, so it composes with both — but if 110 lands first, 109 and 108 must be verified through the hook path rather than the skill path.

### scripts/taskStatsHook.ts

(missing: file not found on disk)

### scripts/taskStats.ts

```
// Aggregates tasks.json and completedTasks.json: closure velocity, files coverage, blocking, and the parallelism a tackle-tasks run would get.
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { declaredFiles, groupTasksByFileOverlap, type TaskGroup } from "./taskGroups.ts";

export type TaskStats = {
    openCount: number;
    blockedCount: number;
    unblockedCount: number;
    openWithFiles: number;
    openWithoutFiles: number;
    completedCount: number;
    completedWithCommitHashes: number;
    closedLast7: number;
    closedLast30: number;
    busiestDay: { date: string; count: number } | null;
    forecastTaskCount: number;
    groupCount: number;
    largestGroupSize: number;
    contendedFiles: { path: string; taskCount: number }[];
    blockerChains: number[][][];
    fastestUnblockingSequence: number[];
    parallelBatches: number[][];
};

const TASKS_PER_COMMAND = 6;

const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
    return blockedBy.map(entry => entry.taskNum).filter(n => openNumbers.has(n));
}

function countClosedWithin(completed: TaskRecord[], today: string, days: number): number {
    const cutoff = dayNumber(today) - days + 1;
    return completed.filter(t => {
        const date = typeof t.completionDate === "string" ? t.completionDate : "";
        return date !== "" && dayNumber(date) >= cutoff && dayNumber(date) <= dayNumber(today);
    }).length;
}

function findBusiestDay(completed: TaskRecord[]): { date: string; count: number } | null {
    const perDay = new Map<string, number>();
    for (const task of completed) {
        if (typeof task.completionDate !== "string") continue;
        perDay.set(task.completionDate, (perDay.get(task.completionDate) ?? 0) + 1);
    }
    const ranked = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ranked.length > 0 ? { date: ranked[0][0], count: ranked[0][1] } : null;
}

function rankContendedFiles(tasks: TaskRecord[]): { path: string; taskCount: number }[] {
    const perFile = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    return [...perFile.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([path, taskCount]) => ({ path, taskCount }));
}

function collapsedBlockerChains(open: TaskRecord[], openNumbers: Set<number>): number[][][] {
    const byNumber = new Map<number, TaskRecord>(open.map(t => [t.taskNumber, t] as const));
    const blockedTaskNumbers = new Set<number>();
    for (const task of open) {
        for (const blocker of openBlockersOf(task, openNumbers)) blockedTaskNumbers.add(blocker);
    }
    const sinks = open
        .filter(t => openBlockersOf(t, openNumbers).length > 0 && !blockedTaskNumbers.has(t.taskNumber))
        .map(t => t.taskNumber)
        .sort((a, b) => a - b);

    return sinks.map(sink => {
        const levels: number[][] = [[sink]];
        const seen = new Set<number>([sink]);
        let frontier = [sink];
        while (true) {
            const next = new Set<number>();
            for (const taskNumber of frontier) {
                const task = byNumber.get(taskNumber);
                if (!task) continue;
                for (const blocker of openBlockersOf(task, openNumbers)) {
                    if (!seen.has(blocker)) next.add(blocker);
                }
            }
            if (next.size === 0) break;
            const nextLevel = [...next].sort((a, b) => a - b);
            levels.unshift(nextLevel);
            for (const n of nextLevel) seen.add(n);
            frontier = nextLevel;
        }
        return levels;
    });
}

function unblockingRoots(chains: number[][][]): number[] {
    const roots = new Set<number>();
    for (const chain of chains) for (const n of chain[0]) roots.add(n);
    return [...roots].sort((a, b) => a - b);
}

// Round i is the i-th task of every group, so no round holds two tasks that share a file.
function buildParallelBatches(groups: TaskGroup[]): number[][] {
    const rounds: number[][] = [];
    for (const group of groups) group.taskNumbers.forEach((taskNumber, i) => (rounds[i] ??= []).push(taskNumber));
    return rounds.flatMap(round =>
        Array.from({ length: Math.ceil(round.length / TASKS_PER_COMMAND) }, (_, i) =>
            round.slice(i * TASKS_PER_COMMAND, (i + 1) * TASKS_PER_COMMAND).sort((a, b) => a - b)),
    );
}

export function computeTaskStats(open: TaskRecord[], completed: TaskRecord[], today: string): TaskStats {
    const openNumbers = new Set(open.map(t => t.taskNumber));
    const unblocked = open.filter(t => openBlockersOf(t, openNumbers).length === 0);
    // tackle-tasks refuses blocked tasks and tasks declaring no files, so the forecast uses the same gate.
    const forecastable = unblocked.filter(t => declaredFiles(t).length > 0);
    const groups = forecastable.length > 0 ? groupTasksByFileOverlap(forecastable) : [];
    const blockerChains = collapsedBlockerChains(open, openNumbers);

    return {
        openCount: open.length,
        blockedCount: open.length - unblocked.length,
        unblockedCount: unblocked.length,
        openWithFiles: open.filter(t => declaredFiles(t).length > 0).length,
        openWithoutFiles: open.filter(t => declaredFiles(t).length === 0).length,
        completedCount: completed.length,
        completedWithCommitHashes: completed.filter(t => Array.isArray(t.commitHashes) && t.commitHashes.length > 0).length,
        closedLast7: countClosedWithin(completed, today, 7),
        closedLast30: countClosedWithin(completed, today, 30),
        busiestDay: findBusiestDay(completed),
        forecastTaskCount: forecastable.length,
        groupCount: groups.length,
        largestGroupSize: groups.reduce((n, g) => Math.max(n, g.taskNumbers.length), 0),
        contendedFiles: rankContendedFiles(open),
        blockerChains,
        fastestUnblockingSequence: unblockingRoots(blockerChains),
        parallelBatches: buildParallelBatches(groups),
    };
}

export function formatTaskStats(stats: TaskStats): string {
    const lines = [
        `${stats.openCount} open (${stats.unblockedCount} unblocked, ${stats.blockedCount} blocked)`,
        `${stats.openWithFiles} of ${stats.openCount} open tasks declare files — ${stats.openWithoutFiles} would be refused by tackle-tasks`,
        `${stats.completedCount} completed, ${stats.completedWithCommitHashes} with commit hashes recorded`,
        `closed: ${stats.closedLast7} in the last 7 days, ${stats.closedLast30} in the last 30`,
    ];
    if (stats.busiestDay) lines.push(`busiest day: ${stats.busiestDay.date} (${stats.busiestDay.count} closed)`);
    lines.push(
        stats.forecastTaskCount > 0
            ? `parallelism: ${stats.forecastTaskCount} runnable tasks would form ${stats.groupCount} groups, largest ${stats.largestGroupSize} tasks (serialized within a group)`
            : `parallelism: no runnable tasks — nothing to group`,
    );
    if (stats.contendedFiles.length > 0) {
        lines.push("contended files (each shared task serializes):");
        for (const file of stats.contendedFiles) lines.push(`  ${file.path} — ${file.taskCount} tasks`);
    }
    if (stats.blockerChains.length > 0) {
        lines.push("blocked task chains:");
        for (const chain of stats.blockerChains) lines.push(`  ${chain.map(level => `[${level.join(",")}]`).join(" <- ")}`);
        lines.push(`fastest unblocking sequence: tackle-tasks [${stats.fastestUnblockingSequence.join(",")}]`);
    }
    if (stats.parallelBatches.length > 0) {
        lines.push(`parallel commands:`);
        for (const batch of stats.parallelBatches) lines.push(`  tackle-tasks [${batch.join(",")}]`);
    }
    return lines.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const pair = resolveTaskFiles(process.cwd());
    const today = new Date().toISOString().slice(0, 10);
    const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
    process.stdout.write(formatTaskStats(stats));
}

```

### skills/task-stats/SKILL.md

```
---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts"`

```

### hooks/hooks.json

```
{
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
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/turn-modified-flag.ts\" 2>/dev/null || true"
          },
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/reflow-comments-post.ts\"",
            "statusMessage": "Reflowing wrapped comments..."
          },
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/relatedTests.ts\"",
            "statusMessage": "Running related tests...",
            "enabled": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/stage-and-summarize-stop.ts\"",
            "statusMessage": "Checking comments and unstaged work..."
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/stage-and-summarize-stop.ts\"",
            "statusMessage": "Checking comments and unstaged work..."
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/session-end-cleanup.ts\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}

```

### scripts/taskStatsBrief.ts

```
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

### tests/taskStatsBrief.test.ts

```
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brief } from "../scripts/taskStatsBrief.ts";

test("brief embeds live taskStats.ts output under the stats label", () => {
  const taskStatsPath = fileURLToPath(new URL("../scripts/taskStats.ts", import.meta.url));
  const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();
  assert.ok(brief.includes(`- stats: ${stats}`));
});

test("brief keeps the verbatim print instruction", () => {
  assert.ok(
    brief.includes(
      "Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question."
    )
  );
});

```

### tests/taskStatsHook.test.ts

(missing: file not found on disk)
