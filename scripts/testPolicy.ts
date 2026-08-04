// testPolicy.ts: per-occurrence test policy (related-test command, complete-suite command), discovered from package.json scripts or resolved via a persisted answer.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    createResolutionRequest,
    createResolutionRequestId,
    hasResolutionAnswer,
    recordResolutionRequest,
} from "./resolutionRequests.ts";
import type { ResolutionManifest, ResolutionRequest } from "./resolutionRequests.ts";

export const REASON_NO_TEST_CONFIGURATION = "no-test-configuration";
export const REASON_AMBIGUOUS_RELATED_TEST_COMMAND = "ambiguous-related-test-command";

const COMPLETE_SUITE_SCRIPT_KEY = "test";
const RELATED_TEST_SCRIPT_KEY_CANDIDATES = ["test:related", "test:changed", "test:affected"];

export type TestPolicy = {
    occurrenceId: string;
    relatedTestCommand: string;
    completeSuiteCommand: string;
};

export type TestPolicyResult =
    | { status: "resolved"; policy: TestPolicy }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };

function readPackageScripts(checkoutPath: string): Record<string, unknown> | null {
    const packageJsonPath = join(checkoutPath, "package.json");
    if (!existsSync(packageJsonPath)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return null;
    return scripts as Record<string, unknown>;
}

// ponytail: npm run always resolves via a repo's chosen package manager, no need to detect one.
function runScriptCommand(scriptKey: string): string {
    return `npm run ${scriptKey}`;
}

function resolveWithAnswerOrRequest(
    occurrenceId: string,
    candidateScriptKeys: string[],
    reason: string,
    resolutionManifest: ResolutionManifest,
    buildPolicyFromAnswer: (answer: string) => TestPolicy
): TestPolicyResult {
    const requestId = createResolutionRequestId(occurrenceId, reason);
    if (hasResolutionAnswer(resolutionManifest, requestId)) {
        return { status: "resolved", policy: buildPolicyFromAnswer(resolutionManifest.resolutionAnswers[requestId]) };
    }
    const request = createResolutionRequest(occurrenceId, "", candidateScriptKeys, reason);
    recordResolutionRequest(resolutionManifest, request);
    return { status: "needsResolution", resolutionRequests: [request] };
}

export function discoverTestPolicy(
    occurrenceId: string,
    checkoutPath: string,
    resolutionManifest: ResolutionManifest
): TestPolicyResult {
    const scripts = readPackageScripts(checkoutPath);
    const hasCompleteSuite = scripts !== null && COMPLETE_SUITE_SCRIPT_KEY in scripts;
    if (!hasCompleteSuite) {
        return resolveWithAnswerOrRequest(occurrenceId, [], REASON_NO_TEST_CONFIGURATION, resolutionManifest, (answer) => ({
            occurrenceId,
            relatedTestCommand: answer,
            completeSuiteCommand: answer,
        }));
    }

    const relatedCandidates = RELATED_TEST_SCRIPT_KEY_CANDIDATES.filter((key) => key in scripts);
    if (relatedCandidates.length > 1) {
        return resolveWithAnswerOrRequest(
            occurrenceId,
            relatedCandidates,
            REASON_AMBIGUOUS_RELATED_TEST_COMMAND,
            resolutionManifest,
            (answer) => ({
                occurrenceId,
                relatedTestCommand: runScriptCommand(answer),
                completeSuiteCommand: runScriptCommand(COMPLETE_SUITE_SCRIPT_KEY),
            })
        );
    }

    const completeSuiteCommand = runScriptCommand(COMPLETE_SUITE_SCRIPT_KEY);
    const relatedTestCommand = relatedCandidates.length === 1 ? runScriptCommand(relatedCandidates[0]) : completeSuiteCommand;
    return { status: "resolved", policy: { occurrenceId, relatedTestCommand, completeSuiteCommand } };
}
