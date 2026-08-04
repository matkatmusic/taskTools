// Finalizes an occurrence graph bottom-up: per-occurrence own-files commit, durable tip ref, and a bump-commit assembly branch for parents.
import { execFileSync } from "node:child_process";
import { readDirectGitlinks } from "./gitlinkReader.ts";
import { substituteGitlink } from "./repositoryIntegration.ts";
import { runFinalization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";
import type { Change } from "./ownershipSnapshots.ts";

export type ChildOccurrenceEdge = {
    pathInParent: string;
    childOccurrenceId: string;
};

export type OccurrenceFinalizationInput = {
    occurrenceId: string;
    repoRoot: string;
    currentTipOid: string;
    recordedBaseOid: string;
    approvedOwnFileChanges: Change[];
    directChildEdges: ChildOccurrenceEdge[];
};

export type FinalizationRunInput = {
    runId: string;
    occurrences: OccurrenceFinalizationInput[];
};

export type BumpCommit = {
    pathInParent: string;
    childOccurrenceId: string;
    commitOid: string;
};

export type OccurrenceFinalizationResult = {
    occurrenceId: string;
    ownFilesCommitOid: string;
    durableTipRef: string;
    finalizedIntegrationOid: string;
    assemblyBranchRef: string | null;
    bumpCommits: BumpCommit[];
};

export type FinalizationRunResult = {
    runId: string;
    occurrences: OccurrenceFinalizationResult[];
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function stageChange(repoRoot: string, change: Change): void {
    if (change.type === "renamed") {
        if (!change.fromPath) {
            throw new Error(`renamed change for "${change.path}" is missing fromPath`);
        }
        git(repoRoot, "add", "--", change.fromPath, change.path);
        return;
    }
    git(repoRoot, "add", "--", change.path);
}

// Defensive re-check: the caller is expected to have already filtered these to non-gitlink paths.
function assertNoGitlinkChanges(repoRoot: string, currentTipOid: string, changes: Change[]): void {
    const gitlinkPaths = new Set(readDirectGitlinks(repoRoot, currentTipOid).map((entry) => entry.path));
    for (const change of changes) {
        const touchesGitlink = gitlinkPaths.has(change.path) || (change.fromPath !== undefined && gitlinkPaths.has(change.fromPath));
        if (touchesGitlink) {
            throw new Error(`approvedOwnFileChanges includes gitlink path "${change.path}"; own-file commits must never touch a gitlink`);
        }
    }
}

function commitOwnFileChanges(
    repoRoot: string,
    occurrenceId: string,
    runId: string,
    currentTipOid: string,
    changes: Change[],
): string {
    if (changes.length === 0) return currentTipOid;
    assertNoGitlinkChanges(repoRoot, currentTipOid, changes);
    for (const change of changes) stageChange(repoRoot, change);
    const newTreeOid = git(repoRoot, "write-tree").trim();
    return git(
        repoRoot,
        "commit-tree",
        newTreeOid,
        "-p",
        currentTipOid,
        "-m",
        `finalize: own-file changes for ${occurrenceId} (${runId})`,
    ).trim();
}

function readGitlinkOid(repoRoot: string, commitOid: string, pathInParent: string): string | null {
    const line = git(repoRoot, "ls-tree", commitOid, "--", pathInParent).trim();
    if (line === "") return null;
    const [metadata] = line.split("\t");
    return metadata.split(" ")[2] ?? null;
}

// Post-order DFS over directChildEdges: every occurrence appears after all of its direct and transitive children.
function topologicallySortChildFirst(occurrences: OccurrenceFinalizationInput[]): OccurrenceFinalizationInput[] {
    const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const mark = new Map<string, "gray" | "black">();
    const order: OccurrenceFinalizationInput[] = [];

    function visit(occurrence: OccurrenceFinalizationInput, path: string[]): void {
        const currentMark = mark.get(occurrence.occurrenceId);
        if (currentMark === "black") return;
        if (currentMark === "gray") {
            throw new Error(`cycle detected among occurrences: ${[...path, occurrence.occurrenceId].join(" -> ")}`);
        }
        mark.set(occurrence.occurrenceId, "gray");
        for (const edge of occurrence.directChildEdges) {
            const child = byId.get(edge.childOccurrenceId);
            if (!child) {
                throw new Error(
                    `occurrence "${occurrence.occurrenceId}" has directChildEdges entry for unknown childOccurrenceId "${edge.childOccurrenceId}"`,
                );
            }
            visit(child, [...path, occurrence.occurrenceId]);
        }
        mark.set(occurrence.occurrenceId, "black");
        order.push(occurrence);
    }

    for (const occurrence of occurrences) visit(occurrence, []);
    return order;
}

function buildAssemblyBranch(
    occurrence: OccurrenceFinalizationInput,
    runId: string,
    resultsByOccurrenceId: Map<string, OccurrenceFinalizationResult>,
): { finalizedIntegrationOid: string; assemblyBranchRef: string; bumpCommits: BumpCommit[] } {
    const { repoRoot, recordedBaseOid, directChildEdges } = occurrence;
    const sortedEdges = [...directChildEdges].sort((a, b) => a.pathInParent.localeCompare(b.pathInParent));
    const bumpCommits: BumpCommit[] = [];
    let assemblyTip = recordedBaseOid;
    for (const edge of sortedEdges) {
        const childResult = resultsByOccurrenceId.get(edge.childOccurrenceId);
        if (!childResult) {
            throw new Error(`no finalized result for child occurrence "${edge.childOccurrenceId}"`);
        }
        const childOid = childResult.finalizedIntegrationOid;
        const existingGitlinkOid = readGitlinkOid(repoRoot, assemblyTip, edge.pathInParent);
        if (existingGitlinkOid === childOid) continue;
        assemblyTip = substituteGitlink(repoRoot, { parentCommitOid: assemblyTip, pathInParent: edge.pathInParent, childOid });
        bumpCommits.push({ pathInParent: edge.pathInParent, childOccurrenceId: edge.childOccurrenceId, commitOid: assemblyTip });
    }
    const assemblyBranchRef = `refs/finalize/${runId}/assembly/${occurrence.occurrenceId}`;
    git(repoRoot, "update-ref", assemblyBranchRef, assemblyTip);
    return { finalizedIntegrationOid: assemblyTip, assemblyBranchRef, bumpCommits };
}

function finalizeOccurrence(
    occurrence: OccurrenceFinalizationInput,
    runId: string,
    resultsByOccurrenceId: Map<string, OccurrenceFinalizationResult>,
): OccurrenceFinalizationResult {
    const ownFilesCommitOid = commitOwnFileChanges(
        occurrence.repoRoot,
        occurrence.occurrenceId,
        runId,
        occurrence.currentTipOid,
        occurrence.approvedOwnFileChanges,
    );
    const durableTipRef = `refs/finalize/${runId}/tip/${occurrence.occurrenceId}`;
    git(occurrence.repoRoot, "update-ref", durableTipRef, ownFilesCommitOid);

    if (occurrence.directChildEdges.length === 0) {
        return {
            occurrenceId: occurrence.occurrenceId,
            ownFilesCommitOid,
            durableTipRef,
            finalizedIntegrationOid: ownFilesCommitOid,
            assemblyBranchRef: null,
            bumpCommits: [],
        };
    }

    const { finalizedIntegrationOid, assemblyBranchRef, bumpCommits } = buildAssemblyBranch(occurrence, runId, resultsByOccurrenceId);
    return {
        occurrenceId: occurrence.occurrenceId,
        ownFilesCommitOid,
        durableTipRef,
        finalizedIntegrationOid,
        assemblyBranchRef,
        bumpCommits,
    };
}

export function runFinalizer(
    input: FinalizationRunInput,
    token: RunAuthorizationToken,
    currentStateDigest: string,
): FinalizationRunResult {
    return runFinalization(token, currentStateDigest, () => {
        const resultsByOccurrenceId = new Map<string, OccurrenceFinalizationResult>();
        for (const occurrence of topologicallySortChildFirst(input.occurrences)) {
            resultsByOccurrenceId.set(occurrence.occurrenceId, finalizeOccurrence(occurrence, input.runId, resultsByOccurrenceId));
        }
        return {
            runId: input.runId,
            occurrences: input.occurrences.map((occurrence) => resultsByOccurrenceId.get(occurrence.occurrenceId)!),
        };
    });
}
