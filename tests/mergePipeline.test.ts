// Behavioral checks: an integration commit must change and carry every declared file, verified against its owning repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildCoordinates,
    buildLogicalGroups,
    topoOrderLogicalGroups,
    taskFilesByLogicalId,
    findTaskArchivalValidationFailure,
    type ConsolidationOutcome,
} from "../scripts/shared/mergePipeline.ts";
import { archiveIfMerged, type MergePhaseVerdict } from "../scripts/shared/runMergePhase.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/shared/repositoryManifest.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function initRepoWithFile(repoRoot: string, relativePath: string, content: string): string {
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "test");
    writeFileSync(join(repoRoot, relativePath), content);
    git(repoRoot, "add", relativePath);
    git(repoRoot, "commit", "-q", "-m", "init");
    return git(repoRoot, "rev-parse", "HEAD").trim();
}

function makeOccurrence(overrides: Partial<RepositoryOccurrence> & Pick<RepositoryOccurrence, "occurrenceId" | "checkoutPath">): RepositoryOccurrence {
    return {
        parentOccurrenceId: null, pathInParent: null, gitlinkOid: null, depth: 0,
        originUrl: "", baseBranch: "main", baseOid: "", operationBranch: "operations/x",
        childOccurrenceIds: [], testState: "untested",
        ...overrides,
    };
}

// Two independent git repositories: rootRepo (root occurrence) and rootRepo/sub (submodule-shaped occurrence), each with one base commit.
function makeManifestAndCoordinates(repoRootDir: string) {
    const rootRepo = repoRootDir;
    const subRepo = join(repoRootDir, "sub");
    const rootBaseOid = initRepoWithFile(rootRepo, "base.txt", "base");
    const subBaseOid = initRepoWithFile(subRepo, "existing.ts", "already here");

    const manifest: RepositoryManifest = {
        version: 1,
        occurrences: [
            makeOccurrence({ occurrenceId: "root", checkoutPath: rootRepo, baseOid: rootBaseOid, childOccurrenceIds: ["sub"] }),
            makeOccurrence({ occurrenceId: "sub", checkoutPath: subRepo, parentOccurrenceId: "root", pathInParent: "sub", depth: 1, baseOid: subBaseOid }),
        ],
    };
    const coordinates = buildCoordinates(rootRepo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    return { manifest, coordinates, logicalGroups, rootRepo, subRepo, rootBaseOid, subBaseOid };
}

test("a task declaring no files is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups } = makeManifestAndCoordinates(join(dir, "repo"));
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: [] }], manifest, coordinates, logicalGroups, new Map());
    assert.match(failure ?? "", /declares no files/);
});

test("a changed commit that carries the declared file passes validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, rootRepo, rootBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    writeFileSync(join(rootRepo, "declared.ts"), "code");
    git(rootRepo, "add", "declared.ts");
    git(rootRepo, "commit", "-q", "-m", "add declared.ts");
    const integrationOid = git(rootRepo, "rev-parse", "HEAD").trim();
    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [rootLogicalId, { preparedIntegrationOid: integrationOid, canonicalRepoRoot: rootRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: rootBaseOid, integrationRef: "refs/x" }],
    ]);
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: ["declared.ts"] }], manifest, coordinates, logicalGroups, consolidations);
    assert.equal(failure, null);
});

test("a changed commit missing the declared path is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, rootRepo, rootBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    writeFileSync(join(rootRepo, "other.ts"), "code");
    git(rootRepo, "add", "other.ts");
    git(rootRepo, "commit", "-q", "-m", "add other.ts");
    const integrationOid = git(rootRepo, "rev-parse", "HEAD").trim();
    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [rootLogicalId, { preparedIntegrationOid: integrationOid, canonicalRepoRoot: rootRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: rootBaseOid, integrationRef: "refs/x" }],
    ]);
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: ["declared.ts"] }], manifest, coordinates, logicalGroups, consolidations);
    assert.match(failure ?? "", /missing from commit/);
});

test("an empty commit inheriting a pre-existing declared file is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, subRepo, subBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    git(subRepo, "commit", "--allow-empty", "-q", "-m", "no-op consolidation");
    const noOpOid = git(subRepo, "rev-parse", "HEAD").trim();
    const subLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("sub"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [subLogicalId, { preparedIntegrationOid: noOpOid, canonicalRepoRoot: subRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: subBaseOid, integrationRef: "refs/x" }],
    ]);
    // existing.ts is present in noOpOid's tree unchanged; only the tree-diff check catches this.
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: ["sub/existing.ts"] }], manifest, coordinates, logicalGroups, consolidations);
    assert.match(failure ?? "", /no changes from its recorded base/);
});

test("a task spanning root and submodule paths validates each against its own repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, rootRepo, rootBaseOid, subRepo, subBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    writeFileSync(join(rootRepo, "declared.ts"), "code");
    git(rootRepo, "add", "declared.ts");
    git(rootRepo, "commit", "-q", "-m", "root change");
    const rootIntegrationOid = git(rootRepo, "rev-parse", "HEAD").trim();

    writeFileSync(join(subRepo, "sub-declared.ts"), "code");
    git(subRepo, "add", "sub-declared.ts");
    git(subRepo, "commit", "-q", "-m", "sub change");
    const subIntegrationOid = git(subRepo, "rev-parse", "HEAD").trim();

    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const subLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("sub"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [rootLogicalId, { preparedIntegrationOid: rootIntegrationOid, canonicalRepoRoot: rootRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: rootBaseOid, integrationRef: "refs/x" }],
        [subLogicalId, { preparedIntegrationOid: subIntegrationOid, canonicalRepoRoot: subRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: subBaseOid, integrationRef: "refs/y" }],
    ]);
    // sub/sub-declared.ts must resolve to sub-declared.ts and be checked against subRepo, not rootRepo.
    const failure = findTaskArchivalValidationFailure(
        [{ number: 1, files: ["declared.ts", "sub/sub-declared.ts"] }],
        manifest, coordinates, logicalGroups, consolidations,
    );
    assert.equal(failure, null);
});

test("an exact submodule checkout path resolves to the parent repository, not the submodule", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups } = makeManifestAndCoordinates(join(dir, "repo"));
    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const owningLogicalIds = taskFilesByLogicalId(["sub"], manifest, coordinates, logicalGroups);
    assert.deepEqual([...owningLogicalIds], [rootLogicalId]);
});

test("test_archiveIfMergedNeverCallsArchiveForABlockedVerdict", () => {
    const verdict: MergePhaseVerdict = {
        status: "blocked",
        result: { archiveRequest: { publishedTaskNumbers: [1], mergeResults: [] } },
        failure: { repo: "/repo", failedCommand: "cmd", conflicts: [], error: "boom" },
    };
    let called = false;
    const result = archiveIfMerged(verdict, "/repo", "cmd", () => { called = true; return { archived: [], leftOpen: [] }; });

    assert.equal(called, false);
    assert.deepEqual(result, verdict);
});

test("test_archiveIfMergedArchivesExactlyOnceForAMergedVerdict", () => {
    const archiveRequest = {
        publishedTaskNumbers: [7],
        mergeResults: [{ taskNumber: 7, repos: [{ repoName: "r1", status: "published" as const, commitHash: "aaa" }], fullyPublished: true }],
    };
    const verdict: MergePhaseVerdict = { status: "merged", result: { archiveRequest }, failure: null };
    let callCount = 0;
    const result = archiveIfMerged(verdict, "/repo", "cmd", (publishedTaskNumbers) => {
        callCount++;
        assert.deepEqual(publishedTaskNumbers, [7]);
        return { archived: [7], leftOpen: [] };
    });

    assert.equal(callCount, 1);
    assert.equal(result.status, "merged");
    // Postcondition: archived covers the requested set, leftOpen has none of it, so the verdict passes through.
    assert.deepEqual(result, verdict);
});

test("test_archiveIfMergedBlocksWithoutCallingArchiveForAMissingOrMixedResult", () => {
    let called = false;
    const failIfCalled = () => { called = true; return { archived: [], leftOpen: [] }; };

    const missingResultVerdict: MergePhaseVerdict = {
        status: "merged",
        result: { archiveRequest: { publishedTaskNumbers: [7], mergeResults: [] } },
        failure: null,
    };
    const missingResultOutcome = archiveIfMerged(missingResultVerdict, "/repo", "cmd", failIfCalled);
    assert.equal(called, false);
    assert.equal(missingResultOutcome.status, "blocked");

    const mixedRequestVerdict: MergePhaseVerdict = {
        status: "merged",
        result: {
            archiveRequest: {
                publishedTaskNumbers: [7, 8],
                mergeResults: [
                    { taskNumber: 7, repos: [{ repoName: "r1", status: "published", commitHash: "aaa" }], fullyPublished: true },
                ],
            },
        },
        failure: null,
    };
    const mixedOutcome = archiveIfMerged(mixedRequestVerdict, "/repo", "cmd", failIfCalled);
    assert.equal(called, false);
    assert.equal(mixedOutcome.status, "blocked");
});

test("test_archiveIfMergedBlocksOnAMissingRequestOrAnIncompleteOrFailedArchival", () => {
    const missingPayload: MergePhaseVerdict = { status: "merged", result: {}, failure: null };
    let calledForMissingPayload = false;
    const missingResult = archiveIfMerged(missingPayload, "/repo", "cmd", () => {
        calledForMissingPayload = true;
        return { archived: [], leftOpen: [] };
    });
    assert.equal(calledForMissingPayload, false);
    assert.equal(missingResult.status, "blocked");
    assert.match(missingResult.failure?.error ?? "", /no valid, complete archiveRequest/);

    const completeRequest = {
        publishedTaskNumbers: [7],
        mergeResults: [{ taskNumber: 7, repos: [{ repoName: "r1", status: "published" as const, commitHash: "aaa" }], fullyPublished: true }],
    };

    const throwingVerdict: MergePhaseVerdict = { status: "merged", result: { archiveRequest: completeRequest }, failure: null };
    const throwingResult = archiveIfMerged(throwingVerdict, "/repo", "cmd", () => { throw new Error("task 7 declares no files"); });
    assert.equal(throwingResult.status, "blocked");
    assert.match(throwingResult.failure?.error ?? "", /task 7 declares no files/);

    const incompleteVerdict: MergePhaseVerdict = { status: "merged", result: { archiveRequest: completeRequest }, failure: null };
    const incompleteResult = archiveIfMerged(incompleteVerdict, "/repo", "cmd", () => ({ archived: [], leftOpen: [7] }));
    assert.equal(incompleteResult.status, "blocked");
    assert.match(incompleteResult.failure?.error ?? "", /incomplete/);
});
