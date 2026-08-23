// Structural checks for skills/tackle-tasks/tackle-tasks.workflow.js.
// Run: node --test tests/tackle-tasks/workflowStructure.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, "skills", "tackle-tasks", "tackle-tasks.workflow.js");
const diagramPath = join(repoRoot, "plans", "diagram", "pipeline.mmd");

const workflowSource = readFileSync(workflowPath, "utf8");

// Every counter the diagrams cap, one per loop that can repeat.
// The hook owns each cap now, so the workflow names the decision, not the counter.
const repairDecisions = [
    "ARE_2_CLARIFY_ROUNDS_DONE", "ARE_2_REVIEWS_DONE", "ARE_2_TEST_FIXES_DONE", "ARE_2_TEST_REVIEWS_DONE",
    "ARE_2_CONFLICT_FIXES_DONE", "ARE_2_SUITE_FIXES_DONE", "ARE_2_MERGE_ATTEMPTS_DONE",
];

// The three exit types the preamble owns, so the workflow must never name them.
const preambleExitTypes = ["invalid-number", "already-active", "blocked"];

// The spliced pipelines quote with ", the template with ', so neither style may hide a name.
const namesExitType = (exitType: string) => new RegExp(`["']${exitType}["']`).test(workflowSource);

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
    const listStart = diagram.indexOf("Master exit-type list, one per path that reaches [stop]:");
    const listEnd = diagram.indexOf("cleanup-incomplete is a repair flag");
    assert.ok(listStart !== -1 && listEnd > listStart, "the diagram no longer lists its exit types");

    // Test action: each listed line reads "%%   <exit-type>   - <description>".
    const exitTypes = diagram
        .slice(listStart, listEnd)
        .split("\n")
        .map((line) => /^%%\s{3,}([a-z-]+)\s+-\s/.exec(line))
        .filter((match) => match !== null)
        .map((match) => match[1]);
    assert.equal(exitTypes.length, 15);

    // Verification: the workflow names every exit type the preamble does not own.
    for (const exitType of exitTypes) {
        if (preambleExitTypes.includes(exitType as string)) continue;
        assert.ok(namesExitType(exitType as string), `workflow never names exit type ${exitType}`);
    }

    // Verification: a preamble exit belongs to runPreamble, so the workflow must never write one.
    for (const exitType of preambleExitTypes) {
        assert.equal(namesExitType(exitType), false, `workflow names preamble exit type ${exitType}`);
    }
});

test("test_workflow_capsEveryRetryLoopAtTwoAttempts", () => {
    // Setup: one shared cap, beside the counters it caps, so no loop can drift to another number.
    const counterSource = readFileSync(join(repoRoot, "scripts", "tackle-tasks", "taskRunState.ts"), "utf8");
    assert.ok(counterSource.includes("export const MAX_ATTEMPTS = 2"));

    // Verification: every repair loop asks the hook for its cap decision.
    for (const decision of repairDecisions) {
        assert.ok(
            workflowSource.includes(`decideStep(ctx, "${decision}")`),
            `${decision} is not asked`,
        );
    }

    // Verification: no loop invents its own numeric cap.
    assert.doesNotMatch(workflowSource, />=\s*[3-9]\b/);
});
