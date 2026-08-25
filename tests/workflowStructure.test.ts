// Structural checks for skills/tackle-tasks/tackle-tasks.workflow.js.
// Run: node --test tests/workflowStructure.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, "skills", "tackle-tasks", "tackle-tasks.workflow.js");

const workflowSource = readFileSync(workflowPath, "utf8");

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
