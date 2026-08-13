// Behavioral checks for scripts/tackle-tasks/occurrences.ts. Run: node --test tests/tackle-tasks/occurrences.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildDiscoveryManifest,
    buildOccurrencePath,
    buildOwnedOccurrencePaths,
    getOccurrencesDeepestFirst,
    parseOccurrencePath,
} from "../../scripts/tackle-tasks/occurrences.ts";
import type { Occurrence } from "../../scripts/tackle-tasks/occurrences.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), "occurrences-"));
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

// Builds a root repo with a real submodule, then a real linked worktree of the root with the
// submodule checked out and given its own local branch, per global rule 9 (no mocks, no
// standalone-repo stand-in for a linked worktree).
function makeWorktreeWithSubmodule(): { rootOrigin: string; worktreePath: string } {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");

    const worktreesParent = mkdtempSync(join(tmpdir(), "occurrences-worktree-"));
    const worktreePath = join(worktreesParent, "wt");
    git(rootOrigin, "worktree", "add", "-q", "-b", "task-branch", worktreePath, "main");
    git(worktreePath, "submodule", "update", "-q", "--init", "--recursive");
    git(join(worktreePath, "child"), "checkout", "-q", "child-main");

    return { rootOrigin, worktreePath };
}

test("test_getOccurrencesDeepestFirst_putsTheRootLast", () => {
    // Setup: a root repo with one submodule, checked out into a real linked worktree.
    const { rootOrigin, worktreePath } = makeWorktreeWithSubmodule();

    // Test action: walk the occurrence tree.
    const occurrences = getOccurrencesDeepestFirst(worktreePath, rootOrigin, "root-base");

    // Verification: the deepest occurrence (the submodule) comes first, the root comes last.
    assert.equal(occurrences.length, 2);
    assert.equal(occurrences[0].occurrenceId, "child");
    assert.equal(occurrences[occurrences.length - 1].occurrenceId, "");
});

test("test_getOccurrencesDeepestFirst_givesEachLayerItsOwnBaseRef", () => {
    // Setup: a root repo with one submodule whose own branch name differs from the root's.
    const { rootOrigin, worktreePath } = makeWorktreeWithSubmodule();

    // Test action: walk the occurrence tree, supplying the root's own source branch.
    const occurrences = getOccurrencesDeepestFirst(worktreePath, rootOrigin, "root-base");
    const root = occurrences.find((occurrence) => occurrence.occurrenceId === "");
    const child = occurrences.find((occurrence) => occurrence.occurrenceId === "child");

    // Verification: the root uses the supplied root source branch; the submodule resolves its
    // own base branch, and the two are not the same name.
    assert.equal(root?.baseRef, "root-base");
    assert.equal(child?.baseRef, "child-main");
    assert.notEqual(root?.baseRef, child?.baseRef);
});

test("test_buildOccurrencePath_roundTripsThroughParseOccurrencePath", () => {
    // Setup: a root path and a submodule path.
    const rootPath = "x.ts";
    const submodulePath = buildOccurrencePath("sub/a", "tests/foo.test.ts");

    // Test action: build then parse both, for the root case and the submodule case.
    const rootBuilt = buildOccurrencePath("", rootPath);
    const rootParsed = parseOccurrencePath(rootBuilt);
    const submoduleParsed = parseOccurrencePath(submodulePath);

    // Verification: parsing exactly inverts building for both cases.
    assert.equal(rootBuilt, "x.ts");
    assert.deepEqual(rootParsed, { occurrenceId: "", relativePath: "x.ts" });
    assert.deepEqual(submoduleParsed, { occurrenceId: "sub/a", relativePath: "tests/foo.test.ts" });
    assert.equal(buildOccurrencePath(submoduleParsed.occurrenceId, submoduleParsed.relativePath), submodulePath);
});

test("test_buildOwnedOccurrencePaths_convertsANestedOwnedPathIntoOccurrenceNotation", () => {
    // Setup: one root occurrence, one submodule occurrence, and task files owned by each.
    const occurrences: Occurrence[] = [
        { occurrenceId: "", checkoutPath: "/wt", depth: 0, baseRef: "main" },
        { occurrenceId: "sub/a", checkoutPath: "/wt/sub/a", depth: 1, baseRef: "sub-main" },
    ];
    const taskFiles = ["tests/root.test.ts", "sub/a/tests/foo.test.ts"];

    // Test action: convert the plain declared paths into occurrence-tagged paths.
    const ownedPaths = buildOwnedOccurrencePaths(taskFiles, occurrences);

    // Verification: the root file stays untagged; the submodule file is tagged and stripped.
    assert.deepEqual(ownedPaths, ["tests/root.test.ts", "sub/a::tests/foo.test.ts"]);
});

test("test_buildOwnedOccurrencePaths_prefersTheLongestMatchingOccurrenceId", () => {
    // Setup: two occurrences whose IDs are one a prefix of the other.
    const occurrences: Occurrence[] = [
        { occurrenceId: "", checkoutPath: "/wt", depth: 0, baseRef: "main" },
        { occurrenceId: "sub/a", checkoutPath: "/wt/sub/a", depth: 1, baseRef: "sub-a-main" },
        { occurrenceId: "sub/ab", checkoutPath: "/wt/sub/ab", depth: 1, baseRef: "sub-ab-main" },
    ];
    const taskFiles = ["sub/ab/tests/foo.test.ts"];

    // Test action: convert the declared path.
    const ownedPaths = buildOwnedOccurrencePaths(taskFiles, occurrences);

    // Verification: the path is tagged with the longer occurrence ID "sub/ab", not "sub/a".
    assert.deepEqual(ownedPaths, ["sub/ab::tests/foo.test.ts"]);
});

test("test_buildDiscoveryManifest_populatesBothSubManifests", () => {
    // Setup: a root repo with one submodule, checked out into a real linked worktree.
    const { rootOrigin, worktreePath } = makeWorktreeWithSubmodule();

    // Test action: build the discovery manifest.
    const manifest = buildDiscoveryManifest(worktreePath, rootOrigin);

    // Verification: both halves are real, populated structures, not undefined.
    assert.equal(manifest.repositoryManifest.occurrences.length, 2);
    assert.deepEqual(manifest.resolutionManifest.resolutionRequests, []);
    assert.deepEqual(manifest.resolutionManifest.resolutionAnswers, {});
    assert.deepEqual(manifest.resolutionManifest.baseReconciliationRequests, []);
    assert.deepEqual(manifest.resolutionManifest.baseReconciliationAnswers, {});
});
