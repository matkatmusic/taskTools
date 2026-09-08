// Behavioral checks for ARE_2_CONFLICT_FIXES_DONE_Q.ts. Run: node --test scripts/tackle-tasks/rebase/ARE_2_CONFLICT_FIXES_DONE_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./ARE_2_CONFLICT_FIXES_DONE_Q.ts";
import type { RebasePacket } from "./_packet.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";
import { writeCheckpoint, type Checkpoint } from "../shared/checkpoint.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "ARE_2_CONFLICT_FIXES_DONE_Q.template.json");

function makeProjectRoot(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "are-2-conflict-fixes-"));
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    return projectRoot;
}

function seedTaskAndMarkActiveAndLock(projectRoot: string, taskNumber: number, runId: string): void {
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{ taskNumber, title: "t", files: [] }]));
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    const lockOutcome = acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
    assert.equal(lockOutcome.status, "acquired");
}

function worktreeOf(projectRoot: string): string {
    return join(projectRoot, "wt");
}

function packet(projectRoot: string, taskNumber: number, runId: string): RebasePacket {
    return {
        box: "DID_REBASE_REPORT_CONFLICTS_Q", scriptSignal: "continue", taskNumber, runId, projectRoot,
        worktree: worktreeOf(projectRoot), branch: `task-${taskNumber}`, exitType: "", exitNote: "",
        conflicted: true, stoppedOccurrenceId: "", stoppedCheckoutPath: "/wt", conflictedFilePaths: ["a.txt"], failureReason: "",
    };
}

function seedCheckpoint(taskNumber: number, runId: string, worktree: string, passId: string): void {
    const checkpoint: Checkpoint = {
        taskNumber, passId, runId, projectRoot: worktree,
        block: "pipeline-rebase.mmd::ARE_2_CONFLICT_FIXES_DONE_Q", input: "{}",
        state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    };
    writeCheckpoint(worktree, checkpoint);
}

test("test_ARE_2_CONFLICT_FIXES_DONE_Q_sendsTheFirstTwoAttemptsToFixConflicts", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndMarkActiveAndLock(projectRoot, 1, "run-1");
    const worktree = worktreeOf(projectRoot);

    seedCheckpoint(1, "run-1", worktree, "pass-0");
    const first = main(JSON.stringify(packet(projectRoot, 1, "run-1")));
    assert.equal(first.next, "pipeline-fixConflicts.mmd::FIX_CONFLICTS");
    assert.equal(first.exitType, "");

    seedCheckpoint(1, "run-1", worktree, "pass-1");
    const second = main(JSON.stringify(packet(projectRoot, 1, "run-1")));
    assert.equal(second.next, "pipeline-fixConflicts.mmd::FIX_CONFLICTS");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8").replaceAll("{{PROJECT_ROOT}}", projectRoot));
    assert.deepEqual(getTemplateShapeMismatches(template.output, second), []);
});

test("test_ARE_2_CONFLICT_FIXES_DONE_Q_exitsRebaseStuckOnTheThirdAttempt", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndMarkActiveAndLock(projectRoot, 2, "run-2");
    const worktree = worktreeOf(projectRoot);

    seedCheckpoint(2, "run-2", worktree, "pass-0");
    main(JSON.stringify(packet(projectRoot, 2, "run-2")));
    seedCheckpoint(2, "run-2", worktree, "pass-1");
    main(JSON.stringify(packet(projectRoot, 2, "run-2")));
    seedCheckpoint(2, "run-2", worktree, "pass-2");
    const third = main(JSON.stringify(packet(projectRoot, 2, "run-2")));

    assert.equal(third.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(third.exitType, "rebase-stuck");
    assert.equal(third.exitNote, "the rebase did not advance after 2 conflict fixes");
});

test("test_ARE_2_CONFLICT_FIXES_DONE_Q_countsOnceWhenRunTwiceWithTheSameCheckpoint", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndMarkActiveAndLock(projectRoot, 3, "run-3");
    const worktree = worktreeOf(projectRoot);
    seedCheckpoint(3, "run-3", worktree, "pass-1");

    main(JSON.stringify(packet(projectRoot, 3, "run-3")));
    const second = main(JSON.stringify(packet(projectRoot, 3, "run-3")));

    assert.equal(second.next, "pipeline-fixConflicts.mmd::FIX_CONFLICTS");
});

test("test_ARE_2_CONFLICT_FIXES_DONE_Q_throwsWithoutACheckpoint", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndMarkActiveAndLock(projectRoot, 4, "run-4");

    assert.throws(() => main(JSON.stringify(packet(projectRoot, 4, "run-4"))), /no checkpoint/);
});
