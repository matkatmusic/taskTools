// Behavioral checks for scripts/tackle-tasks/occurrences.ts. Run: node --test tests/occurrences.test.ts
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
    resolveOccurrenceBaseRef,
} from "./occurrences.ts";
import type { Occurrence } from "./occurrences.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";

// git submodule add/clone needs this in a sandboxed test environment.
process.env.GIT_ALLOW_PROTOCOL = "file";

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

// The canonical source repository: a root repo with one real submodule, per global rule 9.
function makeSourceRepoWithSubmodule(): { rootOrigin: string; childOrigin: string } {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return { rootOrigin, childOrigin };
}

let nextGroupId = 1;

// The production preparer: creates task-N in both the root repo and every submodule.
function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

test("test_getOccurrencesDeepestFirst_putsTheRootLast", () => {
    // Setup: a source repo with one submodule, checked out into a real linked worktree.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);

    // Test action: walk the occurrence tree.
    const occurrences = getOccurrencesDeepestFirst(worktreePath, rootOrigin, "main");

    // Verification: the deepest occurrence (the submodule) comes first, the root comes last.
    assert.equal(occurrences.length, 2);
    assert.equal(occurrences[0].occurrenceId, "child");
    assert.equal(occurrences[occurrences.length - 1].occurrenceId, "");
});

test("test_getOccurrencesDeepestFirst_givesEachLayerItsOwnBaseRefFromTheSourceManifest", () => {
    // Setup: a source repo with an unchanged submodule, checked out into a linked worktree where both layers sit on task-N, not on their own source branches.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);

    // Test action: walk the occurrence tree, supplying the root's own source branch.
    const occurrences = getOccurrencesDeepestFirst(worktreePath, rootOrigin, "main");
    const root = occurrences.find((occurrence) => occurrence.occurrenceId === "");
    const child = occurrences.find((occurrence) => occurrence.occurrenceId === "child");

    // Verification: the root uses the supplied root source branch. The submodule resolves its own base branch from the source repository, never "" and never the shared task branch.
    assert.equal(root?.baseRef, "main");
    assert.equal(child?.baseRef, "child-main");
    assert.notEqual(child?.baseRef, "");
    assert.ok(!child?.baseRef.startsWith("task-"));
    assert.notEqual(root?.baseRef, child?.baseRef);
});

test("test_getOccurrencesDeepestFirst_keepsChildBaseRefStableAfterASubmoduleChangeAndDiffsCorrectly", () => {
    // Setup: a source repo with a submodule, checked out into a linked worktree.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);

    // Test action: commit a change on the child's task branch, then stage and commit its updated gitlink in the parent, mirroring a real task edit.
    writeFileSync(join(worktreePath, "child", "newfile.txt"), "change\n");
    git(join(worktreePath, "child"), "add", "newfile.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child change");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    const occurrences = getOccurrencesDeepestFirst(worktreePath, rootOrigin, "main");
    const child = occurrences.find((occurrence) => occurrence.occurrenceId === "child");

    // Verification: the child's base ref is still its unchanged source branch, and diffing against it (not against task-N) actually reports the submodule change.
    assert.equal(child?.baseRef, "child-main");
    const diff = git(join(worktreePath, "child"), "diff", `${child?.baseRef}...HEAD`, "--stat");
    assert.match(diff, /newfile\.txt/);
});

test("test_resolveOccurrenceBaseRef_throwsNamingTheOccurrenceWhenNoBaseIsResolvable", () => {
    // Setup: a non-root occurrence with no source-manifest base branch, checked out somewhere with no upstream tracking branch configured either.
    const checkoutPath = makeTempRepoWithCommit("detached-child");
    const occurrence = {
        occurrenceId: "child",
        checkoutPath,
        parentOccurrenceId: "",
        pathInParent: "child",
        gitlinkOid: null,
        depth: 1,
        originUrl: "",
        baseBranch: "",
        baseOid: "",
        operationBranch: "",
        childOccurrenceIds: [],
        testState: "untested" as const,
    };

    // Test action + verification: resolving the base ref throws, naming the occurrence.
    assert.throws(() => resolveOccurrenceBaseRef(occurrence, "root-base"), /child/);
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
    // Setup: a source repo with one submodule, checked out into a real linked worktree.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);

    // Test action: build the discovery manifest.
    const manifest = buildDiscoveryManifest(worktreePath, rootOrigin, "main");

    // Verification: both halves are real, populated structures, not undefined.
    assert.equal(manifest.repositoryManifest.occurrences.length, 2);
    assert.deepEqual(manifest.resolutionManifest.resolutionRequests, []);
    assert.deepEqual(manifest.resolutionManifest.resolutionAnswers, {});
    assert.deepEqual(manifest.resolutionManifest.baseReconciliationRequests, []);
    assert.deepEqual(manifest.resolutionManifest.baseReconciliationAnswers, {});
});

test("test_buildDiscoveryManifest_preservesSourceBaseBranchAndRemapsCheckoutPathsIntoTheWorktree", () => {
    // Setup: a source repo with one submodule, checked out into a real linked worktree.
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const sourceManifest = buildDiscoveryManifest(rootOrigin, rootOrigin, "main");

    // Test action: build the discovery manifest against the linked worktree.
    const manifest = buildDiscoveryManifest(worktreePath, rootOrigin, "main");

    // Verification: every occurrence keeps the source manifest's baseBranch/baseOid, but its checkoutPath is remapped to point inside the linked worktree, not the source repo.
    for (const occurrence of manifest.repositoryManifest.occurrences) {
        const sourceOccurrence = sourceManifest.repositoryManifest.occurrences.find(
            (candidate) => candidate.occurrenceId === occurrence.occurrenceId,
        );
        assert.equal(occurrence.baseBranch, sourceOccurrence?.baseBranch);
        assert.equal(occurrence.baseOid, sourceOccurrence?.baseOid);
        assert.ok(occurrence.checkoutPath.startsWith(worktreePath));
    }
});
