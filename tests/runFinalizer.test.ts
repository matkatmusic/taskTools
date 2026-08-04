// Behavioral checks for runFinalizer.ts: bottom-up own-files commits, durable tip refs, gitlink-bump assembly branches. Run: node --test tests/runFinalizer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runFinalizer } from "../scripts/runFinalizer.ts";
import type { FinalizationRunInput } from "../scripts/runFinalizer.ts";
import { issueRunAuthorization } from "../scripts/runAuthorization.ts";
import type { Change } from "../scripts/ownershipSnapshots.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepo(prefix: string): string {
    const repoRoot = mkdtempSync(join(tmpdir(), prefix));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    return repoRoot;
}

function commitFile(repoRoot: string, path: string, contents: string, message: string): string {
    writeFileSync(join(repoRoot, path), contents);
    git(repoRoot, "add", "--", path);
    git(repoRoot, "commit", "-q", "-m", message);
    return git(repoRoot, "rev-parse", "HEAD").trim();
}

function addSubmodule(parentRoot: string, childRoot: string, pathInParent: string): void {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(parentRoot, "submodule", "add", "-q", childRoot, pathInParent);
}

const AUTH_DIGEST = "run-state-digest";
const token = issueRunAuthorization(AUTH_DIGEST);

function runAuthorized(input: FinalizationRunInput) {
    return runFinalizer(input, token, AUTH_DIGEST);
}

test("test_ownFilesCommitContainsNoGitlinkChange", () => {
    // Scenario: parent occurrence has a gitlink plus a regular file; only the regular file changes.
    const childRoot = makeTempRepo("finalizer-child-");
    commitFile(childRoot, "seed.txt", "seed\n", "seed");
    const parentRoot = makeTempRepo("finalizer-parent-");
    commitFile(parentRoot, "app.txt", "app v1\n", "seed app");
    addSubmodule(parentRoot, childRoot, "vendor/child");
    git(parentRoot, "commit", "-q", "-m", "add submodule");
    const currentTipOid = git(parentRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(parentRoot, "app.txt"), "app v2\n");
    const change: Change = { occurrenceRoot: parentRoot, path: "app.txt", type: "modified" };

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "parent",
                repoRoot: parentRoot,
                currentTipOid,
                recordedBaseOid: currentTipOid,
                approvedOwnFileChanges: [change],
                directChildEdges: [],
            },
        ],
    });

    // Verification: the gitlink oid is identical; only app.txt differs between the two trees.
    const parentResult = result.occurrences[0];
    const originalGitlinkOid = git(parentRoot, "rev-parse", `${currentTipOid}:vendor/child`).trim();
    const newGitlinkOid = git(parentRoot, "rev-parse", `${parentResult.ownFilesCommitOid}:vendor/child`).trim();
    assert.equal(newGitlinkOid, originalGitlinkOid);
    const changedPaths = git(parentRoot, "diff", "--name-only", currentTipOid, parentResult.ownFilesCommitOid)
        .trim()
        .split("\n");
    assert.deepEqual(changedPaths, ["app.txt"]);
});

test("test_noEmptyOwnFilesCommitWhenNoApprovedChanges", () => {
    // Scenario: no approved own-file changes means no new commit object is created.
    const repoRoot = makeTempRepo("finalizer-noop-");
    const currentTipOid = commitFile(repoRoot, "seed.txt", "seed\n", "seed");

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "solo",
                repoRoot,
                currentTipOid,
                recordedBaseOid: currentTipOid,
                approvedOwnFileChanges: [],
                directChildEdges: [],
            },
        ],
    });

    // Verification.
    assert.equal(result.occurrences[0].ownFilesCommitOid, currentTipOid);
});

test("test_oneBumpCommitPerChangedDirectChildOccurrence_noneForUnchanged", () => {
    // Scenario: two direct children, one changed and one unchanged -- only the changed one gets a bump commit.
    const childARoot = makeTempRepo("finalizer-childa-");
    const childATip = commitFile(childARoot, "seed.txt", "seed\n", "seed");
    const childBRoot = makeTempRepo("finalizer-childb-");
    const childBTip = commitFile(childBRoot, "seed.txt", "seed\n", "seed");

    const parentRoot = makeTempRepo("finalizer-parent3-");
    commitFile(parentRoot, "app.txt", "app\n", "seed app");
    addSubmodule(parentRoot, childARoot, "vendor/a");
    addSubmodule(parentRoot, childBRoot, "vendor/b");
    git(parentRoot, "commit", "-q", "-m", "add submodules");
    const parentTip = git(parentRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(childARoot, "seed.txt"), "seed\nchange\n");

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "childA",
                repoRoot: childARoot,
                currentTipOid: childATip,
                recordedBaseOid: childATip,
                approvedOwnFileChanges: [{ occurrenceRoot: childARoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
            {
                occurrenceId: "childB",
                repoRoot: childBRoot,
                currentTipOid: childBTip,
                recordedBaseOid: childBTip,
                approvedOwnFileChanges: [],
                directChildEdges: [],
            },
            {
                occurrenceId: "parent",
                repoRoot: parentRoot,
                currentTipOid: parentTip,
                recordedBaseOid: parentTip,
                approvedOwnFileChanges: [],
                directChildEdges: [
                    { pathInParent: "vendor/a", childOccurrenceId: "childA" },
                    { pathInParent: "vendor/b", childOccurrenceId: "childB" },
                ],
            },
        ],
    });

    // Verification.
    const parentResult = result.occurrences.find((o) => o.occurrenceId === "parent")!;
    assert.equal(parentResult.bumpCommits.length, 1);
    assert.equal(parentResult.bumpCommits[0].pathInParent, "vendor/a");
    const commitCount = git(parentRoot, "rev-list", `${parentTip}..${parentResult.finalizedIntegrationOid}`)
        .trim()
        .split("\n")
        .filter(Boolean).length;
    assert.equal(commitCount, 1);
});

test("test_multipleGitlinksToSameChildAllUpdatedToSameOid", () => {
    // Scenario: two gitlinks at different paths point at the same child occurrence.
    const childRoot = makeTempRepo("finalizer-child4-");
    const childTip = commitFile(childRoot, "seed.txt", "seed\n", "seed");

    const parentRoot = makeTempRepo("finalizer-parent4-");
    commitFile(parentRoot, "app.txt", "app\n", "seed app");
    addSubmodule(parentRoot, childRoot, "vendor/a1");
    addSubmodule(parentRoot, childRoot, "vendor/a2");
    git(parentRoot, "commit", "-q", "-m", "add submodules twice");
    const parentTip = git(parentRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(childRoot, "seed.txt"), "seed\nchange\n");

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "child",
                repoRoot: childRoot,
                currentTipOid: childTip,
                recordedBaseOid: childTip,
                approvedOwnFileChanges: [{ occurrenceRoot: childRoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
            {
                occurrenceId: "parent",
                repoRoot: parentRoot,
                currentTipOid: parentTip,
                recordedBaseOid: parentTip,
                approvedOwnFileChanges: [],
                directChildEdges: [
                    { pathInParent: "vendor/a1", childOccurrenceId: "child" },
                    { pathInParent: "vendor/a2", childOccurrenceId: "child" },
                ],
            },
        ],
    });

    // Verification: both paths updated to the child's finalizedIntegrationOid, one bump per path.
    const childResult = result.occurrences.find((o) => o.occurrenceId === "child")!;
    const parentResult = result.occurrences.find((o) => o.occurrenceId === "parent")!;
    assert.equal(parentResult.bumpCommits.length, 2);
    const a1Oid = git(parentRoot, "rev-parse", `${parentResult.finalizedIntegrationOid}:vendor/a1`).trim();
    const a2Oid = git(parentRoot, "rev-parse", `${parentResult.finalizedIntegrationOid}:vendor/a2`).trim();
    assert.equal(a1Oid, childResult.finalizedIntegrationOid);
    assert.equal(a2Oid, childResult.finalizedIntegrationOid);
});

test("test_bumpCommitsOrderedByPathWithinParent", () => {
    // Scenario: two changed gitlinks declared out of order must be bumped in path order.
    const childARoot = makeTempRepo("finalizer-childa5-");
    const childATip = commitFile(childARoot, "seed.txt", "seed\n", "seed");
    const childBRoot = makeTempRepo("finalizer-childb5-");
    const childBTip = commitFile(childBRoot, "seed.txt", "seed\n", "seed");

    const parentRoot = makeTempRepo("finalizer-parent5-");
    commitFile(parentRoot, "app.txt", "app\n", "seed app");
    addSubmodule(parentRoot, childBRoot, "b/child");
    addSubmodule(parentRoot, childARoot, "a/child");
    git(parentRoot, "commit", "-q", "-m", "add submodules");
    const parentTip = git(parentRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(childARoot, "seed.txt"), "seed\nchange\n");
    writeFileSync(join(childBRoot, "seed.txt"), "seed\nchange\n");

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "childA",
                repoRoot: childARoot,
                currentTipOid: childATip,
                recordedBaseOid: childATip,
                approvedOwnFileChanges: [{ occurrenceRoot: childARoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
            {
                occurrenceId: "childB",
                repoRoot: childBRoot,
                currentTipOid: childBTip,
                recordedBaseOid: childBTip,
                approvedOwnFileChanges: [{ occurrenceRoot: childBRoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
            {
                occurrenceId: "parent",
                repoRoot: parentRoot,
                currentTipOid: parentTip,
                recordedBaseOid: parentTip,
                approvedOwnFileChanges: [],
                directChildEdges: [
                    { pathInParent: "b/child", childOccurrenceId: "childB" },
                    { pathInParent: "a/child", childOccurrenceId: "childA" },
                ],
            },
        ],
    });

    // Verification.
    const parentResult = result.occurrences.find((o) => o.occurrenceId === "parent")!;
    assert.deepEqual(parentResult.bumpCommits.map((b) => b.pathInParent), ["a/child", "b/child"]);
});

test("test_nestedChildOidsPropagateThroughEachExplicitParentEdgeToRoot", () => {
    // Scenario: root -> mid -> leaf, each linked by an explicit directChildEdges entry; leaf changes.
    const leafRoot = makeTempRepo("finalizer-leaf6-");
    const leafTip = commitFile(leafRoot, "seed.txt", "seed\n", "seed");

    const midRoot = makeTempRepo("finalizer-mid6-");
    commitFile(midRoot, "mid.txt", "mid\n", "seed mid");
    addSubmodule(midRoot, leafRoot, "vendor/leaf");
    git(midRoot, "commit", "-q", "-m", "add leaf submodule");
    const midTip = git(midRoot, "rev-parse", "HEAD").trim();

    const rootRoot = makeTempRepo("finalizer-root6-");
    commitFile(rootRoot, "root.txt", "root\n", "seed root");
    addSubmodule(rootRoot, midRoot, "vendor/mid");
    git(rootRoot, "commit", "-q", "-m", "add mid submodule");
    const rootTip = git(rootRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(leafRoot, "seed.txt"), "seed\nchange\n");

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "leaf",
                repoRoot: leafRoot,
                currentTipOid: leafTip,
                recordedBaseOid: leafTip,
                approvedOwnFileChanges: [{ occurrenceRoot: leafRoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
            {
                occurrenceId: "mid",
                repoRoot: midRoot,
                currentTipOid: midTip,
                recordedBaseOid: midTip,
                approvedOwnFileChanges: [],
                directChildEdges: [{ pathInParent: "vendor/leaf", childOccurrenceId: "leaf" }],
            },
            {
                occurrenceId: "root",
                repoRoot: rootRoot,
                currentTipOid: rootTip,
                recordedBaseOid: rootTip,
                approvedOwnFileChanges: [],
                directChildEdges: [{ pathInParent: "vendor/mid", childOccurrenceId: "mid" }],
            },
        ],
    });

    // Verification: propagation is real, not two independently-equal values.
    const leafResult = result.occurrences.find((o) => o.occurrenceId === "leaf")!;
    const midResult = result.occurrences.find((o) => o.occurrenceId === "mid")!;
    const rootResult = result.occurrences.find((o) => o.occurrenceId === "root")!;

    assert.notEqual(midResult.finalizedIntegrationOid, midTip);
    const leafOidFromMid = git(midRoot, "rev-parse", `${midResult.finalizedIntegrationOid}:vendor/leaf`).trim();
    assert.equal(leafOidFromMid, leafResult.finalizedIntegrationOid);

    const midOidFromRoot = git(rootRoot, "rev-parse", `${rootResult.finalizedIntegrationOid}:vendor/mid`).trim();
    assert.equal(midOidFromRoot, midResult.finalizedIntegrationOid);
    const leafOidFromMidViaRoot = git(midRoot, "rev-parse", `${midOidFromRoot}:vendor/leaf`).trim();
    assert.equal(leafOidFromMidViaRoot, leafResult.finalizedIntegrationOid);
});

test("test_durableRefsExistForEveryOccurrenceTip", () => {
    // Scenario: mix of empty and nonempty own-file changes across occurrences.
    const repoARoot = makeTempRepo("finalizer-refsa-");
    const repoATip = commitFile(repoARoot, "seed.txt", "seed\n", "seed");
    const repoBRoot = makeTempRepo("finalizer-refsb-");
    const repoBTip = commitFile(repoBRoot, "seed.txt", "seed\n", "seed");
    writeFileSync(join(repoARoot, "seed.txt"), "seed\nchange\n");

    // Test action.
    const result = runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "a",
                repoRoot: repoARoot,
                currentTipOid: repoATip,
                recordedBaseOid: repoATip,
                approvedOwnFileChanges: [{ occurrenceRoot: repoARoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
            {
                occurrenceId: "b",
                repoRoot: repoBRoot,
                currentTipOid: repoBTip,
                recordedBaseOid: repoBTip,
                approvedOwnFileChanges: [],
                directChildEdges: [],
            },
        ],
    });

    // Verification: every durable ref resolves to the returned ownFilesCommitOid.
    for (const occurrenceResult of result.occurrences) {
        const repoRoot = occurrenceResult.occurrenceId === "a" ? repoARoot : repoBRoot;
        const resolved = git(repoRoot, "rev-parse", occurrenceResult.durableTipRef).trim();
        assert.equal(resolved, occurrenceResult.ownFilesCommitOid);
    }
});

test("test_baseRefsAreProvablyUnchanged", () => {
    // Scenario: real branch refs must be provably untouched by the run.
    const repoRoot = makeTempRepo("finalizer-baserefs-");
    const tip = commitFile(repoRoot, "seed.txt", "seed\n", "seed");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\nchange\n");
    const branchesBefore = git(repoRoot, "for-each-ref", "refs/heads");
    const nonFinalizeRefsBefore = git(repoRoot, "for-each-ref")
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.includes("refs/finalize/"));

    // Test action.
    runAuthorized({
        runId: `run-${randomUUID()}`,
        occurrences: [
            {
                occurrenceId: "solo",
                repoRoot,
                currentTipOid: tip,
                recordedBaseOid: tip,
                approvedOwnFileChanges: [{ occurrenceRoot: repoRoot, path: "seed.txt", type: "modified" }],
                directChildEdges: [],
            },
        ],
    });

    // Verification: refs/heads byte-identical; nothing outside refs/finalize/... appeared.
    assert.equal(git(repoRoot, "for-each-ref", "refs/heads"), branchesBefore);
    const nonFinalizeRefsAfter = git(repoRoot, "for-each-ref")
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.includes("refs/finalize/"));
    assert.deepEqual(nonFinalizeRefsAfter, nonFinalizeRefsBefore);
});

test("test_unauthorizedRunIsRejected", () => {
    // Scenario: an authorization token whose digest no longer matches must reject the whole run.
    const repoRoot = makeTempRepo("finalizer-unauth-");
    const tip = commitFile(repoRoot, "seed.txt", "seed\n", "seed");
    const runId = `run-${randomUUID()}`;
    const input: FinalizationRunInput = {
        runId,
        occurrences: [
            {
                occurrenceId: "solo",
                repoRoot,
                currentTipOid: tip,
                recordedBaseOid: tip,
                approvedOwnFileChanges: [],
                directChildEdges: [],
            },
        ],
    };

    // Test action + verification.
    assert.throws(() => runFinalizer(input, token, "wrong-digest"));
    const finalizeRefs = git(repoRoot, "for-each-ref", `refs/finalize/${runId}`).trim();
    assert.equal(finalizeRefs, "");
});
