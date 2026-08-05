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
    const open = [openTask(1, { blockedBy: [2] }), openTask(2), openTask(3, { blockedBy: [99] })];
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
        openTask(2, { files: ["b.ts"], blockedBy: [1] }),
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
