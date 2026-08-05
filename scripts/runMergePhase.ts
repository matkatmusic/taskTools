#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";

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
    let output: { conflicts?: unknown[] };
    try {
        output = JSON.parse(run.stdout);
    } catch {
        return blocked(`merge script printed output that is not JSON: ${run.stdout.slice(0, 500)}`, [], null);
    }
    if ((output.conflicts?.length ?? 0) > 0) return blocked("", output.conflicts!, output);
    return { status: "merged", result: output, failure: null };
}

function runScript(command: string[]): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8" }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", resolveRunArgumentsPath(repoRoot), outcomesFile];
    process.stdout.write(JSON.stringify(judgeMergeRun(runScript(command), repoRoot, command.join(" "))));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
