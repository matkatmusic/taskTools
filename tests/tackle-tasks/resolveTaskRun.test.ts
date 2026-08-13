// resolveTaskRun.ts replaces bootstrap's "prepare" front-end. It mutates nothing.
// Run alone: node --test tests/tackle-tasks/resolveTaskRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTaskRun } from "../../scripts/tackle-tasks/resolveTaskRun.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../scripts/prepareTasks.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeProjectRoot(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "resolveTaskRun-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "seed");
    return root;
}

test("test_resolveTaskRun_createsNoWorktree", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    resolveTaskRun("[1]", root);
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(root);
    assert.equal(existsSync(conventionDirectory), false);
});

test("test_resolveTaskRun_writesNothingToTasksJson", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const before = readFileSync(join(root, "tasks.json"), "utf8");
    resolveTaskRun("[1]", root);
    const after = readFileSync(join(root, "tasks.json"), "utf8");
    assert.equal(after, before);
});

test("test_resolveTaskRun_returnsEveryRequestedTaskNumberIncludingBlockedOnes", () => {
    const root = makeProjectRoot([
        { taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] },
        { taskNumber: 2 },
    ]);
    const output = resolveTaskRun("[1,2]", root);
    assert.deepEqual(output.taskNumbers, [1, 2]);
});

test("test_resolveTaskRun_dedupesWhilePreservingOrder", () => {
    const root = makeProjectRoot([{ taskNumber: 3 }, { taskNumber: 1 }]);
    const output = resolveTaskRun("3 1 3 1", root);
    assert.deepEqual(output.taskNumbers, [3, 1]);
});

test("test_resolveTaskRun_rejectsEmptyAndMalformedInput", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    assert.throws(() => resolveTaskRun("", root), /no task numbers given/);
    assert.throws(() => resolveTaskRun("   ", root), /no task numbers given/);
    assert.throws(() => resolveTaskRun("abc", root), /invalid task number "abc"/);
    assert.throws(() => resolveTaskRun("0", root), /invalid task number "0"/);
    assert.throws(() => resolveTaskRun("-1", root), /invalid task number "-1"/);
    assert.throws(() => resolveTaskRun("1.5", root), /invalid task number "1.5"/);
});
