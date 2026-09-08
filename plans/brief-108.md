# Task 108: task-stats prints each blocked task's collapsed blocker chain plus the fastest unblocking sequence

## User request

add the blockedBy sequences of every blocked task to the output of task-stats.  '[a] <- [b,c] <- [d]' shows 'd' is blocked by 'b,c', and either 'b' or 'c' is blocked by 'a'. 
it should also show a 'fastest unblocking sequence: tackle-tasks [n,m,o...]' where 'n,m,o' are the left-most nodes of each blockedBy sequence.  Note: the printout shouldn't duplicate information: It should NOT print out (one per line) '[a] <- [b]', '[b] <- [d]', '[c] <- [d]', '[a] <- [b,c] <- [d]'.  For these 4 tasks, it should only print out the single line "sum".

**Where it goes.** scripts/taskStats.ts already computes blocking but only as a count — `blockedCount` at :68, derived from `openBlockersOf` at :24-27, which resolves ONE level of blockedBy and filters to still-open numbers. The chain data is a new field on the `TaskStats` type (:5-20) computed in `computeTaskStats` (:59-82) and rendered in `formatTaskStats` (:84-102), which already builds a string array and joins it. The CLI at :104-109 needs no change.

**The collapse rule, stated as an algorithm.** Emit one chain per SINK — an open task that has at least one open blocker and that no other open task lists as a blocker. Walk backwards from the sink one level at a time: level N-1 is the union of the open blockers of every task in level N, minus any task already seen. Render as `[level0] <- [level1] <- ... <- [sink]`, each level a comma-joined ascending list in brackets. Because a non-sink blocked task always appears inside some sink's chain, it never gets a line of its own, which is exactly the no-duplication requirement. Guard the walk with a seen-set so a blockedBy cycle terminates instead of looping.

**The roots line.** `fastest unblocking sequence: tackle-tasks [n,m,o...]` where the numbers are the union of every chain's level0, deduplicated and sorted ascending, comma-joined with no spaces so the string can be pasted straight into the tackle-tasks invocation format documented at skills/tackle-tasks/SKILL.md:12.

**Verified against real data.** Running this algorithm over tasks.json at the time of writing yields sinks 36, 83, 84, 96, 97, 105, 106 and these seven lines: `[35] <- [36]`, `[82] <- [83]`, `[75] <- [84]`, `[93] <- [96]`, `[93] <- [97]`, `[86] <- [105]`, `[107] <- [106]`, with `fastest unblocking sequence: tackle-tasks [35,75,82,86,93,107]`. Note that 96 and 97 are distinct sinks sharing root 93, so two lines with the same level0 are correct output, not a duplication bug — the rule dedupes chains that are sub-paths of other chains, not chains that share a root.

**The format is deliberately lossy and that is fine.** `[a] <- [b,c] <- [d]` asserts only that some member of level N is blocked by some member of level N-1, not that every pair is connected. The user chose this compression knowingly; do not add per-edge annotation to make it exact.

**Duplication worth folding in.** `openBlockersOf` now exists three times with the same body: taskStats.ts:24-27, scripts/checkBlockers.ts:13-17, and scripts/runStartup.ts:12-14. Task 84 independently needs the same transitive walk and the same `<-` rendering for its hook short-circuit output, and its description already asks for the walk to be extended in one shared place rather than reimplemented. Whichever of 84 and 108 lands first should export the shared walk; the second reuses it. Not blocking in either direction.

### scripts/taskStats.ts

```
// Aggregates tasks.json and completedTasks.json: closure velocity, files coverage, blocking, and the parallelism a tackle-tasks run would get.
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { declaredFiles, groupTasksByFileOverlap } from "./taskGroups.ts";

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
};

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

export function computeTaskStats(open: TaskRecord[], completed: TaskRecord[], today: string): TaskStats {
    const openNumbers = new Set(open.map(t => t.taskNumber));
    const unblocked = open.filter(t => openBlockersOf(t, openNumbers).length === 0);
    // tackle-tasks refuses blocked tasks and tasks declaring no files, so the forecast uses the same gate.
    const forecastable = unblocked.filter(t => declaredFiles(t).length > 0);
    const groups = forecastable.length > 0 ? groupTasksByFileOverlap(forecastable) : [];

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
    return lines.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const pair = resolveTaskFiles(process.cwd());
    const today = new Date().toISOString().slice(0, 10);
    const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
    process.stdout.write(formatTaskStats(stats));
}

```

### tests/taskStats.test.ts

```
// Behavioral checks for taskStats.ts. Run with: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTaskStats, formatTaskStats } from "../scripts/taskStats.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "taskStats.ts");
const TODAY = "2026-07-31";

function openTask(taskNumber: number, extra: Record<string, unknown> = {}) {
    return { taskNumber, title: `task ${taskNumber}`, ...extra };
}

function closedTask(taskNumber: number, completionDate: string, extra: Record<string, unknown> = {}) {
    return { taskNumber, title: `task ${taskNumber}`, completionDate, ...extra };
}

test("counts open and completed tasks separately", () => {
    const stats = computeTaskStats([openTask(1), openTask(2)], [closedTask(3, "2026-07-30")], TODAY);
    assert.equal(stats.openCount, 2);
    assert.equal(stats.completedCount, 1);
});

test("a task is blocked only by blockers that are still open", () => {
    const open = [openTask(1, { blockedBy: [{ taskNum: 2, reason: "needs task 2" }] }), openTask(2), openTask(3, { blockedBy: [{ taskNum: 99, reason: "needs task 99" }] })];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.blockedCount, 1);
    assert.equal(stats.unblockedCount, 2);
});

test("reports how many open tasks declare files", () => {
    const open = [openTask(1, { files: ["a.ts"] }), openTask(2), openTask(3, { files: [] })];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.openWithFiles, 1);
    assert.equal(stats.openWithoutFiles, 2);
});

test("closure windows count completionDate within 7 and 30 days of today", () => {
    const completed = [
        closedTask(1, "2026-07-31"),
        closedTask(2, "2026-07-25"),
        closedTask(3, "2026-07-10"),
        closedTask(4, "2026-05-01"),
    ];
    const stats = computeTaskStats([], completed, TODAY);
    assert.equal(stats.closedLast7, 2);
    assert.equal(stats.closedLast30, 3);
    assert.equal(stats.completedCount, 4);
});

test("busiest day is the completionDate closing the most tasks", () => {
    const completed = [
        closedTask(1, "2026-07-30"),
        closedTask(2, "2026-07-30"),
        closedTask(3, "2026-07-29"),
    ];
    const stats = computeTaskStats([], completed, TODAY);
    assert.deepEqual(stats.busiestDay, { date: "2026-07-30", count: 2 });
});

test("busiestDay is null when nothing has been closed", () => {
    assert.equal(computeTaskStats([], [], TODAY).busiestDay, null);
});

test("counts completed tasks that recorded commit hashes", () => {
    const completed = [
        closedTask(1, "2026-07-30", { commitHashes: ["abc1234"] }),
        closedTask(2, "2026-07-30", { commitHashes: [] }),
        closedTask(3, "2026-07-30"),
    ];
    assert.equal(computeTaskStats([], completed, TODAY).completedWithCommitHashes, 1);
});

test("group forecast joins tasks sharing a file and separates disjoint ones", () => {
    const open = [
        openTask(1, { files: ["shared.ts"] }),
        openTask(2, { files: ["shared.ts", "b.ts"] }),
        openTask(3, { files: ["c.ts"] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.groupCount, 2);
    assert.equal(stats.largestGroupSize, 2);
});

test("group forecast excludes blocked tasks and tasks declaring no files", () => {
    const open = [
        openTask(1, { files: ["a.ts"] }),
        openTask(2, { files: ["b.ts"], blockedBy: [{ taskNum: 1, reason: "needs task 1" }] }),
        openTask(3),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.groupCount, 1);
    assert.equal(stats.forecastTaskCount, 1);
});

test("contended files rank paths claimed by more than one open task", () => {
    const open = [
        openTask(1, { files: ["hot.ts", "cold.ts"] }),
        openTask(2, { files: ["hot.ts"] }),
        openTask(3, { files: ["hot.ts"] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.contendedFiles[0], { path: "hot.ts", taskCount: 3 });
    assert.equal(stats.contendedFiles.some(f => f.path === "cold.ts"), false);
});

test("formatted output names every headline number", () => {
    const text = formatTaskStats(computeTaskStats([openTask(1, { files: ["a.ts"] })], [closedTask(2, "2026-07-30")], TODAY));
    for (const fragment of ["open", "completed", "closed", "groups", "files"]) {
        assert.match(text, new RegExp(fragment));
    }
});

test("CLI prints stats for the project it is run from", () => {
    const root = mkdtempSync(join(tmpdir(), "taskTools-taskStats-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([openTask(1, { files: ["a.ts"] }), openTask(2)]));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([closedTask(3, "2026-07-30")]));
    const output = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
    assert.match(output, /2 open/);
    assert.match(output, /1 completed/);
});

test("CLI reports empty projects without crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "taskTools-taskStats-empty-"));
    writeFileSync(join(root, "tasks.json"), "[]");
    writeFileSync(join(root, "completedTasks.json"), "[]");
    const output = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
    assert.match(output, /0 open/);
});

```
