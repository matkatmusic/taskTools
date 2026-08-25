// Behavioral checks for scripts/steps/pipeline-rebase/CONTINUE_REBASE.ts. Ported from tests/advanceTaskRebase.test.ts, against the new packet contract.  Run: node --test tests/steps/pipeline-rebase/CONTINUE_REBASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as rebaseOntoTargetBranch } from "../../../scripts/steps/pipeline-rebase/REBASE_ONTO_TARGET_BRANCH.ts";
import { main } from "../../../scripts/steps/pipeline-rebase/CONTINUE_REBASE.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { rebaseInProgress } from "../../../scripts/mergeTaskWorktrees.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-rebase/CONTINUE_REBASE.template.json");

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
    return { rootOrigin, rootOriginChildPath: join(rootOrigin, "child") };
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

function advanceSourceChildBranch(rootOrigin: string, rootOriginChildPath: string, content: string): void {
    writeFileSync(join(rootOriginChildPath, "shared.txt"), content);
    git(rootOriginChildPath, "add", "shared.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "advance source child");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");
}

function packet(projectRoot: string, worktreePath: string, taskNumber: number, runId: string, stepId: string) {
    return JSON.stringify({
        box: "SOURCE_REPO_LOCKED_INPUT", scriptSignal: "continue", projectRoot, worktreePath, taskNumber, runId, stepId,
        rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: false, stoppedOccurrenceId: "",
        stoppedCheckoutPath: "", conflictedFilePaths: [], finished: false, failureReason: "", exitType: "", exitNote: "",
    });
}

test("test_CONTINUE_REBASE_reportsFinishedOnlyWhenNoLayerHasARebaseInProgress", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-1");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const first = await rebaseOntoTargetBranch(packet(rootOrigin, worktreePath, taskNumber, "run-1", "rebase-1"));
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedOccurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = main(JSON.stringify(first)) as RebasePacket;

    assert.equal(second.box, "CONTINUE_REBASE");
    assert.equal(second.finished, true);
    assert.equal(second.conflicted, false);
    assert.equal(second.stoppedOccurrenceId, "");
    assert.equal(second.stoppedCheckoutPath, "");
    assert.equal(rebaseInProgress(childCheckoutPath), false);
    assert.equal(rebaseInProgress(worktreePath), false);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, second), []);
});

test("test_CONTINUE_REBASE_reportsAFreshConflictWithoutFinishing", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-2");
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

    const first = await rebaseOntoTargetBranch(packet(rootOrigin, worktreePath, taskNumber, "run-2", "rebase-2"));
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedOccurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved-1\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = main(JSON.stringify(first)) as RebasePacket;

    assert.equal(second.finished, false);
    assert.equal(second.conflicted, true);
    assert.equal(second.stoppedOccurrenceId, "child");
    assert.deepEqual(second.conflictedFilePaths, ["shared.txt"]);
});
