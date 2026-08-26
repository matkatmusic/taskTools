// Behavioral checks for scripts/steps/pipeline-implement/COMMIT_IMPLEMENTATION_IF_NEEDED.ts, against a temp git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMatchesTemplate } from "../../../scripts/contracts.ts";
import { main } from "../../../scripts/steps/pipeline-implement/COMMIT_IMPLEMENTATION_IF_NEEDED.ts";
import { claimTask, getCurrentTaskRun } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempGitRepo(prefix: string): string {
    const repoPath = tmpMkdir(prefix);
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

// projectRoot (task state) and worktreePath (the checkout being committed) are separate repos,
// exactly like the real setup, so writing tasks.json never dirties the worktree under test.
function makeFixture(taskNumber: number): { projectRoot: string; worktreePath: string } {
    const projectRoot = makeTempGitRepo("commit-implementation-if-needed-root-");
    const worktreePath = makeTempGitRepo("commit-implementation-if-needed-worktree-");
    writeJsonAtomically(join(projectRoot, "tasks.json"), [{ taskNumber, title: "widget", files: [] }]);
    const outcome = claimTask(taskNumber, "run-1", projectRoot);
    assert.equal(outcome.status, "claimed");
    return { projectRoot, worktreePath };
}

test("test_main_commitsADirtyWorktreeAndReturnsTheCommitEnvelope", () => {
    const taskNumber = 9101;
    const { projectRoot, worktreePath } = makeFixture(taskNumber);
    writeFileSync(join(worktreePath, "widget.txt"), "widget\n");

    const input = { projectRoot, worktreePath, taskNumber, runId: "run-1", sourceBranch: "main" };
    const output = main(JSON.stringify(input));

    assert.equal(output.box, "COMMIT_IMPLEMENTATION_IF_NEEDED");
    assert.equal(output.scriptSignal, "continue");
    assert.equal((output.commits as unknown[]).length, 1);
    assert.equal(getCurrentTaskRun(taskNumber, projectRoot)?.commits.length, 1);
});

test("test_main_returnsNoCommitsWhenTheWorktreeIsClean", () => {
    const taskNumber = 9102;
    const { projectRoot, worktreePath } = makeFixture(taskNumber);

    const input = { projectRoot, worktreePath, taskNumber, runId: "run-1", sourceBranch: "main" };
    const output = main(JSON.stringify(input));

    assert.deepEqual(output.commits, []);
});

test("test_main_matchesItsOwnTemplateShape", () => {
    const taskNumber = 9103;
    const { projectRoot, worktreePath } = makeFixture(taskNumber);
    writeFileSync(join(worktreePath, "widget.txt"), "widget\n");
    const input = { projectRoot, worktreePath, taskNumber, runId: "run-1", sourceBranch: "main" };
    const output = main(JSON.stringify(input));
    assertMatchesTemplate("COMMIT_IMPLEMENTATION_IF_NEEDED", {
        box: "", scriptSignal: "", ...input,
        commits: [{ occurrenceId: "", hash: "", kind: "work", stepId: "" }],
    }, output);
});
