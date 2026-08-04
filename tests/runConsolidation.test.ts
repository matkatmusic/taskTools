// Behavioral checks for runConsolidation.ts. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    consolidateLogicalRepository,
    consolidateRun,
} from "../scripts/runConsolidation.ts";
import type { GroupOccurrenceBranch, LogicalRepositoryConsolidationInput } from "../scripts/runConsolidation.ts";
import { issueRunAuthorization } from "../scripts/runAuthorization.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "run-consolidation-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

// Builds a repo with a base commit and two branches (groupA/repo, groupB/repo) editing disjoint files.
function makeDisjointTwoGroupFixture(): {
    repoRoot: string;
    baseOid: string;
    groupA: GroupOccurrenceBranch;
    groupB: GroupOccurrenceBranch;
    convergedTreeOid: string;
} {
    const repoRoot = makeTempRepoWithCommit();
    const baseOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", "-b", "groupA/repo");
    writeFileSync(join(repoRoot, "a.txt"), "a\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-q", "-m", "add a.txt");
    const groupABranchOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", baseOid);
    git(repoRoot, "checkout", "-q", "-b", "groupB/repo");
    writeFileSync(join(repoRoot, "b.txt"), "b\n");
    git(repoRoot, "add", "b.txt");
    git(repoRoot, "commit", "-q", "-m", "add b.txt");
    const groupBBranchOid = git(repoRoot, "rev-parse", "HEAD");

    const convergedTreeOid = git(repoRoot, "merge-tree", "--write-tree", groupABranchOid, groupBBranchOid);

    git(repoRoot, "checkout", "-q", "master");

    const groupA: GroupOccurrenceBranch = {
        groupId: "groupA",
        occurrencePath: "repo",
        occurrenceId: "occ-a",
        branchOid: groupABranchOid,
        sourceRepoRoot: repoRoot,
    };
    const groupB: GroupOccurrenceBranch = {
        groupId: "groupB",
        occurrencePath: "repo",
        occurrenceId: "occ-b",
        branchOid: groupBBranchOid,
        sourceRepoRoot: repoRoot,
    };
    return { repoRoot, baseOid, groupA, groupB, convergedTreeOid };
}

function makeInput(
    fixture: ReturnType<typeof makeDisjointTwoGroupFixture>,
    overrides: Partial<LogicalRepositoryConsolidationInput> = {},
): LogicalRepositoryConsolidationInput {
    return {
        logicalRepositoryId: "logical-repo-1",
        canonicalRepoRoot: fixture.repoRoot,
        canonicalOccurrenceBranchName: "groupB/repo",
        participatingBranches: [fixture.groupA, fixture.groupB],
        approvedConvergedTreeOid: fixture.convergedTreeOid,
        finalizedChildGitlinks: [],
        recordedBaseOid: fixture.baseOid,
        baseBranchRef: "refs/heads/master",
        ...overrides,
    };
}

test("test_twoDisjointGroupsBecomeAncestorsOfOneOperationBranch", () => {
    const fixture = makeDisjointTwoGroupFixture();
    const input = makeInput(fixture);
    const result = consolidateLogicalRepository(input, "run-1");
    assert.equal("aborted" in result, false);
    if ("aborted" in result) return;
    assert.doesNotThrow(() =>
        git(fixture.repoRoot, "merge-base", "--is-ancestor", fixture.groupA.branchOid, result.operationOid),
    );
    assert.doesNotThrow(() =>
        git(fixture.repoRoot, "merge-base", "--is-ancestor", fixture.groupB.branchOid, result.operationOid),
    );
});

test("test_mergeOrderIsDeterministic", () => {
    const fixture = makeDisjointTwoGroupFixture();
    const inputForward = makeInput(fixture, {
        participatingBranches: [fixture.groupA, fixture.groupB],
    });
    const inputReversed = makeInput(fixture, {
        participatingBranches: [fixture.groupB, fixture.groupA],
    });
    const resultForward = consolidateLogicalRepository(inputForward, "run-2");
    // Forward call fast-forwarded the occurrence branches; reset them before the reversed call.
    git(fixture.repoRoot, "update-ref", "refs/heads/groupA/repo", fixture.groupA.branchOid);
    git(fixture.repoRoot, "update-ref", "refs/heads/groupB/repo", fixture.groupB.branchOid);
    const resultReversed = consolidateLogicalRepository(inputReversed, "run-2");
    if ("aborted" in resultForward || "aborted" in resultReversed) {
        assert.fail("expected both calls to succeed");
        return;
    }
    assert.equal(resultForward.operationOid, resultReversed.operationOid);
});

test("test_treeMismatchAbortsWithEveryRefPreserved", () => {
    const fixture = makeDisjointTwoGroupFixture();
    const wrongTreeOid = git(fixture.repoRoot, "rev-parse", `${fixture.baseOid}^{tree}`);
    const input = makeInput(fixture, { approvedConvergedTreeOid: wrongTreeOid });
    const result = consolidateLogicalRepository(input, "run-3");
    assert.ok("aborted" in result);
    if (!("aborted" in result)) return;
    assert.equal(result.aborted.reason, "tree-mismatch");
    assert.equal("conflicts" in result.aborted, false);
    const operationBranchRef = `refs/heads/operations/run-3/${input.canonicalOccurrenceBranchName}`;
    assert.throws(() => git(fixture.repoRoot, "show-ref", "--verify", operationBranchRef));
    assert.equal(git(fixture.repoRoot, "rev-parse", "refs/heads/groupA/repo"), fixture.groupA.branchOid);
    assert.equal(git(fixture.repoRoot, "rev-parse", "refs/heads/groupB/repo"), fixture.groupB.branchOid);
});

// Builds a repo with two branches editing the same line of the same file differently, so folding conflicts.
function makeConflictingTwoGroupFixture(): {
    repoRoot: string;
    baseOid: string;
    groupA: GroupOccurrenceBranch;
    groupB: GroupOccurrenceBranch;
} {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\nline2\nline3\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");
    const baseOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", "-b", "groupA/repo");
    writeFileSync(join(repoRoot, "shared.txt"), "line1\nline2-a\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "groupA change");
    const groupABranchOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", baseOid);
    git(repoRoot, "checkout", "-q", "-b", "groupB/repo");
    writeFileSync(join(repoRoot, "shared.txt"), "line1\nline2-b\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "groupB change");
    const groupBBranchOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", "master");

    const groupA: GroupOccurrenceBranch = {
        groupId: "groupA",
        occurrencePath: "repo",
        occurrenceId: "occ-a",
        branchOid: groupABranchOid,
        sourceRepoRoot: repoRoot,
    };
    const groupB: GroupOccurrenceBranch = {
        groupId: "groupB",
        occurrencePath: "repo",
        occurrenceId: "occ-b",
        branchOid: groupBBranchOid,
        sourceRepoRoot: repoRoot,
    };
    return { repoRoot, baseOid, groupA, groupB };
}

test("test_conflictReturnsRepositoryQualifiedResultsAndLeavesBaseRefsUntouched", () => {
    const fixture = makeConflictingTwoGroupFixture();
    const input: LogicalRepositoryConsolidationInput = {
        logicalRepositoryId: "logical-repo-conflict",
        canonicalRepoRoot: fixture.repoRoot,
        canonicalOccurrenceBranchName: "groupB/repo",
        participatingBranches: [fixture.groupA, fixture.groupB],
        approvedConvergedTreeOid: "0".repeat(40),
        finalizedChildGitlinks: [],
        recordedBaseOid: fixture.baseOid,
        baseBranchRef: "refs/heads/master",
    };
    const result = consolidateLogicalRepository(input, "run-4");
    assert.ok("aborted" in result);
    if (!("aborted" in result)) return;
    assert.equal(result.aborted.reason, "conflict");
    assert.ok(result.aborted.conflicts && result.aborted.conflicts.length > 0);
    assert.ok((result.aborted.conflicts?.[0].conflictedPaths.length ?? 0) > 0);
    assert.equal(git(fixture.repoRoot, "rev-parse", "refs/heads/master"), input.recordedBaseOid);
    const operationBranchRef = `refs/heads/operations/run-4/${input.canonicalOccurrenceBranchName}`;
    assert.throws(() => git(fixture.repoRoot, "show-ref", "--verify", operationBranchRef));
});

test("test_exactlyOnePreparedIntegrationOidPerLogicalRepository", () => {
    const fixtureOne = makeDisjointTwoGroupFixture();
    const fixtureTwo = makeDisjointTwoGroupFixture();
    const inputOne = makeInput(fixtureOne, { logicalRepositoryId: "logical-repo-one" });
    const inputTwo = makeInput(fixtureTwo, { logicalRepositoryId: "logical-repo-two" });
    const token = issueRunAuthorization("digest-abc");
    const results = consolidateRun("run-5", [inputOne, inputTwo], token, "digest-abc");
    assert.equal(results.length, 2);
    for (const result of results) {
        assert.equal("aborted" in result, false);
        if ("aborted" in result) return;
        assert.equal(typeof result.preparedIntegrationOid, "string");
    }
    const [resultOne, resultTwo] = results;
    if ("aborted" in resultOne || "aborted" in resultTwo) return;
    assert.notEqual(resultOne.preparedIntegrationOid, resultTwo.preparedIntegrationOid);
});
