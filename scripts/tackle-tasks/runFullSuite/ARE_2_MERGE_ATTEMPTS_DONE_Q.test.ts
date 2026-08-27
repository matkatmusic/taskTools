// Behavioral checks for scripts/tackle-tasks/runFullSuite/ARE_2_MERGE_ATTEMPTS_DONE_Q.ts. Mutating: raises a persisted counter on an inline tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./ARE_2_MERGE_ATTEMPTS_DONE_Q.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";

const TEMPLATE_PATH = join(
    dirname(fileURLToPath(import.meta.url)), "ARE_2_MERGE_ATTEMPTS_DONE_Q.template.json",
);

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

// Seeds a fresh project root with an inline task, never from real project state.
function makeProjectRootWithActiveTask(taskNumber: number, runId: string): string {
    const projectRoot = tmpMkdir("merge-attempts-step-");
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "seed task", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    return projectRoot;
}

function packet(taskNumber: number, runId: string, projectRoot: string): string {
    return JSON.stringify({
        worktree: "/wt", taskNumber, runId, projectRoot, branch: `task-${taskNumber}`, exitType: "", exitNote: "", merged: false,
        failureReason: "", state: "NONE LANDED", landed: [], notLanded: ["root"], commits: [],
    });
}

test("test_ARE_2_MERGE_ATTEMPTS_DONE_Q_reentersRebaseOnTheFirstAttempt", () => {
    const taskNumber = 1;
    const runId = "run-1";
    const projectRoot = makeProjectRootWithActiveTask(taskNumber, runId);

    const result = main(packet(taskNumber, runId, projectRoot));

    assert.equal(result.box, "ARE_2_MERGE_ATTEMPTS_DONE_Q");
    assert.equal(result.next, "pipeline-rebase.mmd::REBASE_ONTO_TARGET_BRANCH");
    assert.equal(result.exitType, "");
    assert.equal(result.exitNote, "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, result), []);
});

test("test_ARE_2_MERGE_ATTEMPTS_DONE_Q_exitsMergeFailedAfterTwoAttempts", () => {
    const taskNumber = 2;
    const runId = "run-2";
    const projectRoot = makeProjectRootWithActiveTask(taskNumber, runId);

    main(packet(taskNumber, runId, projectRoot));
    const result = main(packet(taskNumber, runId, projectRoot));

    assert.equal(result.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(result.exitType, "merge-failed");
    assert.equal(result.exitNote, "nothing landed after 2 attempts. worktree preserved.");
});
