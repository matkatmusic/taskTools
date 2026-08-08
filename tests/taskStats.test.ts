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

test("each parallel command holds at most 6 tasks that share no files", () => {
    const filesOf = new Map<number, string[]>([
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, ["hot.ts"]] as [number, string[]]),
        ...[10, 11, 12, 13, 14, 15, 16].map(n => [n, [`solo-${n}.ts`]] as [number, string[]]),
    ]);
    const open = [...filesOf].map(([taskNumber, files]) => openTask(taskNumber, { files }));
    const stats = computeTaskStats(open, [], TODAY);

    assert.deepEqual(stats.parallelBatches.flat().sort((a, b) => a - b), open.map(t => t.taskNumber));
    for (const batch of stats.parallelBatches) {
        assert.ok(batch.length <= 6, `batch [${batch}] exceeds 6 tasks`);
        const files = batch.flatMap(n => filesOf.get(n) ?? []);
        assert.equal(new Set(files).size, files.length, `batch [${batch}] shares a file`);
    }
    assert.deepEqual(stats.parallelBatches[0], [1, 10, 11, 12, 13, 14]);
    assert.match(formatTaskStats(stats), /parallel commands:\n {2}tackle-tasks \[1,10,11,12,13,14\]\n/);
});

test("collapses a diamond blockedBy graph into one chain per sink", () => {
    const open = [
        openTask(1),
        openTask(2, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(3, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(4, { blockedBy: [{ taskNum: 2, reason: "needs 2" }, { taskNum: 3, reason: "needs 3" }] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, [[[1], [2, 3], [4]]]);
    assert.deepEqual(stats.fastestUnblockingSequence, [1]);
    const text = formatTaskStats(stats);
    assert.match(text, /blocked task chains:\n {2}\[1\] <- \[2,3\] <- \[4\]\n/);
    assert.match(text, /fastest unblocking sequence: tackle-tasks \[1\]/);
    assert.equal(/\[1\] <- \[2\]/.test(text), false);
    assert.equal(/\[2\] <- \[4\]/.test(text), false);
    assert.equal(/\[3\] <- \[4\]/.test(text), false);
});

test("two sinks sharing one root produce two chains and one deduplicated fastest sequence", () => {
    const open = [
        openTask(1),
        openTask(2, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(3, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, [[[1], [2]], [[1], [3]]]);
    assert.deepEqual(stats.fastestUnblockingSequence, [1]);
});

test("no blocked tasks produces empty chain data and no chain section in output", () => {
    const open = [openTask(1), openTask(2)];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, []);
    assert.deepEqual(stats.fastestUnblockingSequence, []);
    const text = formatTaskStats(stats);
    assert.equal(/blocked task chains:/.test(text), false);
    assert.equal(/fastest unblocking sequence:/.test(text), false);
});

test("a blockedBy cycle behind a genuine sink terminates with a finite chain", () => {
    const open = [
        openTask(1, { blockedBy: [{ taskNum: 2, reason: "needs 2" }] }),
        openTask(2, { blockedBy: [{ taskNum: 3, reason: "needs 3" }] }),
        openTask(3, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(4, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, [[[3], [2], [1], [4]]]);
    assert.deepEqual(stats.fastestUnblockingSequence, [3]);
});
