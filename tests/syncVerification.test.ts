// Behavioral checks for syncVerification.ts: tree/branch/test-policy gates and green-receipt persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    verifySync,
    persistGreenReceipt,
    VerificationError,
} from "../scripts/syncVerification.ts";
import type {
    Occurrence,
    SyncReceipt,
    SyncVerificationRunners,
    TreeEntry,
} from "../scripts/syncVerification.ts";
import type { TestPolicy } from "../scripts/testPolicy.ts";

function makeTreeEntry(overrides: Partial<TreeEntry> = {}): TreeEntry {
    return { path: "src/index.ts", mode: "100644", byteHash: "abc123", ...overrides };
}

function makeOccurrence(overrides: Partial<Occurrence> = {}): Occurrence {
    return {
        path: "repo",
        branch: "task-group-1",
        tree: [makeTreeEntry()],
        parentChain: [],
        ...overrides,
    };
}

function makeReceipt(overrides: Partial<SyncReceipt> = {}): SyncReceipt {
    return {
        logicalRepoId: "logical-1",
        convergedDigest: "digest-1",
        occurrences: [makeOccurrence()],
        lastWriterOccurrence: "repo",
        ...overrides,
    };
}

const okPolicy: TestPolicy = {
    occurrenceId: "repo",
    relatedTestCommand: "npm run test:related",
    completeSuiteCommand: "npm run test",
};

function makeRunners(overrides: Partial<SyncVerificationRunners> = {}): SyncVerificationRunners {
    return {
        resolveExpectedBranch: (occurrence) => occurrence.branch,
        resolveTestPolicy: () => okPolicy,
        runRelatedTests: () => true,
        runCompleteSuite: () => true,
        ...overrides,
    };
}

function useTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "sync-verification-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function assertRejectsWithKind(promise: Promise<unknown>, kind: string): Promise<void> {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof VerificationError);
        assert.equal(error.kind, kind);
        return true;
    });
}

test("test_mismatchedByteHashFailsWithMismatchedTreeKind", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", tree: [makeTreeEntry({ byteHash: "hash-a" })] });
    const b = makeOccurrence({ path: "repo-b", tree: [makeTreeEntry({ byteHash: "hash-b" })] });
    const receipt = makeReceipt({ occurrences: [a, b] });
    await assertRejectsWithKind(verifySync(receipt, makeRunners(), baseDir), "mismatched-tree");
});

test("test_mismatchedModeFailsWithMismatchedTreeKind", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", tree: [makeTreeEntry({ mode: "100644" })] });
    const b = makeOccurrence({ path: "repo-b", tree: [makeTreeEntry({ mode: "100755" })] });
    const receipt = makeReceipt({ occurrences: [a, b] });
    await assertRejectsWithKind(verifySync(receipt, makeRunners(), baseDir), "mismatched-tree");
});

test("test_mismatchedSymlinkTargetFailsWithMismatchedTreeKind", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", tree: [makeTreeEntry({ symlinkTarget: "a" })] });
    const b = makeOccurrence({ path: "repo-b", tree: [makeTreeEntry({ symlinkTarget: "b" })] });
    const receipt = makeReceipt({ occurrences: [a, b] });
    await assertRejectsWithKind(verifySync(receipt, makeRunners(), baseDir), "mismatched-tree");
});

test("test_mismatchedDeletedFlagFailsWithMismatchedTreeKind", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", tree: [makeTreeEntry({ deleted: true })] });
    const b = makeOccurrence({ path: "repo-b", tree: [makeTreeEntry({ deleted: false })] });
    const receipt = makeReceipt({ occurrences: [a, b] });
    await assertRejectsWithKind(verifySync(receipt, makeRunners(), baseDir), "mismatched-tree");
});

test("test_drifedBranchFailsWithBranchDriftKind", async () => {
    const baseDir = useTempDir();
    const occurrence = makeOccurrence({ branch: "actual-branch" });
    const receipt = makeReceipt({ occurrences: [occurrence] });
    const runners = makeRunners({ resolveExpectedBranch: () => "expected-branch" });
    await assertRejectsWithKind(verifySync(receipt, runners, baseDir), "branch-drift");
});

test("test_missingTestPolicyFailsWithMissingTestPolicyKind", async () => {
    const baseDir = useTempDir();
    const receipt = makeReceipt();
    const runners = makeRunners({ resolveTestPolicy: () => undefined });
    await assertRejectsWithKind(verifySync(receipt, runners, baseDir), "missing-test-policy");
});

test("test_failingRelatedTestsFailsWithTestFailureKind", async () => {
    const baseDir = useTempDir();
    const receipt = makeReceipt();
    const runners = makeRunners({ runRelatedTests: () => false });
    await assertRejectsWithKind(verifySync(receipt, runners, baseDir), "test-failure");
});

test("test_failingCompleteSuiteFailsWithTestFailureKind", async () => {
    const baseDir = useTempDir();
    const occurrence = makeOccurrence({ parentChain: ["parent"] });
    const receipt = makeReceipt({ occurrences: [occurrence] });
    const runners = makeRunners({ runCompleteSuite: () => false });
    await assertRejectsWithKind(verifySync(receipt, runners, baseDir), "test-failure");
});

test("test_sharedParentPathRunsCompleteSuiteExactlyOnce", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", parentChain: ["shared-parent"] });
    const b = makeOccurrence({ path: "repo-b", parentChain: ["shared-parent"] });
    const receipt = makeReceipt({ occurrences: [a, b] });
    let callCount = 0;
    const runners = makeRunners({
        runCompleteSuite: () => {
            callCount += 1;
            return true;
        },
    });
    await verifySync(receipt, runners, baseDir);
    assert.equal(callCount, 1);
});

test("test_sameOccurrencePathListedTwiceRunsRelatedTestsExactlyOnce", async () => {
    const baseDir = useTempDir();
    const occurrence = makeOccurrence();
    const receipt = makeReceipt({ occurrences: [occurrence, { ...occurrence }] });
    let callCount = 0;
    const runners = makeRunners({
        runRelatedTests: () => {
            callCount += 1;
            return true;
        },
    });
    await verifySync(receipt, runners, baseDir);
    assert.equal(callCount, 1);
});

test("test_distinctParentsWithSameLogicalChildBothRunCompleteSuite", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", parentChain: ["parent-a"] });
    const b = makeOccurrence({ path: "repo-b", parentChain: ["parent-b"] });
    const receipt = makeReceipt({ logicalRepoId: "same-logical", occurrences: [a, b] });
    let callCount = 0;
    const runners = makeRunners({
        runCompleteSuite: () => {
            callCount += 1;
            return true;
        },
    });
    await verifySync(receipt, runners, baseDir);
    assert.equal(callCount, 2);
});

test("test_greenReceiptPersistedOnlyOnFullSuccessKeyedToConvergedDigest", async () => {
    const baseDir = useTempDir();
    const occurrence = makeOccurrence({ parentChain: ["parent"] });
    const receipt = makeReceipt({ occurrences: [occurrence] });

    const greenReceipt = await verifySync(receipt, makeRunners(), baseDir);

    assert.equal(greenReceipt.convergedDigest, receipt.convergedDigest);
    assert.deepEqual(greenReceipt.occurrences, [occurrence.path]);
    assert.deepEqual(greenReceipt.verifiedParents, ["parent"]);
    assert.equal(greenReceipt.lastWriterOccurrence, receipt.lastWriterOccurrence);

    const filePath = join(baseDir, `${receipt.convergedDigest}.json`);
    assert.ok(existsSync(filePath));
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(persisted, greenReceipt);
});

test("test_noFileWrittenWhenVerificationFails", async () => {
    const baseDir = useTempDir();
    const a = makeOccurrence({ path: "repo-a", tree: [makeTreeEntry({ byteHash: "hash-a" })] });
    const b = makeOccurrence({ path: "repo-b", tree: [makeTreeEntry({ byteHash: "hash-b" })] });
    const receipt = makeReceipt({ convergedDigest: "digest-fail", occurrences: [a, b] });
    await assertRejectsWithKind(verifySync(receipt, makeRunners(), baseDir), "mismatched-tree");
    assert.equal(existsSync(join(baseDir, "digest-fail.json")), false);
});

test("test_persistGreenReceiptWritesJsonKeyedByConvergedDigest", () => {
    const baseDir = useTempDir();
    const greenReceipt = {
        logicalRepoId: "logical-1",
        convergedDigest: "digest-standalone",
        occurrences: ["repo"],
        verifiedParents: [],
        lastWriterOccurrence: "repo",
        verifiedAt: new Date().toISOString(),
    };
    persistGreenReceipt(greenReceipt, baseDir);
    const filePath = join(baseDir, "digest-standalone.json");
    assert.ok(existsSync(filePath));
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), greenReceipt);
});
