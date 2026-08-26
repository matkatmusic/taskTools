// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/BUILD_CLOSURE_NOTE.ts.
// Ported from tests/buildClosureNote.test.ts. Run: node --test tests/steps/pipeline-mergeSucceededExit/BUILD_CLOSURE_NOTE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/BUILD_CLOSURE_NOTE.ts";
import type { TaskRunRecord } from "../../../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "build-closure-note-"));
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

function samplePacket(projectRoot: string, taskNumber: number, runId: string): Record<string, unknown> {
    return { box: "CLEAN_UP_WORKTREES", scriptSignal: "continue", projectRoot, taskNumber, runId };
}

test("test_BUILD_CLOSURE_NOTE_namesEveryCommitIncludingSubmoduleOnes", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 169, title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [endedRunRecord({
                commits: [
                    { occurrenceId: "sub/a", hash: "a1b2c3d", kind: "work" },
                    { occurrenceId: "", hash: "9i8j7k6", kind: "merge" },
                ],
                modifiedFiles: ["scripts/foo.ts"],
            })],
        },
    }]);

    const output = main(JSON.stringify(samplePacket(root, 169, "run-a")));

    assert.equal(output.box, "BUILD_CLOSURE_NOTE");
    assert.equal(output.scriptSignal, "continue");
    assert.match(output.closureNote as string, /a1b2c3d\s+sub\/a\s+work/);
    assert.match(output.closureNote as string, /9i8j7k6\s+\(root\)\s+merge/);
    assert.match(output.closureNote as string, /Task 169 completed\./);
});

test("test_BUILD_CLOSURE_NOTE_throwsWithASiblingRunId", () => {
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-b" })] },
    }]);

    assert.throws(() => main(JSON.stringify(samplePacket(root, 1, "run-a"))));
});
