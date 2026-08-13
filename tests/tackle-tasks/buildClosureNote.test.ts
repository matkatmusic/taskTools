// Behavioral checks for scripts/tackle-tasks/buildClosureNote.ts.
// Run: node --test tests/tackle-tasks/buildClosureNote.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClosureNote } from "../../scripts/tackle-tasks/buildClosureNote.ts";
import type { TaskRunRecord } from "../../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "buildClosureNote-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function endedRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:10:00-07:00",
        exitType: "completed", exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

test("test_buildClosureNote_namesEveryCommitIncludingSubmoduleOnes", () => {
    // Setup: a finished run whose commits span both a submodule occurrence and the root.
    const root = makeProjectRootWithTasks([{
        taskNumber: 169, title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [endedRunRecord({
                commits: [
                    { occurrenceId: "sub/a", hash: "a1b2c3d", kind: "work" },
                    { occurrenceId: "", hash: "e4f5g6h", kind: "work" },
                    { occurrenceId: "", hash: "9i8j7k6", kind: "merge" },
                ],
                modifiedFiles: ["scripts/foo.ts", "sub/a::tests/bar.test.ts"],
                taskTests: {
                    stepId: "s1", testFiles: ["tests/bar.test.ts"], createdTestFiles: [],
                    missingTests: false, passed: true, output: "", checkedAt: "2026-08-01T00:05:00-07:00",
                },
                fullSuite: {
                    stepId: "s2", layers: [{ occurrenceId: "", passed: true }],
                    passed: true, output: "", checkedAt: "2026-08-01T00:06:00-07:00",
                },
            })],
        },
    }]);

    // Test action: build the closure note.
    const output = buildClosureNote({ taskNumber: 169, projectRoot: root });

    // Verification: every commit is named, the submodule one labeled by its occurrence,
    // the root ones labeled "(root)".
    assert.match(output.closureNote, /a1b2c3d\s+sub\/a\s+work/);
    assert.match(output.closureNote, /e4f5g6h\s+\(root\)\s+work/);
    assert.match(output.closureNote, /9i8j7k6\s+\(root\)\s+merge/);
    assert.match(output.closureNote, /Task 169 completed\./);
    assert.match(output.closureNote, /scripts\/foo\.ts, sub\/a::tests\/bar\.test\.ts/);
    assert.match(output.closureNote, /Task tests: 1 files, green/);
    assert.match(output.closureNote, /Full suite: green/);
});

test("test_buildClosureNote_rendersNotRecordedWhenATestResultIsMissing", () => {
    // Setup: a finished run whose taskTests and fullSuite were never recorded — for example
    // an early exit, before those boxes ran.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [endedRunRecord({ exitType: "blocked", taskTests: null, fullSuite: null })],
        },
    }]);

    // Test action: build the closure note.
    const output = buildClosureNote({ taskNumber: 1, projectRoot: root });

    // Verification: both render "(not recorded)" instead of failing.
    assert.match(output.closureNote, /Task tests: \(not recorded\)/);
    assert.match(output.closureNote, /Full suite: \(not recorded\)/);
});

test("test_buildClosureNote_runsWithoutAWorktree", () => {
    // Setup: a finished run with no worktree field set at all — this box runs after clean-up
    // deleted it, and must not touch the filesystem for anything but tasks.json.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [endedRunRecord({
                commits: [{ occurrenceId: "", hash: "abc123", kind: "merge" }],
                modifiedFiles: ["a.ts"],
            })],
        },
    }]);

    // Test action + verification: building the closure note does not throw.
    const output = buildClosureNote({ taskNumber: 1, projectRoot: root });
    assert.match(output.closureNote, /Task 1 completed\./);
});
