// DOCUMENT_GENERATION.ts is "write the task brief" in pipeline-preambleStatusCheck.mmd. Mutating: temp worktree only.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/DOCUMENT_GENERATION.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./DOCUMENT_GENERATION.ts";
import { createWorktreeForGroup } from "../../prepareTasks.ts";
import type { TaskGroup } from "../../taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "DOCUMENT_GENERATION-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "fileA.txt"), "seed\n");
    git(repoRoot, "add", "fileA.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_DOCUMENT_GENERATION_writesTheBriefInAutogenMode", () => {
    const repoRoot = makeTempRepo();
    seedTasksFile(repoRoot, [{ taskNumber: 9, title: "t9", description: "do it", files: ["fileA.txt"] }]);
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const packet = {
        box: "INIT_SUBMODULES_RECURSIVELY", scriptSignal: "continue", taskNumber: 9, runId: "run-a",
        projectRoot: repoRoot, worktree: worktreePath, branch: "task-9", docsMode: "AUTOGEN",
        planFile: "", exitType: "", exitNote: "",
    };

    const output = main(JSON.stringify(packet));

    assert.deepEqual(output, { ...packet, box: "DOCUMENT_GENERATION", scriptSignal: "continue" });
    assert.ok(existsSync(join(worktreePath, "plans", "brief-9.md")));
});

test("test_DOCUMENT_GENERATION_writesTheBriefInUpdateMode", () => {
    const repoRoot = makeTempRepo();
    seedTasksFile(repoRoot, [{ taskNumber: 9, title: "t9", description: "do it", files: ["fileA.txt"] }]);
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const packet = {
        box: "DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: "continue", taskNumber: 9, runId: "run-a",
        projectRoot: repoRoot, worktree: worktreePath, branch: "task-9", docsMode: "UPDATE",
        planFile: "", exitType: "", exitNote: "", next: "INIT_SUBMODULES_RECURSIVELY",
    };

    const output = main(JSON.stringify(packet));

    const { next: _next, ...expected } = packet;
    assert.deepEqual(output, { ...expected, box: "DOCUMENT_GENERATION", scriptSignal: "continue" });
    assert.ok(existsSync(join(worktreePath, "plans", "brief-9.md")));
});

test("test_DOCUMENT_GENERATION_runsTwiceWithTheSameInput", () => {
    const repoRoot = makeTempRepo();
    seedTasksFile(repoRoot, [{ taskNumber: 9, title: "t9", description: "do it", files: ["fileA.txt"] }]);
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const input = JSON.stringify({
        box: "INIT_SUBMODULES_RECURSIVELY", scriptSignal: "continue", taskNumber: 9, runId: "run-a",
        projectRoot: repoRoot, worktree: worktreePath, branch: "task-9", docsMode: "AUTOGEN",
        planFile: "", exitType: "", exitNote: "",
    });
    const briefFile = join(worktreePath, "plans", "brief-9.md");

    const firstOutput = main(input);
    const firstBrief = readFileSync(briefFile, "utf8");
    const secondOutput = main(input);
    const secondBrief = readFileSync(briefFile, "utf8");

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(secondBrief, firstBrief);
});

test("test_DOCUMENT_GENERATION_throwsOnAnUnknownDocsMode", () => {
    const packet = {
        box: "INIT_SUBMODULES_RECURSIVELY", scriptSignal: "continue", taskNumber: 9, runId: "run-a",
        projectRoot: "/tmp/unused", worktree: "/tmp/unused-worktree", branch: "task-9", docsMode: "",
        planFile: "", exitType: "", exitNote: "",
    };
    assert.throws(() => main(JSON.stringify(packet)), /unknown docs mode/);
});
