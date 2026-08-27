// Behavioral checks for REBASE_ONTO_TARGET_BRANCH.ts, against real git repos. Run: node --test scripts/tackle-tasks/rebase/REBASE_ONTO_TARGET_BRANCH.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./REBASE_ONTO_TARGET_BRANCH.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { createTaskWorktree } from "../shared/createTaskWorktree.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "REBASE_ONTO_TARGET_BRANCH.template.json");

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "rebase-onto-target-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "seed");
    return root;
}

function seedTasksFile(root: string, taskNumber: number): void {
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber, title: "t", files: [] }]));
}

function packet(projectRoot: string, worktree: string, taskNumber: number, runId: string): string {
    return JSON.stringify({
        box: "WAS_LOCK_ACQUIRED_Q", scriptSignal: "continue", taskNumber, runId, projectRoot, worktree,
        branch: `task-${taskNumber}`, exitType: "", exitNote: "",
    });
}

test("test_REBASE_ONTO_TARGET_BRANCH_rebasesCleanlyAndRoutesToDidRebaseReportConflicts", async () => {
    const root = makeProjectRoot();
    seedTasksFile(root, 1);
    claimTask(1, "run-1", root);
    const { worktree } = createTaskWorktree(1, "run-1", root);

    writeFileSync(join(worktree, "task-work.txt"), "task work\n");
    git(worktree, "add", "task-work.txt");
    git(worktree, "commit", "-q", "-m", "task work");

    const output = await main(packet(root, worktree, 1, "run-1"));

    assert.equal(output.box, "REBASE_ONTO_TARGET_BRANCH");
    assert.equal(output.conflicted, false);
    assert.equal(output.stoppedOccurrenceId, "");
    assert.equal(output.stoppedCheckoutPath, "");
    assert.equal(output.failureReason, "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_REBASE_ONTO_TARGET_BRANCH_reportsTheStoppedOccurrenceAndConflictedPathsOnAConflict", async () => {
    const root = makeProjectRoot();
    seedTasksFile(root, 2);
    claimTask(2, "run-2", root);
    const { worktree } = createTaskWorktree(2, "run-2", root);

    writeFileSync(join(worktree, "package.json"), JSON.stringify({ x: "worktree" }));
    git(worktree, "add", "package.json");
    git(worktree, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(root, "package.json"), JSON.stringify({ x: "source" }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "source edit");

    const output = await main(packet(root, worktree, 2, "run-2"));

    assert.equal(output.conflicted, true);
    assert.equal(output.stoppedOccurrenceId, "");
    assert.equal(output.stoppedCheckoutPath, worktree);
    assert.deepEqual(output.conflictedFilePaths, ["package.json"]);
});
