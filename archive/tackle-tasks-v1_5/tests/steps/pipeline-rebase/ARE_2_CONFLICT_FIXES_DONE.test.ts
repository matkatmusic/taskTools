// Behavioral checks for scripts/steps/pipeline-rebase/ARE_2_CONFLICT_FIXES_DONE.ts.  Run: node --test tests/steps/pipeline-rebase/ARE_2_CONFLICT_FIXES_DONE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-rebase/ARE_2_CONFLICT_FIXES_DONE.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-rebase/ARE_2_CONFLICT_FIXES_DONE.template.json");

function makeProjectRoot(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "are-2-conflict-fixes-"));
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    return projectRoot;
}

function seedTaskAndClaimAndLock(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    const lockOutcome = acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
    assert.equal(lockOutcome.status, "acquired");
}

function packet(projectRoot: string, taskNumber: number, runId: string): RebasePacket {
    return {
        box: "DID_REBASE_REPORT_CONFLICTS", scriptSignal: "continue", projectRoot,
        worktreePath: "/does/not/matter", taskNumber, runId, stepId: "step-1", rootSourceBranch: "main",
        landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: true, stoppedOccurrenceId: "", stoppedCheckoutPath: "/wt",
        conflictedFilePaths: ["a.txt"], finished: false, failureReason: "", exitType: "", exitNote: "",
    };
}

test("test_ARE_2_CONFLICT_FIXES_DONE_sendsTheFirstTwoAttemptsToFixConflicts", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndClaimAndLock(projectRoot, 1, "run-1");

    const first = main(JSON.stringify(packet(projectRoot, 1, "run-1")));
    assert.equal(first.next, "FIX_CONFLICTS");
    assert.equal(first.exitType, "");

    const second = main(JSON.stringify(packet(projectRoot, 1, "run-1")));
    assert.equal(second.next, "FIX_CONFLICTS");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, second), []);
});

test("test_ARE_2_CONFLICT_FIXES_DONE_exitsRebaseStuckOnTheThirdAttempt", () => {
    const projectRoot = makeProjectRoot();
    seedTaskAndClaimAndLock(projectRoot, 2, "run-2");

    main(JSON.stringify(packet(projectRoot, 2, "run-2")));
    main(JSON.stringify(packet(projectRoot, 2, "run-2")));
    const third = main(JSON.stringify(packet(projectRoot, 2, "run-2")));

    assert.equal(third.next, "EXIT_WORKFLOW_REBASE");
    assert.equal(third.exitType, "rebase-stuck");
    assert.equal(third.exitNote, "the rebase did not advance after 2 conflict fixes");
});
