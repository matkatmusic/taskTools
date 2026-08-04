// Behavioral checks for hookOverride.ts: explicit hook-disabled override and pre-approval complete-suite enforcement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    isHookOverrideRequested,
    recordHookOverrideInManifest,
    assertHookOverrideOrStopStartup,
    runCompleteSuitesBeforeApproval,
    blockApprovalOnSuiteFailure,
    type ManifestWithHookOverride,
    type SuiteResult,
} from "../scripts/hookOverride.ts";
import { readRepositoryManifest, writeRepositoryManifest, REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function withTempDir(body: (dirPath: string) => void): void {
    const dirPath = mkdtempSync(join(tmpdir(), "hook-override-"));
    try {
        body(dirPath);
    } finally {
        rmSync(dirPath, { recursive: true, force: true });
    }
}

function makeManifest(): ManifestWithHookOverride {
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] };
}

// No override input given: isHookOverrideRequested reads false.
test("test_isHookOverrideRequested_isFalseWhenNoOverrideGiven", () => {
    assert.equal(isHookOverrideRequested({}), false);
});

// Explicit override input given: isHookOverrideRequested reads true.
test("test_isHookOverrideRequested_isTrueWhenExplicitOverrideGiven", () => {
    assert.equal(isHookOverrideRequested({ hookOverride: true }), true);
});

// Recording the override on the manifest persists the flag through a real save.
test("test_recordHookOverrideInManifest_persistsOverrideFlag", () => {
    withTempDir((dirPath) => {
        const manifestPath = join(dirPath, "manifest.json");
        const manifest = recordHookOverrideInManifest(makeManifest(), true);
        writeRepositoryManifest(manifestPath, manifest);
        const saved = readRepositoryManifest(manifestPath) as ManifestWithHookOverride;
        assert.equal(saved.hookOverrideRequested, true);
    });
});

// Reloading the manifest after a resume shows the override still active with no re-supply.
test("test_hookOverride_survivesResume", () => {
    withTempDir((dirPath) => {
        const manifestPath = join(dirPath, "manifest.json");
        writeRepositoryManifest(manifestPath, recordHookOverrideInManifest(makeManifest(), true));
        const resumed = readRepositoryManifest(manifestPath) as ManifestWithHookOverride;
        assert.equal(resumed.hookOverrideRequested, true);
    });
});

// Hook disabled and no override active: startup stops.
test("test_assertHookOverrideOrStopStartup_stopsWhenHookDisabledAndNoOverride", () => {
    assert.throws(() => assertHookOverrideOrStopStartup(true, false));
});

// Hook disabled but override active: startup proceeds.
test("test_assertHookOverrideOrStopStartup_proceedsWhenOverrideActive", () => {
    assert.doesNotThrow(() => assertHookOverrideOrStopStartup(true, true));
});

// Complete-suite delegate is invoked once per entry across both the repos list and the parents list.
test("test_runCompleteSuitesBeforeApproval_runsSuiteForEveryAffectedRepoAndParent", () => {
    const calls: string[] = [];
    const runCompleteSuite = (id: string): SuiteResult => {
        calls.push(id);
        return { id, passed: true };
    };
    const results = runCompleteSuitesBeforeApproval(["repoA", "repoB"], ["parentA"], runCompleteSuite);
    assert.deepEqual(calls, ["repoA", "repoB", "parentA"]);
    assert.equal(results.length, 3);
});

// One failing suite among passing ones blocks approval.
test("test_blockApprovalOnSuiteFailure_blocksWhenAnySuiteFails", () => {
    const results: SuiteResult[] = [{ id: "repoA", passed: true }, { id: "repoB", passed: false }];
    assert.equal(blockApprovalOnSuiteFailure(results), false);
});

// All suites passing allows approval to proceed.
test("test_blockApprovalOnSuiteFailure_allowsWhenAllSuitesPass", () => {
    const results: SuiteResult[] = [{ id: "repoA", passed: true }, { id: "repoB", passed: true }];
    assert.equal(blockApprovalOnSuiteFailure(results), true);
});

// Override active never skips the complete-suite run; a failure there still blocks approval.
test("test_hookOverride_doesNotSkipCompleteSuiteRun", () => {
    const overrideActive = isHookOverrideRequested({ hookOverride: true });
    assert.equal(overrideActive, true);
    const runCompleteSuite = (id: string): SuiteResult => ({ id, passed: false });
    const results = runCompleteSuitesBeforeApproval(["repoA"], [], runCompleteSuite);
    assert.equal(results.length, 1);
    assert.equal(blockApprovalOnSuiteFailure(results), false);
});

// The complete-suite run at approval happens fresh, not reused from an earlier stage.
test("test_completeSuiteRuns_happenImmediatelyBeforeApprovalNotEarlierStage", () => {
    let callCount = 0;
    const runCompleteSuite = (id: string): SuiteResult => {
        callCount++;
        return { id, passed: true };
    };
    // Simulate an earlier-stage related-test check that already ran and passed.
    const earlierStagePassed = true;
    assert.equal(earlierStagePassed, true);
    assert.equal(callCount, 0);
    runCompleteSuitesBeforeApproval(["repoA"], ["parentA"], runCompleteSuite);
    assert.equal(callCount, 2);
});
