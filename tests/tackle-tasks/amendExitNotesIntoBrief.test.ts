// Behavioral checks for amendExitNotesIntoBrief.ts. Run alone: node --test tests/tackle-tasks/amendExitNotesIntoBrief.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendExitNotesIntoBrief } from "../../scripts/tackle-tasks/amendExitNotesIntoBrief.ts";
import type { TaskRunRecord } from "../../scripts/tackle-tasks/taskRunState.ts";

function endedRun(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-x", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
        exitType: "tests-red", exitNote: "some note", modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function makeFixture(history: TaskRunRecord[]): { root: string; worktreePath: string } {
    const root = mkdtempSync(join(tmpdir(), "amendExitNotes-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history },
    }], null, 2));
    const worktreePath = mkdtempSync(join(tmpdir(), "amendExitNotes-wt-"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-1.md"), "# Task 1\n\nbrief body\n");
    return { root, worktreePath };
}

test("test_amendExitNotesIntoBrief_writesOneSectionPerPreviousRunNewestFirst", () => {
    // Setup: two previous ended runs, each with an exit type.
    const history = [
        endedRun({ runId: "run-1", exitType: "tests-red", exitNote: "first failure" }),
        endedRun({ runId: "run-2", exitType: "merge-failed", exitNote: "second failure" }),
    ];
    const { root, worktreePath } = makeFixture(history);

    // Test action: amend the exit notes into the fresh brief.
    const result = amendExitNotesIntoBrief(1, worktreePath, root);

    // Verification: two sections, newest run (run-2) appears before the older run-1.
    assert.equal(result.runsAmended, 2);
    const brief = readFileSync(result.briefFile, "utf8");
    const indexOfRun2 = brief.indexOf("run-2");
    const indexOfRun1 = brief.indexOf("run-1");
    assert.ok(indexOfRun2 !== -1 && indexOfRun1 !== -1 && indexOfRun2 < indexOfRun1);
    assert.ok(brief.includes("Exit type: merge-failed"));
    assert.ok(brief.includes("Exit type: tests-red"));
});

test("test_amendExitNotesIntoBrief_capsTheBriefAtThreePreviousRunsAndSaysHowManyWereOmitted", () => {
    // Setup: five previous ended runs, all with an exit type.
    const history = Array.from({ length: 5 }, (_, index) =>
        endedRun({ runId: `run-${index + 1}`, startedAt: `2026-08-0${index + 1}T00:00:00-07:00` }));
    const { root, worktreePath } = makeFixture(history);

    // Test action: amend.
    const result = amendExitNotesIntoBrief(1, worktreePath, root);

    // Verification: only 3 amended, the two oldest are omitted, and the brief says so.
    assert.equal(result.runsAmended, 3);
    const brief = readFileSync(result.briefFile, "utf8");
    assert.ok(brief.includes("(2 earlier runs omitted)"));
    assert.ok(brief.includes("run-5"));
    assert.ok(brief.includes("run-4"));
    assert.ok(brief.includes("run-3"));
    assert.ok(!brief.includes("run-2"));
    assert.ok(!brief.includes("run-1"));
});

test("test_amendExitNotesIntoBrief_writesNothingWhenNoPreviousRunHasAnExitType", () => {
    // Setup: no previous runs recorded at all.
    const { root, worktreePath } = makeFixture([]);
    const briefFile = join(worktreePath, "plans", "brief-1.md");
    const before = readFileSync(briefFile, "utf8");

    // Test action: amend.
    const result = amendExitNotesIntoBrief(1, worktreePath, root);

    // Verification: runsAmended is 0 and the brief file is untouched.
    assert.equal(result.runsAmended, 0);
    assert.equal(readFileSync(briefFile, "utf8"), before);
});
