// Structural checks for skills/tackle-tasks/tackle-tasks.workflow.js.
// Run: node --test tests/tackle-tasks/workflowStructure.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GREEN_BOX_POLICY } from "../../scripts/tackle-tasks/greenBoxPolicy.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, "skills", "tackle-tasks", "tackle-tasks.workflow.js");
const diagramPath = join(repoRoot, "plans", "diagram", "pipeline.mmd");

const workflowSource = readFileSync(workflowPath, "utf8");

// The six repair counters the plan's retry pseudocode names, one per loop the diagram caps.
const repairCounters = [
    "planScraps", "testFixes", "testAmendments", "conflictFixes", "suiteFixes", "mergeAttempts",
];

// The script name may sit on the line after the helper name, so allow the line break.
const dispatches = (helperName: string, scriptName: string) =>
    new RegExp(`${helperName}\\(\\s*'${scriptName}'`).test(workflowSource);

test("test_workflow_declaresMetaAsTheFirstStatement", () => {
    // Setup: drop leading blank lines and comments, which are not statements.
    const firstStatement = workflowSource
        .split("\n")
        .find((line) => line.trim() !== "" && !line.trim().startsWith("//"));

    // Verification: a dynamic meta built later in the file is the bug this test exists to catch.
    assert.equal(firstStatement, "export const meta = {");
});

test("test_workflow_containsNoRequireOrProcessOrImport", () => {
    // The workflow sandbox leaves require and process undefined and rejects any import statement.
    assert.doesNotMatch(workflowSource, /\brequire\s*\(/);
    assert.doesNotMatch(workflowSource, /\bprocess\s*\./);
    assert.doesNotMatch(workflowSource, /^\s*import\s/m);
    assert.doesNotMatch(workflowSource, /\bimport\s*\(/);
});

test("test_workflow_containsNoBacktickCommandSubstitutionInsideAnAgentPrompt", () => {
    // Every prompt is a template literal, so the only way to embed a backtick is to escape it.
    assert.equal(workflowSource.includes("\\`"), false, "an agent prompt embeds a backtick");

    // Verification: no POSIX command substitution either.
    assert.doesNotMatch(workflowSource, /\$\(/);
});

test("test_workflow_referencesEveryExitTypeFromTheDiagram", () => {
    // Setup: read the diagram's own exit-type list, so code and spec cannot drift apart.
    const diagram = readFileSync(diagramPath, "utf8");
    const listStart = diagram.indexOf("Exit types, one per path that reaches [stop]:");
    const listEnd = diagram.indexOf("run-failed is deliberately not drawn");
    assert.ok(listStart !== -1 && listEnd > listStart, "the diagram no longer lists its exit types");

    // Test action: each listed line reads "%%   <exit-type>   - <description>".
    const exitTypes = diagram
        .slice(listStart, listEnd)
        .split("\n")
        .map((line) => /^%%\s{3,}([a-z-]+)\s+-\s/.exec(line))
        .filter((match) => match !== null)
        .map((match) => match[1]);
    assert.equal(exitTypes.length, 13);

    // Verification: the workflow names every one of them.
    for (const exitType of exitTypes) {
        assert.ok(workflowSource.includes(`'${exitType}'`), `workflow never names exit type ${exitType}`);
    }
});

test("test_workflow_reconcilesRatherThanRetryingEveryMutatingScript", () => {
    // Setup: greenBoxPolicy.ts is the authority on which box may be blindly retried.
    const mutating = Object.keys(GREEN_BOX_POLICY).filter((name) => GREEN_BOX_POLICY[name] === "mutating");
    const readOnly = Object.keys(GREEN_BOX_POLICY).filter((name) => GREEN_BOX_POLICY[name] === "read-only");

    // Verification: every mutating box is dispatched through the reconciling helper.
    for (const scriptName of mutating) {
        assert.ok(
            dispatches("runMutatingScript", scriptName),
            `${scriptName} is mutating but the workflow does not dispatch it through runMutatingScript`,
        );
        assert.equal(
            dispatches("runReadOnlyScript", scriptName), false,
            `${scriptName} is mutating but the workflow retries it as read-only`,
        );
    }

    // Verification: a read-only box is never sent down the reconciling path.
    for (const scriptName of readOnly) {
        assert.equal(
            dispatches("runMutatingScript", scriptName), false,
            `${scriptName} is read-only but the workflow reconciles it`,
        );
    }

    // Verification: reconciliation is what a lost mutating result reaches, and it is itself read-only.
    assert.ok(dispatches("runReadOnlyScript", "reconcileStep"));
});

test("test_workflow_capsEveryRetryLoopAtTwoAttempts", () => {
    // Setup: one shared cap, so no loop can drift to a different number of attempts.
    assert.ok(workflowSource.includes("const MAX_REPAIR_ATTEMPTS = 2"));

    // Verification: every repair counter is checked against that cap.
    for (const counter of repairCounters) {
        assert.ok(
            workflowSource.includes(`${counter} >= MAX_REPAIR_ATTEMPTS`),
            `${counter} is not capped at MAX_REPAIR_ATTEMPTS`,
        );
    }

    // Verification: no loop invents its own numeric cap.
    assert.doesNotMatch(workflowSource, />=\s*[3-9]\b/);
});

test("test_workflow_passesRevisionBeforeToApplyPlanAmendments", () => {
    // Setup: reconcileApplyPlanAmendments returns ambiguous unless stepInput carries revisionBefore.
    const dispatch = workflowSource.slice(workflowSource.indexOf("'applyPlanAmendments'"));

    // Verification: the observed revision travels with the step input, not just the file paths.
    assert.match(dispatch.slice(0, 400), /revisionBefore:\s*planValid\.value\.revision/);
});
