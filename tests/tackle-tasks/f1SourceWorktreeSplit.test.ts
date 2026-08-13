// F1 regressions: the rebase path must keep the source checkout and the task worktree checkout
// distinct, fetch base branches from the real local source checkout (never origin, since its
// commits may be unpushed), and never let discovery ls-tree a source-only OID inside the
// worktree before that fetch happens. Run: node --test tests/tackle-tasks/f1SourceWorktreeSplit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSubmodule, git, makeCommittedRepo, makeLinkedWorktree } from "./support/gitFixtures.ts";
import { rebaseWorktreeSubmoduleLayersDeepestFirst } from "../../scripts/tackle-tasks/occurrences.ts";

function makeCommittedRepoWithTestScript(prefix: string): string {
    const repoPath = makeCommittedRepo(prefix);
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "add test script");
    return repoPath;
}

let nextTaskNumber = 900_000;

test("test_rebaseWorktreeSubmoduleLayersDeepestFirst_rebasesOntoALocalUnpushedSourceSubmoduleAdvance", () => {
    // Setup: source root with one real submodule, and a real linked task worktree of it.
    const childOrigin = makeCommittedRepoWithTestScript("f1-child-origin-");
    const rootOrigin = makeCommittedRepo("f1-root-");
    const rootOriginChildPath = addSubmodule(rootOrigin, childOrigin, "child");
    const taskNumber = nextTaskNumber++;
    const worktreePath = makeLinkedWorktree(rootOrigin, taskNumber);
    const worktreeChildPath = join(worktreePath, "child");

    // Independently commit in the source's child checkout AFTER the worktree already exists, and
    // never push it to the submodule's own origin remote (childOrigin).
    writeFileSync(join(rootOriginChildPath, "source-advance.txt"), "source advance\n");
    git(rootOriginChildPath, "add", "source-advance.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "source advance");
    const sourceAdvanceOid = git(rootOriginChildPath, "rev-parse", "HEAD");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");

    // The advance was never pushed anywhere the worktree's submodule remote (origin) can see.
    assert.throws(() => git(childOrigin, "cat-file", "-e", sourceAdvanceOid));

    // Add a divergent task-submodule commit on the worktree's own task branch.
    writeFileSync(join(worktreeChildPath, "task-work.txt"), "task work\n");
    git(worktreeChildPath, "add", "task-work.txt");
    git(worktreeChildPath, "commit", "-q", "-m", "task work");

    // Test action: rebase using the real local source checkout, not origin.
    const report = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, rootOrigin, taskNumber);

    // Verification: the rebase completed, and the new source commit is now an ancestor of the
    // rebased task-submodule HEAD - proving the fetch came from the source checkout, not origin.
    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested"]);
    assert.doesNotThrow(() => git(worktreeChildPath, "merge-base", "--is-ancestor", sourceAdvanceOid, "HEAD"));
});

test("test_rebaseWorktreeSubmoduleLayersDeepestFirst_reportsAConflictNamingTheSubmoduleWithSubmoduleRelativePaths", () => {
    // Setup: source root with a submodule that has a file both sides will edit.
    const childOrigin = makeCommittedRepoWithTestScript("f1-child-origin-");
    writeFileSync(join(childOrigin, "conflict.txt"), "base\n");
    git(childOrigin, "add", "conflict.txt");
    git(childOrigin, "commit", "-q", "-m", "add conflict.txt");
    const rootOrigin = makeCommittedRepo("f1-root-");
    const rootOriginChildPath = addSubmodule(rootOrigin, childOrigin, "child");
    const taskNumber = nextTaskNumber++;
    const worktreePath = makeLinkedWorktree(rootOrigin, taskNumber);
    const worktreeChildPath = join(worktreePath, "child");

    // Conflicting source-side edit, committed and gitlink-bumped after the worktree exists.
    writeFileSync(join(rootOriginChildPath, "conflict.txt"), "source-change\n");
    git(rootOriginChildPath, "add", "conflict.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "source edit");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");

    // Conflicting task-side edit to the same file, on the worktree's task branch.
    writeFileSync(join(worktreeChildPath, "conflict.txt"), "task-change\n");
    git(worktreeChildPath, "add", "conflict.txt");
    git(worktreeChildPath, "commit", "-q", "-m", "task edit");

    // Test action.
    const report = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, rootOrigin, taskNumber);

    // Verification: stoppedAt names the submodule occurrence, and the conflicted path is
    // relative to that submodule, not prefixed with the worktree or submodule path.
    assert.notEqual(report.stoppedAt, null);
    assert.equal(report.stoppedAt?.status, "conflicted");
    assert.equal(report.stoppedAt?.occurrenceId, "child");
    assert.deepEqual(
        report.stoppedAt?.status === "conflicted" ? report.stoppedAt.conflictedFilePaths : [],
        ["conflict.txt"],
    );
});

test("test_rebaseWorktreeSubmoduleLayersDeepestFirst_rebasesANestedGrandchildSubmoduleOntoALocalUnpushedSourceAdvance", () => {
    // Setup: real root -> child -> grandchild, so the source/worktree mapping is proven at
    // more than one depth (F9's fixture requirement, exercised here for F1).
    const grandchildOrigin = makeCommittedRepoWithTestScript("f1-grandchild-origin-");
    const childOrigin = makeCommittedRepoWithTestScript("f1-child-origin-");
    const childOriginGrandchildPath = addSubmodule(childOrigin, grandchildOrigin, "grandchild");
    const rootOrigin = makeCommittedRepo("f1-root-");
    addSubmodule(rootOrigin, childOrigin, "child");
    git(rootOrigin, "submodule", "update", "--init", "--recursive", "-q");
    const rootOriginGrandchildPath = join(rootOrigin, "child", "grandchild");

    const taskNumber = nextTaskNumber++;
    const worktreePath = makeLinkedWorktree(rootOrigin, taskNumber);
    const worktreeGrandchildPath = join(worktreePath, "child", "grandchild");

    // `submodule update --init --recursive` leaves the grandchild in detached HEAD; commit on
    // its real local branch instead, since baseBranch resolution requires a named branch tip.
    git(rootOriginGrandchildPath, "checkout", "-q", git(grandchildOrigin, "symbolic-ref", "--short", "HEAD"));

    // Advance the grandchild's source directly, past the worktree's grandchild checkout, and
    // propagate the gitlink bump up through child and root - never pushed to grandchildOrigin.
    writeFileSync(join(rootOriginGrandchildPath, "source-advance.txt"), "source advance\n");
    git(rootOriginGrandchildPath, "add", "source-advance.txt");
    git(rootOriginGrandchildPath, "commit", "-q", "-m", "source advance");
    const sourceAdvanceOid = git(rootOriginGrandchildPath, "rev-parse", "HEAD");
    git(join(rootOrigin, "child"), "add", "grandchild");
    git(join(rootOrigin, "child"), "commit", "-q", "-m", "bump grandchild gitlink");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");

    assert.throws(() => git(grandchildOrigin, "cat-file", "-e", sourceAdvanceOid));
    assert.throws(() => git(childOriginGrandchildPath, "cat-file", "-e", sourceAdvanceOid));

    // Divergent task-submodule commit at the grandchild depth.
    writeFileSync(join(worktreeGrandchildPath, "task-work.txt"), "task work\n");
    git(worktreeGrandchildPath, "add", "task-work.txt");
    git(worktreeGrandchildPath, "commit", "-q", "-m", "task work");

    // Test action: discovery must fetch the grandchild's source-only OID into the worktree
    // grandchild checkout before ever ls-tree'ing it there.
    const report = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, rootOrigin, taskNumber);

    // Verification: both layers rebase clean, deepest (grandchild) first, and the new source
    // commit is an ancestor of the rebased grandchild HEAD.
    assert.equal(report.stoppedAt, null);
    assert.deepEqual(
        report.completedLayers.map((layer) => layer.occurrenceId).sort(),
        ["child", "child/grandchild"],
    );
    assert.doesNotThrow(() => git(worktreeGrandchildPath, "merge-base", "--is-ancestor", sourceAdvanceOid, "HEAD"));
});
