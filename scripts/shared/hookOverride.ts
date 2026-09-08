// hookOverride.ts: explicit per-run hook override plus pre-approval complete-suite enforcement.
import type { RepositoryManifest } from "./repositoryManifest.ts";
import { HOOK_OVERRIDE_REQUESTED, HOOK_OVERRIDE_NOT_REQUESTED, ALL_SUITES_PASSED, SUITE_FAILURE_DETECTED } from "./resultCodes.ts";

export type HookOverrideInput = { hookOverride?: boolean };

export type ManifestWithHookOverride = RepositoryManifest & { hookOverrideRequested?: boolean };

export type SuiteResult = { id: string; passed: boolean; reason?: string };

export type CompleteSuiteRunner = (id: string) => SuiteResult;

// True only when the explicit override input is present; a disabled hook never implies it.
export function isHookOverrideRequested(input: HookOverrideInput): number {
    return input.hookOverride === true ? HOOK_OVERRIDE_REQUESTED : HOOK_OVERRIDE_NOT_REQUESTED;
}

// Persists the flag on the run manifest so it round-trips through save/load (resume).
export function recordHookOverrideInManifest(
    manifest: ManifestWithHookOverride,
    overrideRequested: boolean
): ManifestWithHookOverride {
    manifest.hookOverrideRequested = overrideRequested;
    return manifest;
}

// Stops startup when the related-test hook is disabled and no override is active.
export function assertHookOverrideOrStopStartup(hookDisabled: boolean, overrideActive: boolean): void {
    if (hookDisabled && !overrideActive) {
        throw new Error("related-test hook is disabled and no override was given; stopping startup");
    }
}

// Runs the complete-suite delegate once per affected repository and parent, right before approval.
export function runCompleteSuitesBeforeApproval(
    affectedRepositories: string[],
    affectedParents: string[],
    runCompleteSuite: CompleteSuiteRunner
): SuiteResult[] {
    return [...affectedRepositories, ...affectedParents].map((id) => runCompleteSuite(id));
}

// Approval proceeds only when every complete-suite result passed; the override never skips this.
export function blockApprovalOnSuiteFailure(results: SuiteResult[]): number {
    return results.every((result) => result.passed) ? ALL_SUITES_PASSED : SUITE_FAILURE_DETECTED;
}
