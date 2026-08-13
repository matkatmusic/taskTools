// "run the full suite" — pipeline.mmd. Walks every occurrence, deepest first (rule 8), and
// runs each layer's complete-suite command. A layer with no discoverable suite is the same
// operational failure the rebase box uses: it throws, never guesses a command.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getOccurrencesDeepestFirst } from "./occurrences.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { discoverTestPolicy } from "../testPolicy.ts";
import { createEmptyResolutionManifest } from "../resolutionRequests.ts";

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
        const stdout = execSync(command, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { passed: true, output: stdout };
    } catch (error) {
        const execError = error as { status?: number | null; stdout?: string; stderr?: string };
        if (execError.status === undefined || execError.status === null) throw error;
        return { passed: false, output: `${execError.stdout ?? ""}${execError.stderr ?? ""}` };
    }
}

export function runFullSuite(
    taskNumber: number,
    worktreePath: string,
    sourceBranch: string,
    stepId: string,
    projectRoot: string,
): RunFullSuiteOutput {
    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, sourceBranch);
    const resolutionManifest = createEmptyResolutionManifest();

    const layers: { occurrenceId: string; passed: boolean }[] = [];
    const outputs: string[] = [];
    for (const occurrence of occurrences) {
        const policyResult = discoverTestPolicy(occurrence.occurrenceId, occurrence.checkoutPath, resolutionManifest);
        if (policyResult.status === "needsResolution") {
            throw new Error(
                `run-failed: occurrence "${occurrence.occurrenceId}" has no discoverable test suite`,
            );
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
    updateCurrentTaskRun(taskNumber, { fullSuite: { ...result, checkedAt: getLocalIsoTimestamp() } }, projectRoot);
    return result;
}

export type RunFullSuiteCliInput = {
    taskNumber: number;
    worktreePath: string;
    sourceBranch: string;
    stepId: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("runFullSuite.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RunFullSuiteCliInput;
    const output = runFullSuite(input.taskNumber, input.worktreePath, input.sourceBranch, input.stepId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
