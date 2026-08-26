// Behavioral checks for scripts/steps/pipeline-taskTests/AMEND_ENTRY_WITH_FAILING_TESTS.ts.  Run: node --test tests/steps/pipeline-taskTests/AMEND_ENTRY_WITH_FAILING_TESTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-taskTests/AMEND_ENTRY_WITH_FAILING_TESTS.ts";
import { getAttemptCount } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(import.meta.dirname, "../../../scripts/steps/pipeline-taskTests/AMEND_ENTRY_WITH_FAILING_TESTS.template.json");

const FIXTURE_TASKS = [
    {
        taskNumber: 1,
        title: "fixture task",
        files: ["src/owned.ts"],
        codexReviewNotes: "",
        run: {
            active: true,
            worktree: "/abs/worktree",
            leaseRunId: "run-1",
            history: [
                {
                    runId: "run-1",
                    startedAt: "2026-08-18T00:00:00",
                    endedAt: null,
                    exitType: null,
                    exitNote: null,
                    modifiedFiles: [],
                    commits: [],
                    implementationNotesFile: null,
                    fullSuite: null,
                    taskTests: {
                        stepId: "RUN_TASK_TESTS",
                        testFiles: [],
                        createdTestFiles: [],
                        deletedTestFiles: [],
                        missingTests: false,
                        passed: false,
                        output: "SENTINEL_FAILING_TESTS",
                        checkedAt: "2026-08-18T00:00:00",
                    },
                },
            ],
        },
    },
];

// Mutating: this block writes tasks.json, so every test copies the fixture into its own temp dir.
function makeProjectRootFromFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "amend-entry-with-failing-tests-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify(FIXTURE_TASKS));
    return root;
}

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

test("test_AMEND_ENTRY_WITH_FAILING_TESTS_writesNotesAndRaisesTheTestFixesCounter", () => {
    const root = makeProjectRootFromFixture();
    const packet = { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: root };
    const output = main(JSON.stringify({ box: "ARE_2_TEST_FIXES_DONE", scriptSignal: "continue", ...packet, exitType: "", exitNote: "", next: "AMEND_ENTRY_WITH_FAILING_TESTS" }));

    assert.deepEqual(output, { box: "AMEND_ENTRY_WITH_FAILING_TESTS", scriptSignal: "continue", ...packet, amendFailingTests: true });
    assert.match(entryOf(root).codexReviewNotes, /SENTINEL_FAILING_TESTS/);
    assert.equal(getAttemptCount(1, "testFixes", root), 1);
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
