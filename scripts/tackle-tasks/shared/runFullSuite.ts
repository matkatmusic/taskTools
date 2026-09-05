// "run the full suite" — pipeline-suite.mmd. Runs each layer's suite, deepest first; a layer without one passes.
import { readFileSync } from "node:fs";
import { getOccurrencesDeepestFirst } from "./occurrences.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { discoverTestPolicy } from "../../testPolicy.ts";
import { createEmptyResolutionManifest } from "../../resolutionRequests.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { parseFailingTests, readKnownFailingTests, newFailingTests, judgeSuite, runCommandInProcessGroup, SUITE_TIMEOUT_MS } from "../../taskTestsRunner.ts";

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

async function runCompleteSuite(checkoutPath: string, command: string, timeoutMs: number): Promise<{ passed: boolean; output: string; timedOut: boolean }> {
    // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
    const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
    const run = await runCommandInProcessGroup(command, checkoutPath, env, timeoutMs);
    if (run.timedOut) return { passed: false, timedOut: true, output: `${run.output}\nthe full suite timed out after ${timeoutMs}ms and was killed` };
    return { passed: run.code === 0, timedOut: false, output: run.output };
}

export async function runFullSuite(
    taskNumber: number,
    expectedRunId: string,
    worktreePath: string,
    sourceBranch: string,
    stepId: string,
    projectRoot: string,
    totalTimeoutMs: number = SUITE_TIMEOUT_MS,
): Promise<RunFullSuiteOutput> {
    requireAbsolutePath("projectRoot", projectRoot);
    requireAbsolutePath("worktreePath", worktreePath);
    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, sourceBranch);
    const resolutionManifest = createEmptyResolutionManifest();

    const layers: { occurrenceId: string; passed: boolean }[] = [];
    const outputs: string[] = [];
    const deadlineAt = Date.now() + totalTimeoutMs;
    for (const occurrence of occurrences) {
        const policyResult = discoverTestPolicy(occurrence.occurrenceId, occurrence.checkoutPath, resolutionManifest);
        // A layer with no discoverable suite has nothing to fail, so it counts as passed.
        if (policyResult.status === "needsResolution") {
            layers.push({ occurrenceId: occurrence.occurrenceId, passed: true });
            outputs.push(`occurrence "${occurrence.occurrenceId}" has no discoverable test suite`);
            continue;
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
            layers.push({ occurrenceId: occurrence.occurrenceId, passed: false });
            outputs.push(`occurrence "${occurrence.occurrenceId}" was not run: the full-suite budget (${totalTimeoutMs}ms) was already spent`);
            continue;
        }
        const layerRun = await runCompleteSuite(occurrence.checkoutPath, policyResult.policy.completeSuiteCommand, remainingMs);
        let layerPassed = layerRun.passed;
        let layerOutput = layerRun.output;
        if (!layerRun.passed) {
            if (!layerRun.timedOut) {
                const failing = parseFailingTests(layerRun.output);
                const newFailures = newFailingTests(failing, readKnownFailingTests(projectRoot));
                const knownStillFailing = failing.filter((test) => !newFailures.includes(test));
                layerPassed = judgeSuite(false, failing, newFailures);
                layerOutput = [
                    ...newFailures.map((test) => `new failing test: ${test.file} — ${test.name}`),
                    ...knownStillFailing.map((test) => `known failing test (ignored): ${test.file} — ${test.name}`),
                    layerRun.output,
                ].join("\n");
            }
        }
        layers.push({ occurrenceId: occurrence.occurrenceId, passed: layerPassed });
        outputs.push(layerOutput);
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
    const output = await runFullSuite(
        input.taskNumber, input.expectedRunId, input.worktreePath, input.sourceBranch, input.stepId, input.projectRoot,
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
