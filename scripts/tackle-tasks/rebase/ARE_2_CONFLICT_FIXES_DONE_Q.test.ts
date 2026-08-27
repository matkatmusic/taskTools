// Behavioral checks for ARE_2_CONFLICT_FIXES_DONE_Q.ts. Run: node --test scripts/tackle-tasks/rebase/ARE_2_CONFLICT_FIXES_DONE_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./ARE_2_CONFLICT_FIXES_DONE_Q.ts";
import type { RebasePacket } from "./_packet.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";

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

function packet(projectRoot: string, taskNumber: number, runId: string): RebasePacket {
    return {
        box: "DID_REBASE_REPORT_CONFLICTS_Q", scriptSignal: "continue", taskNumber, runId, projectRoot,
        worktree: "/does/not/matter", branch: `task-${taskNumber}`, exitType: "", exitNote: "",
        conflicted: true, stoppedOccurrenceId: "", stoppedCheckoutPath: "/wt", conflictedFilePaths: ["a.txt"], failureReason: "",
    };
}

test("test_ARE_2_CONFLICT_FIXES_DONE_Q_sendsTheFirstTwoAttemptsToFixConflicts", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndMarkActiveAndLock(projectRoot, 1, "run-1");

    const first = main(JSON.stringify(packet(projectRoot, 1, "run-1")));
    assert.equal(first.next, "pipeline-fixConflicts.mmd::FIX_CONFLICTS");
    assert.equal(first.exitType, "");

    const second = main(JSON.stringify(packet(projectRoot, 1, "run-1")));
    assert.equal(second.next, "pipeline-fixConflicts.mmd::FIX_CONFLICTS");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8").replaceAll("{{PROJECT_ROOT}}", projectRoot));
    assert.deepEqual(getTemplateShapeMismatches(template.output, second), []);
});

test("test_ARE_2_CONFLICT_FIXES_DONE_Q_exitsRebaseStuckOnTheThirdAttempt", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndMarkActiveAndLock(projectRoot, 2, "run-2");

    main(JSON.stringify(packet(projectRoot, 2, "run-2")));
    main(JSON.stringify(packet(projectRoot, 2, "run-2")));
    const third = main(JSON.stringify(packet(projectRoot, 2, "run-2")));

    assert.equal(third.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(third.exitType, "rebase-stuck");
    assert.equal(third.exitNote, "the rebase did not advance after 2 conflict fixes");
});
