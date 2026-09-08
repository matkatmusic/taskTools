// Behavioral checks for AMEND_ENTRY_WITH_FAILING_TESTS.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./AMEND_ENTRY_WITH_FAILING_TESTS.ts";
import { getAttemptCount } from "../shared/taskRunState.ts";
import { writeCheckpoint, type Checkpoint } from "../shared/checkpoint.ts";

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
                    runId: "run-1", startedAt: "2026-08-18T00:00:00", endedAt: null, exitType: null, exitNote: null,
                    modifiedFiles: [], commits: [], implementationNotesFile: null, fullSuite: null,
                    taskTests: {
                        stepId: "RUN_TASK_TESTS", testFiles: [], createdTestFiles: [], deletedTestFiles: [],
                        missingTests: false, passed: false, output: "SENTINEL_FAILING_TESTS", checkedAt: "2026-08-18T00:00:00",
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

const worktreeOf = (root: string) => join(root, "worktree");

function seedCheckpoint(worktree: string, passId: string): void {
    const checkpoint: Checkpoint = {
        taskNumber: 1, passId, runId: "run-1", projectRoot: worktree,
        block: "pipeline-taskTests.mmd::AMEND_ENTRY_WITH_FAILING_TESTS", input: "{}",
        state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    };
    writeCheckpoint(worktree, checkpoint);
}

test("test_main_writesNotesAndRaisesTheTestFixesCounter", () => {
    const root = makeProjectRootFromFixture();
    seedCheckpoint(worktreeOf(root), "pass-0");
    const input = { box: "ARE_2_TEST_FIXES_DONE_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot: root, worktree: worktreeOf(root), branch: "task-1", exitType: "", exitNote: "" };
    const output = main(JSON.stringify(input));

    assert.deepEqual(output, { ...input, box: "AMEND_ENTRY_WITH_FAILING_TESTS" });
    assert.match(entryOf(root).codexReviewNotes, /SENTINEL_FAILING_TESTS/);
    assert.equal(getAttemptCount(1, "testFixes", root), 1);
});

test("test_AMEND_ENTRY_WITH_FAILING_TESTS_countsOnceWhenRunTwiceWithTheSameCheckpoint", () => {
    const root = makeProjectRootFromFixture();
    seedCheckpoint(worktreeOf(root), "pass-1");
    const input = { box: "ARE_2_TEST_FIXES_DONE_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot: root, worktree: worktreeOf(root), branch: "task-1", exitType: "", exitNote: "" };

    main(JSON.stringify(input));
    main(JSON.stringify(input));

    assert.equal(getAttemptCount(1, "testFixes", root), 1);
});

test("test_AMEND_ENTRY_WITH_FAILING_TESTS_throwsWithoutACheckpoint", () => {
    const root = makeProjectRootFromFixture();
    const input = { box: "ARE_2_TEST_FIXES_DONE_Q", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot: root, worktree: worktreeOf(root), branch: "task-1", exitType: "", exitNote: "" };

    assert.throws(() => main(JSON.stringify(input)), /no checkpoint/);
});
