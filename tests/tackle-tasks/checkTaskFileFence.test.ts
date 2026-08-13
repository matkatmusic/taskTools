// Behavioral checks for scripts/tackle-tasks/checkTaskFileFence.ts. Run: node --test tests/tackle-tasks/checkTaskFileFence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkTaskFileFence } from "../../scripts/tackle-tasks/checkTaskFileFence.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";
import { git, makeCommittedRepo, addSubmodule, makeLinkedWorktree } from "./support/gitFixtures.ts";

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeCommittedRepo("check-fence-child-", "child-main");
    const rootOrigin = makeCommittedRepo("check-fence-root-", "main");
    addSubmodule(rootOrigin, childOrigin, "child");
    return rootOrigin;
}

function seedTask(rootOrigin: string, taskNumber: number, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files }]);
}

// Real gitlink move without any child file change: an empty commit changes the child's HEAD
// but no tracked file, so the child occurrence's own diff against baseRef is empty.
function moveChildGitlinkWithNoChildFileChange(worktreePath: string): void {
    const childCheckout = join(worktreePath, "child");
    git(childCheckout, "commit", "--allow-empty", "-q", "-m", "empty commit moves HEAD only");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink to an unrelated commit");
}

test("test_checkTaskFileFence_acceptsAnOwnedPathInsideASubmodule", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 20;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "add widget");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-20", taskNumber)).status, "acquired");
    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-20", rootSourceBranch: "main",
    });

    assert.equal(result.inside, true);
    assert.deepEqual(result.violations, []);
});

test("test_checkTaskFileFence_reportsAViolationForAPathTheAgentDidNotDeclare", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 21;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "add widget");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    // Undeclared edit at root, outside the task's owned files.
    writeFileSync(join(worktreePath, "sneaky.txt"), "not owned\n");
    git(worktreePath, "add", "sneaky.txt");
    git(worktreePath, "commit", "-q", "-m", "sneaky root edit");

    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-21", taskNumber)).status, "acquired");
    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-21", rootSourceBranch: "main",
    });

    assert.equal(result.inside, false);
    assert.deepEqual(result.violations, ["sneaky.txt"]);
});

// F10: a parent gitlink moved to an arbitrary commit with no owned (or any) child file change
// must not be swept in by the old blanket "every gitlink is structural" exemption.
test("test_checkTaskFileFence_reportsAParentGitlinkMovedWithNoChildChangeAsAViolation", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 22;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);

    moveChildGitlinkWithNoChildFileChange(worktreePath);

    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-22", taskNumber)).status, "acquired");
    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-22", rootSourceBranch: "main",
    });

    assert.equal(result.inside, false);
    assert.deepEqual(result.violations, ["child"]);
});

// F10: an unowned child edit reports the child's own path, and its mechanical parent gitlink
// does not become legal through the structural exemption just because the bump is mechanical.
test("test_checkTaskFileFence_reportsTheChildPathForAnUnownedChildEditAndDoesNotExemptItsGitlink", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 23;
    // Task only declares a root file - not anything inside child.
    seedTask(rootOrigin, taskNumber, ["root-only.txt"]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "add widget");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-23", taskNumber)).status, "acquired");
    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-23", rootSourceBranch: "main",
    });

    assert.equal(result.inside, false);
    assert.ok(result.violations.includes("child::widget.txt"));
    assert.ok(result.violations.includes("child"));
});

// F2 consumer half: a lock owned by another run must refuse before any diffing happens.
test("test_checkTaskFileFence_refusesAndMutatesNothingWhenTheSourceLockIsOwnedByAnotherRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 24;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);
    const otherOwner = buildLockOwner("run-other", 999);
    assert.equal(acquireSourceRepoLock(rootOrigin, otherOwner).status, "acquired");

    const headBefore = git(rootOrigin, "rev-parse", "HEAD");
    const statusBefore = git(rootOrigin, "status", "--porcelain");

    assert.throws(() => checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-24", rootSourceBranch: "main",
    }));

    assert.equal(git(rootOrigin, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(rootOrigin, "status", "--porcelain"), statusBefore);
});
