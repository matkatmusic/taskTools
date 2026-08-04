// Root-outward discovery of a repository's nested submodule tree, gated on full branch resolution.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";
import { readDirectGitlinks } from "./gitlinkReader.ts";
import { resolveBaseBranchCandidates } from "./baseBranchResolution.ts";
import {
    createResolutionRequest,
    createResolutionRequestId,
    hasResolutionAnswer,
    recordResolutionRequest,
    REASON_MULTIPLE_EXACT_TIP_MATCHES,
    REASON_ZERO_EXACT_TIP_MATCHES,
} from "./resolutionRequests.ts";
import type { ResolutionManifest, ResolutionRequest } from "./resolutionRequests.ts";
import { setUpOperationBranches } from "./operationBranches.ts";

export type DiscoveryManifest = {
    repositoryManifest: RepositoryManifest;
    resolutionManifest: ResolutionManifest;
};

export type DiscoveryResult =
    | { status: "resolved"; graph: RepositoryOccurrence[] }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };

function readRootBranchAndOid(rootPath: string): { branch: string; oid: string } {
    let branch: string;
    try {
        branch = execFileSync("git", ["-C", rootPath, "symbolic-ref", "--short", "HEAD"], {
            encoding: "utf8",
        }).trim();
    } catch {
        throw new Error(`root repository at "${rootPath}" is not on a branch (detached HEAD)`);
    }
    const oid = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return { branch, oid };
}

function resolveOccurrenceBaseBranch(
    checkoutPath: string,
    occurrenceId: string,
    baseOid: string,
    resolutionManifest: ResolutionManifest,
    pendingResolutionRequests: ResolutionRequest[],
): string {
    const resolution = resolveBaseBranchCandidates(checkoutPath, baseOid);
    if (resolution.kind === "single") return resolution.baseBranch;

    const reason = resolution.kind === "none" ? REASON_ZERO_EXACT_TIP_MATCHES : REASON_MULTIPLE_EXACT_TIP_MATCHES;
    const requestId = createResolutionRequestId(occurrenceId, reason);
    if (hasResolutionAnswer(resolutionManifest, requestId)) {
        return resolutionManifest.resolutionAnswers[requestId];
    }

    const request = createResolutionRequest(occurrenceId, baseOid, resolution.candidates, reason);
    recordResolutionRequest(resolutionManifest, request);
    pendingResolutionRequests.push(request);
    return "";
}

function discoverOccurrenceAndDescendants(
    rootPath: string,
    relativePath: string,
    parentOccurrenceId: string | null,
    pathInParent: string | null,
    depth: number,
    gitlinkOid: string,
    manifest: DiscoveryManifest,
    pendingResolutionRequests: ResolutionRequest[],
): void {
    const occurrenceId = relativePath;
    const checkoutPath = join(rootPath, relativePath);
    const occurrences = manifest.repositoryManifest.occurrences;
    const existing = occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);

    let baseOid = gitlinkOid;
    let baseBranch: string;

    if (existing && existing.baseBranch !== "") {
        baseOid = existing.baseOid;
        baseBranch = existing.baseBranch;
    } else if (parentOccurrenceId === null) {
        const rootIdentity = readRootBranchAndOid(rootPath);
        baseOid = rootIdentity.oid;
        baseBranch = rootIdentity.branch;
    } else {
        baseBranch = resolveOccurrenceBaseBranch(
            checkoutPath,
            occurrenceId,
            baseOid,
            manifest.resolutionManifest,
            pendingResolutionRequests,
        );
    }

    const occurrence: RepositoryOccurrence = {
        occurrenceId,
        checkoutPath,
        parentOccurrenceId,
        pathInParent,
        gitlinkOid: parentOccurrenceId === null ? null : baseOid,
        depth,
        originUrl: existing?.originUrl ?? "",
        baseBranch,
        baseOid,
        operationBranch: existing?.operationBranch ?? "",
        childOccurrenceIds: existing?.childOccurrenceIds ?? [],
        testState: existing?.testState ?? "untested",
    };

    if (existing) {
        Object.assign(existing, occurrence);
    } else {
        occurrences.push(occurrence);
        if (parentOccurrenceId !== null) {
            const parent = occurrences.find((candidate) => candidate.occurrenceId === parentOccurrenceId);
            parent?.childOccurrenceIds.push(occurrenceId);
        }
    }

    const gitlinks = readDirectGitlinks(checkoutPath, baseOid);
    for (const gitlink of gitlinks) {
        const childRelativePath = relativePath === "" ? gitlink.path : `${relativePath}/${gitlink.path}`;
        discoverOccurrenceAndDescendants(
            rootPath,
            childRelativePath,
            occurrenceId,
            gitlink.path,
            depth + 1,
            gitlink.oid,
            manifest,
            pendingResolutionRequests,
        );
    }
}

export function discoverRepositoryTree(rootPath: string, manifest: DiscoveryManifest): DiscoveryResult {
    const pendingResolutionRequests: ResolutionRequest[] = [];
    discoverOccurrenceAndDescendants(rootPath, "", null, null, 0, "", manifest, pendingResolutionRequests);

    if (pendingResolutionRequests.length > 0) {
        return { status: "needsResolution", resolutionRequests: pendingResolutionRequests };
    }

    const runId = randomUUID();
    for (const occurrence of manifest.repositoryManifest.occurrences) {
        if (occurrence.operationBranch !== "") continue;
        const [updated] = setUpOperationBranches([occurrence], runId);
        occurrence.operationBranch = updated.operationBranch;
    }

    return { status: "resolved", graph: manifest.repositoryManifest.occurrences };
}
