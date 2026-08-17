// Run: node --test tests/generateTaskWorkflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generatedWorkflow } from "../scripts/tackle-tasks/generateTaskWorkflow.ts";

const WORKFLOW_PATH = fileURLToPath(new URL("../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));

test("test_generateTaskWorkflow_committedWorkflowMatchesWhatTheGeneratorProduces", () => {
    // A stale committed file is the drift the generator exists to prevent, so it must fail the suite.
    assert.equal(readFileSync(WORKFLOW_PATH, "utf8"), generatedWorkflow());
});

test("test_generateTaskWorkflow_splicesTheRealValidatorNotACopy", () => {
    // Setup: the workflow sandbox forbids import, so the validator is spliced in as source text.
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const planArtifacts = readFileSync(fileURLToPath(new URL("../scripts/tackle-tasks/planArtifacts.ts", import.meta.url)), "utf8");

    // Verification: every problem message the TypeScript raises appears verbatim in the workflow.
    for (const problem of planArtifacts.matchAll(/\{ problem: (["`])plan [^\n]*?\1 \}/g)) {
        assert.ok(workflow.includes(problem[0]), `the workflow is missing ${problem[0]}`);
    }
});
