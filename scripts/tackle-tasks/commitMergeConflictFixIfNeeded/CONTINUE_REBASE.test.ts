// Behavioral checks for CONTINUE_REBASE.ts. Ported from pipeline-rebase's archived test, against the new packet contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./CONTINUE_REBASE.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { rebaseTaskWorktree } from "../shared/rebaseTaskWorktree.ts";
import { rebaseInProgress } from "../../mergeTaskWorktrees.ts";
import { createWorktreeForGroup } from "../../prepareTasks.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import { REBASE_NOT_IN_PROGRESS } from "../../resultCodes.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "CONTINUE_REBASE.template.json");

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithTestScript(branchName: string): string {
    const repoPath = tmpMkdir("continue-rebase-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    writeFileSync(join(repoPath, "shared.txt"), "base\n");
    git(repoPath, "add", "shared.txt");
    git(repoPath, "commit", "-q", "-m", "add shared.txt");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): { rootOrigin: string; rootOriginChildPath: string } {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    git(rootOrigin, "branch", "staging");
    return { rootOrigin, rootOriginChildPath: join(rootOrigin, "child") };
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function seedTaskAndMarkActive(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

function advanceSourceChildBranch(rootOrigin: string, rootOriginChildPath: string, content: string): void {
    writeFileSync(join(rootOriginChildPath, "shared.txt"), content);
    git(rootOriginChildPath, "add", "shared.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "advance source child");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");
    // CONTINUE_REBASE.ts discovers the root from "staging"; keep it pointed at the bumped gitlink.
    git(rootOrigin, "update-ref", "refs/heads/staging", "HEAD");
}

function packet(
    projectRoot: string, worktree: string, taskNumber: number, runId: string,
    stoppedOccurrenceId: string, stoppedCheckoutPath: string,
): CommitMergeConflictFixIfNeededPacket {
    return {
        box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: "continue", taskNumber, runId, projectRoot, worktree,
        branch: `task-${taskNumber}`, exitType: "", exitNote: "", message: "", additionalData: {}, stoppedOccurrenceId,
        stoppedCheckoutPath, conflictedFilePaths: [], conflicted: false, finished: false, failureReason: "",
    };
}

test("test_CONTINUE_REBASE_reportsFinishedOnlyWhenNoLayerHasARebaseInProgress", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndMarkActive(rootOrigin, taskNumber, "run-1");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const first = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "rebase-1", rootSourceBranch: "main",
    });
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const output = main(JSON.stringify(packet(
        rootOrigin, worktreePath, taskNumber, "run-1", first.stoppedAt?.occurrenceId ?? "", first.stoppedAt?.checkoutPath ?? "",
    )));

    assert.equal(output.box, "CONTINUE_REBASE");
    assert.equal(output.finished, true);
    assert.equal(output.conflicted, false);
    assert.equal(output.stoppedOccurrenceId, "");
    assert.equal(output.stoppedCheckoutPath, "");
    assert.equal(rebaseInProgress(childCheckoutPath), REBASE_NOT_IN_PROGRESS);
    assert.equal(rebaseInProgress(worktreePath), REBASE_NOT_IN_PROGRESS);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_CONTINUE_REBASE_runsTwiceWithTheSameInput", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndMarkActive(rootOrigin, taskNumber, "run-3");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const first = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-3", stepId: "rebase-3", rootSourceBranch: "main",
    });
    assert.equal(first.conflicted, true);

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const input = JSON.stringify(packet(
        rootOrigin, worktreePath, taskNumber, "run-3", first.stoppedAt?.occurrenceId ?? "", first.stoppedAt?.checkoutPath ?? "",
    ));

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const firstOutput = main(input);
    const worktreeLogAfterFirst = git(worktreePath, "log", "--format=%H %s");
    const childLogAfterFirst = git(childCheckoutPath, "log", "--format=%H %s");
    const tasksJsonAfterFirst = readFileSync(tasksPath, "utf8");

    const secondOutput = main(input);
    const worktreeLogAfterSecond = git(worktreePath, "log", "--format=%H %s");
    const childLogAfterSecond = git(childCheckoutPath, "log", "--format=%H %s");
    const tasksJsonAfterSecond = readFileSync(tasksPath, "utf8");

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(worktreeLogAfterSecond, worktreeLogAfterFirst);
    assert.equal(childLogAfterSecond, childLogAfterFirst);
    assert.equal(tasksJsonAfterSecond, tasksJsonAfterFirst);
});

test("test_CONTINUE_REBASE_reportsAFreshConflictWithoutFinishing", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndMarkActive(rootOrigin, taskNumber, "run-2");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree-1\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit 1");
    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree-2\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit 2");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const first = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-2", stepId: "rebase-2", rootSourceBranch: "main",
    });
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved-1\n");
    git(childCheckoutPath, "add", "shared.txt");

    const output = main(JSON.stringify(packet(
        rootOrigin, worktreePath, taskNumber, "run-2", first.stoppedAt?.occurrenceId ?? "", first.stoppedAt?.checkoutPath ?? "",
    )));

    assert.equal(output.finished, false);
    assert.equal(output.conflicted, true);
    assert.equal(output.stoppedOccurrenceId, "child");
    assert.deepEqual(output.conflictedFilePaths, ["shared.txt"]);
});
