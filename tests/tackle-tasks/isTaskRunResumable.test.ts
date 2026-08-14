// Behavioral checks for isTaskRunResumable.ts. Run alone: node --test tests/tackle-tasks/isTaskRunResumable.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskRunResumable } from "../../scripts/tackle-tasks/isTaskRunResumable.ts";
import type { TaskRunRecord } from "../../scripts/tackle-tasks/taskRunState.ts";

function endedRun(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-old", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
        exitType: "run-failed", exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function activeRun(runId: string): TaskRunRecord {
    return {
        runId, startedAt: "2026-08-02T00:00:00-07:00", endedAt: null, exitType: null,
        exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
        taskTests: null, fullSuite: null,
    };
}

function makeFixture(previousRun: TaskRunRecord, worktreePath: string, leaseRunId: string | null = "run-old"): { root: string } {
    const root = mkdtempSync(join(tmpdir(), "isTaskRunResumable-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: worktreePath, leaseRunId, history: [previousRun, activeRun("run-new")] },
    }], null, 2));
    return { root };
}

test("test_isTaskRunResumable_returnsFalseWhenTheNotesFileIsRecordedButMissingOnDisk", () => {
    // Setup: the previous run recorded a notes file, but it is not actually present in the
    // worktree, and no physical lease exists yet.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    const previousRun = endedRun({ implementationNotesFile: "plans/implementation-notes-1.md" });
    const { root } = makeFixture(previousRun, worktreePath);

    // Test action + verification: ownership is still established even though notes are missing.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: true });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_adoptsThePreviousRunsLease", () => {
    // Setup: the previous run's notes file really exists in the worktree, and its lease is on disk.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "implementation-notes-1.md"), "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: "plans/implementation-notes-1.md" });
    const { root } = makeFixture(previousRun, worktreePath);

    // Test action: check resumability.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);

    // Verification: resumable, notes file reported, and the lease is now adopted by the new run.
    assert.deepEqual(result, {
        resumable: true, implementationNotesFile: "plans/implementation-notes-1.md", leaseEstablished: true,
    });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_returnsFalseWhenNoPreviousRunEverEnded", () => {
    // Setup: a task with no ended prior run at all, so there is no stale lease to adopt from —
    // but the absent lease is still freshly acquired for this run.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    const root = mkdtempSync(join(tmpdir(), "isTaskRunResumable-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: worktreePath, leaseRunId: null, history: [activeRun("run-new")] },
    }], null, 2));

    // Test action + verification: no notes means not resumable, but ownership is still established.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: true });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_returnsFalseForANotesFileOutsideTheWorktreeByAbsolutePath", () => {
    // Setup: the recorded notes file is an absolute path pointing entirely outside the worktree.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "isTaskRunResumable-outside-"));
    const outsideFile = join(outsideDir, "notes.md");
    writeFileSync(outsideFile, "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: outsideFile });
    const { root } = makeFixture(previousRun, worktreePath);

    // Test action + verification: not resumable, but the ended owner's lease is still adopted.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: true });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_returnsFalseForANotesFileThatEscapesTheWorktreeWithDotDot", () => {
    // Setup: the recorded relative path walks back out of the worktree with "..".
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    const escapedFile = join(worktreePath, "..", "escaped-notes.md");
    writeFileSync(escapedFile, "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: "../escaped-notes.md" });
    const { root } = makeFixture(previousRun, worktreePath);

    // Test action + verification: not resumable, but the ended owner's lease is still adopted.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: true });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_returnsFalseForANotesFileThatEscapesTheWorktreeThroughASymlink", () => {
    // Setup: a symlink inside the worktree points at a file entirely outside it.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "isTaskRunResumable-outside-"));
    const outsideFile = join(outsideDir, "real-notes.md");
    writeFileSync(outsideFile, "notes\n");
    const symlinkPath = join(worktreePath, "notes-link.md");
    symlinkSync(outsideFile, symlinkPath);
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: "notes-link.md" });
    const { root } = makeFixture(previousRun, worktreePath);

    // Test action + verification: not resumable, but the ended owner's lease is still adopted.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: true });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_acquiresAnAbsentLeaseForTheCurrentRun", () => {
    // Setup: notes file is contained and valid, but no physical lease exists at all (the prior
    // exit released it while leaving task.run.leaseRunId and worktree recorded).
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "implementation-notes-1.md"), "notes\n");
    const previousRun = endedRun({ implementationNotesFile: "plans/implementation-notes-1.md" });
    const { root } = makeFixture(previousRun, worktreePath, "run-old");

    // Test action: check resumability with no lease file on disk.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);

    // Verification: resumable, and a fresh lease was acquired for the current run.
    assert.deepEqual(result, {
        resumable: true, implementationNotesFile: "plans/implementation-notes-1.md", leaseEstablished: true,
    });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
});

test("test_isTaskRunResumable_returnsFalseWhenADifferentPhysicalOwnerHoldsTheLease", () => {
    // Setup: notes file is contained and valid, but the physical lease names a live run that is
    // neither the recorded stale owner nor the current claimed run.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "implementation-notes-1.md"), "notes\n");
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-someone-else", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: "plans/implementation-notes-1.md" });
    const { root } = makeFixture(previousRun, worktreePath, "run-old");

    // Test action + verification: not resumable, and the other run's lease is preserved untouched.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: false });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-someone-else");
});

test("test_isTaskRunResumable_adoptsAnEndedRunsLeaseWhenThereAreNoNotes", () => {
    // Setup: an ended run holds the lease, but it recorded no implementation notes at all —
    // this is the "safe, no notes" recovery path finding 1 covers: ownership must still transfer.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: null });
    const { root } = makeFixture(previousRun, worktreePath, "run-old");

    // Test action: check resumability.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);

    // Verification: not resumable (no notes to resume from), but ownership is established and
    // both lease records — the physical lease file and task.run.leaseRunId — now name the new run.
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: true });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-new");
    const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
    assert.equal(tasks[0].run.leaseRunId, "run-new");
});

test("test_isTaskRunResumable_refusesWhenALiveRunOwnsTheLease", () => {
    // Setup: a live run other than the recorded stale owner physically holds the lease.
    const worktreePath = mkdtempSync(join(tmpdir(), "isTaskRunResumable-wt-"));
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-live", pid: 1, createdAt: 1 }));
    const previousRun = endedRun({ implementationNotesFile: null });
    const { root } = makeFixture(previousRun, worktreePath, "run-old");

    // Test action: check resumability.
    const result = isTaskRunResumable(1, worktreePath, "run-new", root);

    // Verification: ownership refused, and neither lease record changed.
    assert.deepEqual(result, { resumable: false, implementationNotesFile: null, leaseEstablished: false });
    const lease = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(lease.runId, "run-live");
    const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
    assert.equal(tasks[0].run.leaseRunId, "run-old");
});
