// Behavioral checks for scripts/steps/pipeline-rebase/REBASE_ONTO_TARGET_BRANCH.ts. Ported from tests/rebaseTaskWorktree.test.ts, against the new packet contract.  Run: node --test tests/steps/pipeline-rebase/REBASE_ONTO_TARGET_BRANCH.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-rebase/REBASE_ONTO_TARGET_BRANCH.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-rebase/REBASE_ONTO_TARGET_BRANCH.template.json");

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("rebase-onto-target-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function seedTaskAndClaim(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

function packet(projectRoot: string, worktreePath: string, taskNumber: number, runId: string, stepId: string) {
    return JSON.stringify({
        box: "SOURCE_REPO_LOCKED_INPUT", scriptSignal: "continue", projectRoot, worktreePath, taskNumber, runId, stepId,
        rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: false, stoppedOccurrenceId: "",
        stoppedCheckoutPath: "", conflictedFilePaths: [], finished: false, failureReason: "", exitType: "", exitNote: "",
    });
}

test("test_REBASE_ONTO_TARGET_BRANCH_rebasesCleanlyAndRoutesToDidRebaseReportConflicts", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-1");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");

    const output = await main(packet(rootOrigin, worktreePath, taskNumber, "run-1", "rebase-1"));

    assert.equal(output.box, "REBASE_ONTO_TARGET_BRANCH");
    assert.equal(output.conflicted, false);
    assert.equal(output.stoppedOccurrenceId, "");
    assert.equal(output.stoppedCheckoutPath, "");
    assert.equal(output.failureReason, "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_REBASE_ONTO_TARGET_BRANCH_reportsTheStoppedOccurrenceAndConflictedPathsOnAConflict", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-2");
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ x: "worktree" }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(rootOrigin, "package.json"), JSON.stringify({ x: "source" }));
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "source edit");

    const output = await main(packet(rootOrigin, worktreePath, taskNumber, "run-2", "rebase-2"));

    assert.equal(output.conflicted, true);
    assert.equal(output.stoppedOccurrenceId, "");
    assert.equal(output.stoppedCheckoutPath, worktreePath);
    assert.deepEqual(output.conflictedFilePaths, ["package.json"]);
});
