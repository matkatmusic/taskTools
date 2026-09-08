// Behavioral checks for scripts/tackle-tasks/greenBoxPolicy.ts. Run: node --test tests/greenBoxPolicy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    GREEN_BOX_POLICY,
    NON_DISPATCHED_SCRIPTS,
    getGreenBoxCategory,
} from "./greenBoxPolicy.ts";

const workflowSourcePath = join(
    dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "tackle-tasks", "tackle-tasks.workflow.js",
);

test("test_greenBoxPolicy_keepsTheMaintenanceScriptOutOfWorkflowSource", () => {
    // Setup: the workflow never invokes recovery itself — diagram rule 9.
    assert.equal(getGreenBoxCategory("recoverSourceRepoLock"), "maintenance-mutating");

    // Verification: the workflow source never names the maintenance script.
    const workflowSource = readFileSync(workflowSourcePath, "utf8");
    assert.equal(workflowSource.includes("recoverSourceRepoLock"), false);
});

test("test_greenBoxPolicy_treatsBothTestBoxesAsMutating", () => {
    // Both test boxes write their durable decision to task.run before printing stdout.
    assert.equal(getGreenBoxCategory("runTaskTests"), "mutating");
    assert.equal(getGreenBoxCategory("runFullSuite"), "mutating");
});

test("test_greenBoxPolicy_throwsForAnUnknownScriptName", () => {
    assert.throws(() => getGreenBoxCategory("notAScript"));
});

test("test_greenBoxPolicy_classifiesEveryReadOnlyBoxFromTheDiagram", () => {
    const readOnlyBoxes = [
        "isTaskNumberValid", "isTaskBlocked", "doesTaskWorktreeExist",
        "checkTaskWorktreeSafe", "checkTaskFileFence", "validatePlanFile", "validateCodexReview",
        "buildClosureNote", "resolveTaskRun",
    ];

    for (const scriptName of readOnlyBoxes) {
        assert.equal(getGreenBoxCategory(scriptName), "read-only", scriptName);
    }
});

test("test_greenBoxPolicy_classifiesEveryScriptRunStepHookDispatchesAsMutating", () => {
    // Setup: these scripts write tasks.json or plan.json when the hook dispatches their box.
    const dispatchedMutatingScripts = ["amendEntryWithCodexNotes", "amendEntryWithFailingTests", "recordPlanReview"];
    for (const scriptName of dispatchedMutatingScripts) {
        // Test action: look up the category the hook's dispatch needs to see.
        const category = getGreenBoxCategory(scriptName);
        // Verification: each script is classified as mutating.
        assert.equal(category, "mutating", scriptName);
    }
});

test("test_greenBoxPolicy_classifiesReadPublicationStateAsReadOnly", () => {
    // Setup: readPublicationState only reads merge refs, per its own file comment.
    const category = getGreenBoxCategory("readPublicationState");
    // Verification: it is classified as read-only.
    assert.equal(category, "read-only");
});

test("test_greenBoxPolicy_removesRunStepHookDispatchedScriptsFromNonDispatchedList", () => {
    // Setup: these four scripts are imported and called by runStepHook.ts's STEP_TABLE.
    const dispatchedScripts = [
        "amendEntryWithCodexNotes", "amendEntryWithFailingTests", "readPublicationState", "recordPlanReview",
    ];
    for (const scriptName of dispatchedScripts) {
        // Test action: check whether the script is still marked as never dispatched.
        const stillNonDispatched = NON_DISPATCHED_SCRIPTS.includes(scriptName);
        // Verification: a dispatched script is not in NON_DISPATCHED_SCRIPTS.
        assert.equal(stillNonDispatched, false, scriptName);
    }
});

test("test_greenBoxPolicy_keepsScriptsRunStepHookDoesNotDispatchInNonDispatchedList", () => {
    // Setup: sourceRepoLock is a dependency of lockSourceRepo.ts, not the hook's own import.
    const stillNonDispatchedScripts = ["sourceRepoLock", "decideTestReview"];
    for (const scriptName of stillNonDispatchedScripts) {
        // Test action: check the script is still marked as never dispatched.
        const stillNonDispatched = NON_DISPATCHED_SCRIPTS.includes(scriptName);
        // Verification: it remains in NON_DISPATCHED_SCRIPTS, and lookup still throws for it.
        assert.equal(stillNonDispatched, true, scriptName);
        assert.throws(() => getGreenBoxCategory(scriptName));
    }
});

test("test_greenBoxPolicy_keepsPolicyAndNonDispatchedListDisjoint", () => {
    // Setup: the moved names must not appear in both places at once.
    const movedScripts = ["amendEntryWithCodexNotes", "amendEntryWithFailingTests", "readPublicationState", "recordPlanReview"];
    for (const scriptName of movedScripts) {
        // Test action: check the script is a policy key.
        const isPolicyKey = scriptName in GREEN_BOX_POLICY;
        // Verification: a policy key is never also listed as non-dispatched.
        assert.equal(isPolicyKey, true, scriptName);
        assert.equal(NON_DISPATCHED_SCRIPTS.includes(scriptName), false, scriptName);
    }
});
