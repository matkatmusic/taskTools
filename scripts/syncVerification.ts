// syncVerification.ts: verifies a converged sync (tree equivalence, branch drift, test policy,
// related/complete-suite tests) across an occurrence's siblings, then persists a green receipt.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestPolicy } from "./testPolicy.ts";

export interface TreeEntry {
    path: string;
    mode: string;
    byteHash: string;
    symlinkTarget?: string;
    deleted?: boolean;
}

export interface Occurrence {
    path: string;
    branch: string;
    tree: TreeEntry[];
    parentChain: string[];
}

export interface SyncReceipt {
    logicalRepoId: string;
    convergedDigest: string;
    occurrences: Occurrence[];
    lastWriterOccurrence: string;
}

export interface GreenReceipt {
    logicalRepoId: string;
    convergedDigest: string;
    occurrences: string[];
    verifiedParents: string[];
    lastWriterOccurrence: string;
    verifiedAt: string;
}

export type VerificationFailureKind =
    | "mismatched-tree"
    | "branch-drift"
    | "missing-test-policy"
    | "test-failure";

export class VerificationError extends Error {
    kind: VerificationFailureKind;

    constructor(kind: VerificationFailureKind, message: string) {
        super(message);
        this.kind = kind;
    }
}

export interface SyncVerificationRunners {
    resolveExpectedBranch(occurrence: Occurrence, receipt: SyncReceipt): string;
    resolveTestPolicy(occurrence: Occurrence): TestPolicy | undefined;
    runRelatedTests(occurrence: Occurrence): boolean | Promise<boolean>;
    runCompleteSuite(parentPath: string): boolean | Promise<boolean>;
}

function treeEntryKey(entry: TreeEntry): string {
    return `${entry.path}|${entry.mode}|${entry.byteHash}|${entry.symlinkTarget ?? ""}|${entry.deleted ?? false}`;
}

function assertTreesMatch(occurrences: Occurrence[]): void {
    if (occurrences.length === 0) return;
    const reference = new Set(occurrences[0].tree.map(treeEntryKey));
    for (const occurrence of occurrences.slice(1)) {
        const candidate = new Set(occurrence.tree.map(treeEntryKey));
        const matches = reference.size === candidate.size && [...reference].every((key) => candidate.has(key));
        if (!matches) {
            throw new VerificationError(
                "mismatched-tree",
                `tree mismatch between ${occurrences[0].path} and ${occurrence.path}`,
            );
        }
    }
}

async function verifyBranches(receipt: SyncReceipt, runners: SyncVerificationRunners): Promise<void> {
    for (const occurrence of receipt.occurrences) {
        const expectedBranch = runners.resolveExpectedBranch(occurrence, receipt);
        if (expectedBranch !== occurrence.branch) {
            throw new VerificationError(
                "branch-drift",
                `expected branch "${expectedBranch}" for ${occurrence.path}, found "${occurrence.branch}"`,
            );
        }
    }
}

async function verifyRelatedTests(receipt: SyncReceipt, runners: SyncVerificationRunners): Promise<void> {
    const ran = new Set<string>();
    for (const occurrence of receipt.occurrences) {
        const key = `${occurrence.path}:${receipt.convergedDigest}`;
        if (ran.has(key)) continue;
        ran.add(key);
        const policy = runners.resolveTestPolicy(occurrence);
        if (!policy) {
            throw new VerificationError("missing-test-policy", `no test policy resolved for ${occurrence.path}`);
        }
        const passed = await runners.runRelatedTests(occurrence);
        if (!passed) {
            throw new VerificationError("test-failure", `related tests failed for ${occurrence.path}`);
        }
    }
}

async function verifyCompleteSuites(receipt: SyncReceipt, runners: SyncVerificationRunners): Promise<string[]> {
    const ran = new Set<string>();
    const verifiedParents: string[] = [];
    for (const occurrence of receipt.occurrences) {
        for (const parentPath of occurrence.parentChain) {
            const key = `${parentPath}:${receipt.convergedDigest}`;
            if (ran.has(key)) continue;
            const passed = await runners.runCompleteSuite(parentPath);
            ran.add(key);
            verifiedParents.push(parentPath);
            if (!passed) {
                throw new VerificationError("test-failure", `complete suite failed for ${parentPath}`);
            }
        }
    }
    return verifiedParents;
}

export async function verifySync(
    receipt: SyncReceipt,
    runners: SyncVerificationRunners,
    baseDir = "receipts",
): Promise<GreenReceipt> {
    assertTreesMatch(receipt.occurrences);
    await verifyBranches(receipt, runners);
    await verifyRelatedTests(receipt, runners);
    const verifiedParents = await verifyCompleteSuites(receipt, runners);

    const greenReceipt: GreenReceipt = {
        logicalRepoId: receipt.logicalRepoId,
        convergedDigest: receipt.convergedDigest,
        occurrences: receipt.occurrences.map((occurrence) => occurrence.path),
        verifiedParents,
        lastWriterOccurrence: receipt.lastWriterOccurrence,
        verifiedAt: new Date().toISOString(),
    };

    persistGreenReceipt(greenReceipt, baseDir);
    return greenReceipt;
}

export function persistGreenReceipt(receipt: GreenReceipt, baseDir = "receipts"): void {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, `${receipt.convergedDigest}.json`), JSON.stringify(receipt, null, 2));
}
