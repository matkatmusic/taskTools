// Behavioral checks for scripts/tackle-tasks/greenBoxPolicy.ts. Run: node --test tests/tackle-tasks/greenBoxPolicy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    GREEN_BOX_POLICY,
    NON_DISPATCHED_SCRIPTS,
    getGreenBoxCategory,
    getMutatingWorkflowScripts,
} from "../../scripts/tackle-tasks/greenBoxPolicy.ts";
import { getReconciliationHandlerNames } from "../../scripts/tackle-tasks/reconcileStep.ts";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "tackle-tasks");
const workflowSourcePath = join(
    dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "tackle-tasks", "tackle-tasks.workflow.js",
);

test("test_greenBoxPolicy_namesEveryScriptInTheScriptsDirectory", () => {
    // Setup: every *.ts basename actually present in scripts/tackle-tasks/.
    const onDisk = new Set(
        readdirSync(scriptsDir).filter((name) => name.endsWith(".ts")).map((name) => name.replace(/\.ts$/, "")),
    );

    // Test action: the classified set is the policy map's keys plus the non-dispatched list.
    const classified = new Set([...Object.keys(GREEN_BOX_POLICY), ...NON_DISPATCHED_SCRIPTS]);
    const overlap = Object.keys(GREEN_BOX_POLICY).filter((name) => NON_DISPATCHED_SCRIPTS.includes(name));

    // Verification: every script on disk is classified exactly once, no unclassified script slips in.
    assert.deepEqual(classified, onDisk);
    assert.deepEqual(overlap, []);
});

test("test_greenBoxPolicy_hasAReconciliationHandlerForEveryMutatingWorkflowScript", () => {
    assert.deepEqual(getMutatingWorkflowScripts(), getReconciliationHandlerNames());
});

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
        "isTaskNumberValid", "isTaskOpen", "isTaskBlocked", "doesTaskWorktreeExist",
        "checkTaskWorktreeSafe", "checkTaskFileFence", "validatePlanFile", "validateCodexReview",
        "buildClosureNote", "resolveTaskRun",
    ];

    for (const scriptName of readOnlyBoxes) {
        assert.equal(getGreenBoxCategory(scriptName), "read-only", scriptName);
    }
});
