#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readCurrentRefOid } from "./basePublication.ts";
import type { CliInput } from "./mergePipeline.ts";
import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";

export type StepOutputs = {
    done?: unknown[];
    partial?: unknown[];
    blocked?: unknown[];
    needsClarification?: unknown[];
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};

export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

export function buildMergeOutcomes(steps: StepOutputs) {
    return {
        doneCount: steps.done?.length ?? 0,
        partialCount: steps.partial?.length ?? 0,
        blockedCount: steps.blocked?.length ?? 0,
        needsClarificationCount: steps.needsClarification?.length ?? 0,
        requeueCount: steps.requeueCount ?? 0,
        testReceipts: steps.testReceipts ?? [],
        reviewHandoffs: steps.reviewHandoffs ?? [],
    };
}

type ScriptRun = { exitCode: number; stdout: string; stderr: string };

export function judgeMergeRun(run: ScriptRun, repo: string, failedCommand: string): MergePhaseVerdict {
    const blocked = (error: string, conflicts: unknown[], result: unknown): MergePhaseVerdict =>
        ({ status: "blocked", result, failure: { repo, failedCommand, conflicts, error } });
    if (run.exitCode !== 0) return blocked(`${run.exitCode}: ${run.stderr || run.stdout}`, [], null);
    let output: { conflicts?: unknown[]; publicationTargets?: unknown[] };
    try {
        output = JSON.parse(run.stdout);
    } catch {
        return blocked(`merge script printed output that is not JSON: ${run.stdout.slice(0, 500)}`, [], null);
    }
    if ((output.conflicts?.length ?? 0) > 0) return blocked("", output.conflicts!, output);
    if ((output.publicationTargets?.length ?? 0) === 0)
        return blocked("merge script exited clean but published nothing (publicationTargets is empty): the run was not ready for approval, or the source branch moved past its pinned baseOid before publish", [], output);
    return { status: "merged", result: output, failure: null };
}

function runScript(command: string[], cwd?: string): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}

function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}

function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean {
    const result = verdict.result as { abortReason?: string | null } | null;
    return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid");
}

function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean {
    return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict);
}

function describeRebaseFailure(outcome: RebaseOutcome): string {
    if (outcome.status === "conflicted") return `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`;
    if (outcome.status === "cleanup-failed") return outcome.failureReason;
    return "rebase reported unexpected clean status while being treated as a failure";
}

function occurrencePathInWorktree(repoRoot: string, worktree: string, checkoutPath: string): string {
    const absoluteCheckout = isAbsolute(checkoutPath) ? checkoutPath : join(repoRoot, checkoutPath);
    const relativePath = relative(resolve(repoRoot), absoluteCheckout);
    return relativePath === "" || relativePath === "." ? worktree : join(worktree, relativePath);
}

function mintFreshRunId(generate: () => string, oldRunId: string): string {
    const candidate = generate();
    return candidate === oldRunId ? `${candidate}-retry` : candidate;
}

function rewriteOperationBranches(
    occurrences: RepositoryOccurrence[],
    oldRunId: string,
    newRunId: string,
): RepositoryOccurrence[] | null {
    const oldPrefix = `operations/${oldRunId}/`;
    const rewritten: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        if (!occurrence.operationBranch.startsWith(oldPrefix)) return null;
        rewritten.push({ ...occurrence, operationBranch: `operations/${newRunId}/${occurrence.operationBranch.slice(oldPrefix.length)}` });
    }
    return rewritten;
}

function refreshBaseOids(
    repoRoot: string,
    occurrences: RepositoryOccurrence[],
    readRefOid: (repoRoot: string, ref: string) => string | null,
): RepositoryOccurrence[] | null {
    const refreshed: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        const checkoutRoot = isAbsolute(occurrence.checkoutPath) ? occurrence.checkoutPath : join(repoRoot, occurrence.checkoutPath);
        const oid = readRefOid(checkoutRoot, `refs/heads/${occurrence.baseBranch}`);
        if (oid === null) return null;
        refreshed.push({ ...occurrence, baseOid: oid });
    }
    return refreshed;
}

export type MergeRetryDeps = {
    runScript: (command: string[], cwd?: string) => ScriptRun;
    generateRunId: () => string;
    readRefOid: (repoRoot: string, ref: string) => string | null;
    writeRunArguments: (data: unknown) => void;
    rebaseGroupOntoSource: (worktreePath: string, sourceBranch: string) => RebaseOutcome;
    discoverTestPolicy: (occurrenceId: string, checkoutPath: string, resolutionManifest: ResolutionManifest) => TestPolicyResult;
};

export function coordinateMergeRetry(
    runArguments: CliInput,
    mergeCommand: string[],
    deps: MergeRetryDeps,
): MergePhaseVerdict {
    const sourceBranch = runArguments.repositorySources.find((source) => source.path === "")?.sourceBranch;
    if (!sourceBranch) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "no recorded source branch for repository root");

    for (const group of runArguments.groups) {
        const rebaseOutcome = deps.rebaseGroupOntoSource(group.worktree, sourceBranch);
        if (rebaseOutcome.status !== "rebased-clean") {
            return blockedVerdict(runArguments.repo, mergeCommand.join(" "), describeRebaseFailure(rebaseOutcome));
        }
        for (const occurrence of runArguments.repositoryManifest.occurrences) {
            const occurrencePath = occurrencePathInWorktree(runArguments.repo, group.worktree, occurrence.checkoutPath);
            const policyResult = deps.discoverTestPolicy(occurrence.occurrenceId, occurrencePath, createEmptyResolutionManifest());
            if (policyResult.status !== "resolved") {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `test policy unresolved for occurrence "${occurrence.occurrenceId}"`);
            }
            const testRun = deps.runScript(["sh", "-c", policyResult.policy.completeSuiteCommand], occurrencePath);
            if (testRun.exitCode !== 0) {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `post-rebase tests failed for occurrence "${occurrence.occurrenceId}": ${testRun.stderr || testRun.stdout}`);
            }
        }
    }

    const oldRunId = runArguments.runId;
    if (!oldRunId) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "run arguments carry no runId to retry from");
    const newRunId = mintFreshRunId(deps.generateRunId, oldRunId);
    const rewrittenOccurrences = rewriteOperationBranches(runArguments.repositoryManifest.occurrences, oldRunId, newRunId);
    if (rewrittenOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `an occurrence operationBranch does not carry the expected prefix "operations/${oldRunId}/"`);
    }
    const refreshedOccurrences = refreshBaseOids(runArguments.repo, rewrittenOccurrences, deps.readRefOid);
    if (refreshedOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "failed to read a refreshed base OID for an occurrence");
    }

    const updatedArguments: CliInput = {
        ...runArguments,
        runId: newRunId,
        repositoryManifest: { ...runArguments.repositoryManifest, occurrences: refreshedOccurrences },
    };
    deps.writeRunArguments(updatedArguments);

    const retryVerdict = judgeMergeRun(deps.runScript(mergeCommand), runArguments.repo, mergeCommand.join(" "));
    if (resultIndicatesBaseDrift(retryVerdict)) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "retry hit a second base-drift result; no further attempt");
    }
    return retryVerdict;
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
    const runArgumentsPath = resolveRunArgumentsPath(repoRoot);
    const runArguments: CliInput = JSON.parse(readFileSync(runArgumentsPath, "utf8"));
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile];
    const deps: MergeRetryDeps = {
        runScript,
        generateRunId,
        readRefOid: readCurrentRefOid,
        writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)),
        rebaseGroupOntoSource,
        discoverTestPolicy,
    };
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = confirmedBaseDrift(initialVerdict) ? coordinateMergeRetry(runArguments, command, deps) : initialVerdict;
    process.stdout.write(JSON.stringify(verdict));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
