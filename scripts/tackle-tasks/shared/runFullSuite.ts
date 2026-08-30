// "run the full suite" — pipeline-suite.mmd. Runs each layer's suite, deepest first; a layer without one passes.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getOccurrencesDeepestFirst } from "./occurrences.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { discoverTestPolicy } from "../../testPolicy.ts";
import { createEmptyResolutionManifest } from "../../resolutionRequests.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

const MAX_OUTPUT_LENGTH = 8000;

export type RunFullSuiteOutput = {
    stepId: string;
    passed: boolean;
    layers: { occurrenceId: string; passed: boolean }[];
    output: string;
};

function truncateOutput(output: string): string {
    return output.length <= MAX_OUTPUT_LENGTH ? output : output.slice(-MAX_OUTPUT_LENGTH);
}

function runCompleteSuite(checkoutPath: string, command: string): { passed: boolean; output: string } {
    try {
        // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
        const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
        const stdout = execSync(command, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
        return { passed: true, output: stdout };
    } catch (error) {
        const execError = error as { status?: number | null; stdout?: string; stderr?: string };
        if (execError.status === undefined || execError.status === null) throw error;
        return { passed: false, output: `${execError.stdout ?? ""}${execError.stderr ?? ""}` };
    }
}

export function runFullSuite(
    taskNumber: number,
    expectedRunId: string,
    worktreePath: string,
    sourceBranch: string,
    stepId: string,
    projectRoot: string,
): RunFullSuiteOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    requireAbsolutePath("worktreePath", worktreePath);
    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, sourceBranch);
    const resolutionManifest = createEmptyResolutionManifest();

    const layers: { occurrenceId: string; passed: boolean }[] = [];
    const outputs: string[] = [];
    for (const occurrence of occurrences) {
        const policyResult = discoverTestPolicy(occurrence.occurrenceId, occurrence.checkoutPath, resolutionManifest);
        // A layer with no discoverable suite has nothing to fail, so it counts as passed.
        if (policyResult.status === "needsResolution") {
            layers.push({ occurrenceId: occurrence.occurrenceId, passed: true });
            outputs.push(`occurrence "${occurrence.occurrenceId}" has no discoverable test suite`);
            continue;
        }
        const layerRun = runCompleteSuite(occurrence.checkoutPath, policyResult.policy.completeSuiteCommand);
        layers.push({ occurrenceId: occurrence.occurrenceId, passed: layerRun.passed });
        outputs.push(layerRun.output);
    }

    const result: RunFullSuiteOutput = {
        stepId,
        passed: layers.every((layer) => layer.passed),
        layers,
        output: truncateOutput(outputs.join("\n")),
    };
    updateCurrentTaskRun(taskNumber, expectedRunId, { fullSuite: { ...result, checkedAt: getLocalIsoTimestamp() } }, projectRoot);
    return result;
}

export type RunFullSuiteCliInput = {
    taskNumber: number;
    expectedRunId: string;
    worktreePath: string;
    sourceBranch: string;
    stepId: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("runFullSuite.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RunFullSuiteCliInput;
    const output = runFullSuite(
        input.taskNumber, input.expectedRunId, input.worktreePath, input.sourceBranch, input.stepId, input.projectRoot,
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
