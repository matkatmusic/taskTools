// resolveTaskRun.ts replaces bootstrap's "prepare" front-end. It mutates nothing.
// Run alone: node --test tests/resolveTaskRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTaskRun, parseTaskNumberArgument } from "./resolveTaskRun.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../prepareTasks.ts";
import { git, makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

function makeProjectRoot(openTasks: unknown[]): string {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    writeFileSync(join(rootOrigin, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(rootOrigin, "completedTasks.json"), JSON.stringify([]));
    git(rootOrigin, "add", "tasks.json", "completedTasks.json");
    git(rootOrigin, "commit", "-q", "-m", "seed task lists");
    return rootOrigin;
}

test("test_resolveTaskRun_createsNoWorktree", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    // Setup: a control worktree already exists, so the resolver runs in a repo that is not empty.
    makeLinkedWorktree(root);
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(root);
    const worktreeListBefore = git(root, "worktree", "list", "--porcelain");
    const branchesBefore = git(root, "branch", "--list");
    const conventionEntriesBefore = existsSync(conventionDirectory) ? readdirSync(conventionDirectory).sort() : [];

    resolveTaskRun("[1]", root);

    const worktreeListAfter = git(root, "worktree", "list", "--porcelain");
    const branchesAfter = git(root, "branch", "--list");
    const conventionEntriesAfter = existsSync(conventionDirectory) ? readdirSync(conventionDirectory).sort() : [];
    assert.equal(worktreeListAfter, worktreeListBefore, "no additional worktree should appear");
    assert.equal(branchesAfter, branchesBefore, "no additional branch should appear");
    assert.deepEqual(conventionEntriesAfter, conventionEntriesBefore, "no additional lease/dir should appear");
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

test("test_parseTaskNumberArgument_rejectsUnsafeAdjacentIntegersInsteadOfCollapsingThem", () => {
    // Setup: two distinct, huge integer tokens that would round to the same float.
    const a = "9007199254740993";
    const b = "9007199254740995";
    assert.throws(() => parseTaskNumberArgument(`${a} ${b}`), new RegExp(`invalid task number "${a}"`));
});

test("test_parseTaskNumberArgument_rejectsUnmatchedLeadingBracket", () => {
    assert.throws(() => parseTaskNumberArgument("[1"), /unmatched bracket/);
});

test("test_parseTaskNumberArgument_rejectsUnmatchedTrailingBracket", () => {
    assert.throws(() => parseTaskNumberArgument("1]"), /unmatched bracket/);
});

test("test_parseTaskNumberArgument_ignoresTextAfterClosingBracket", () => {
    assert.deepEqual(parseTaskNumberArgument("[1] valid"), [1]);
});

test("test_parseTaskNumberArgument_ignoresTextAfterClosingBracket", () => {
    assert.deepEqual(parseTaskNumberArgument("[1] valid"), [1]);
});

test("test_parseTaskNumberArgument_rejectsInnerBracketToken", () => {
    assert.throws(() => parseTaskNumberArgument("[1, [2]"), /invalid task number "\[2"/);
});

test("test_resolveTaskRun_rejectsRelativeProjectRoot", () => {
    assert.throws(() => resolveTaskRun("[1]", "relative/path"), /projectRoot must be an absolute path/);
});

test("test_resolveTaskRun_cliWorksWhenLaunchedFromAnUnrelatedWorkingDirectory", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "resolveTaskRun-cwd-"));
    const stdout = execFileSync(
        "node",
        [join(import.meta.dirname, "./resolveTaskRun.ts")],
        { input: JSON.stringify({ args: "[1]", projectRoot: root }), cwd: unrelatedCwd, encoding: "utf8" },
    );
    const output = JSON.parse(stdout);
    assert.deepEqual(output.taskNumbers, [1]);
});
