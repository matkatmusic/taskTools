// Behavioral checks for scripts/tackle-tasks/checkTaskFileFence.ts. Run: node --test tests/checkTaskFileFence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { checkTaskFileFence } from "./checkTaskFileFence.ts";
import { acquireSourceRepoLock, buildLockOwner } from "./sourceRepoLock.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { git, makeCommittedRepo, addSubmodule, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeCommittedRepo("check-fence-child-", "child-main");
    const rootOrigin = makeCommittedRepo("check-fence-root-", "main");
    addSubmodule(rootOrigin, childOrigin, "child");
    return rootOrigin;
}

function seedTask(rootOrigin: string, taskNumber: number, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", modifiableFiles: files }]);
}

// Empty commit moves the child's gitlink HEAD but changes no tracked file, so its diff against baseRef is empty.
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

test("test_checkTaskFileFence_acceptsAnOwnedPathDeclaredUnderModifiableFilesInsteadOfLegacyFiles", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 27;
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", modifiableFiles: ["child/widget.txt"] }]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "add widget");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-27", taskNumber)).status, "acquired");
    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-27", rootSourceBranch: "main",
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

// F10: a parent gitlink moved with no owned child file change must not pass the blanket structural exemption.
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

// F10: an unowned child edit reports the child's path; its mechanical parent gitlink stays illegal despite the structural exemption.
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

// M1/F2: a relative projectRoot must be rejected before any git command or lock access runs.
test("test_checkTaskFileFence_rejectsARelativeProjectRootBeforeGitOrLockAccess", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 25;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-25", taskNumber)).status, "acquired");

    const headBefore = git(rootOrigin, "rev-parse", "HEAD");
    const statusBefore = git(rootOrigin, "status", "--porcelain");
    const relativeProjectRoot = relative(process.cwd(), rootOrigin);

    assert.throws(
        () => checkTaskFileFence({
            projectRoot: relativeProjectRoot, worktreePath, taskNumber, runId: "run-25", rootSourceBranch: "main",
        }),
        /must be an absolute path/,
    );

    assert.equal(git(rootOrigin, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(rootOrigin, "status", "--porcelain"), statusBefore);
});

// M1/F2: a relative worktreePath must be rejected before any git command or lock access runs.
test("test_checkTaskFileFence_rejectsARelativeWorktreePathBeforeGitOrLockAccess", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 26;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-26", taskNumber)).status, "acquired");

    const headBefore = git(rootOrigin, "rev-parse", "HEAD");
    const statusBefore = git(rootOrigin, "status", "--porcelain");
    const relativeWorktreePath = relative(process.cwd(), worktreePath);

    assert.throws(
        () => checkTaskFileFence({
            projectRoot: rootOrigin, worktreePath: relativeWorktreePath, taskNumber, runId: "run-26", rootSourceBranch: "main",
        }),
        /must be an absolute path/,
    );

    assert.equal(git(rootOrigin, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(rootOrigin, "status", "--porcelain"), statusBefore);
});

test("test_checkTaskFileFence_acceptsAnyPathWhenTheTaskDeclaresAWildcard", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 113;
    seedTask(rootOrigin, taskNumber, ["*"]);

    writeFileSync(join(worktreePath, "anywhere.txt"), "moved here\n");
    git(worktreePath, "add", "anywhere.txt");
    git(worktreePath, "commit", "-q", "-m", "undeclared root edit");

    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner("run-113", taskNumber)).status, "acquired");
    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-113", rootSourceBranch: "main",
    });

    assert.equal(result.inside, true);
    assert.deepEqual(result.violations, []);
});
