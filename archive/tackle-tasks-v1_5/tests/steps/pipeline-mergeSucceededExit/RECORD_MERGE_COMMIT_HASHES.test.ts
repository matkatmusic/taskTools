// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/RECORD_MERGE_COMMIT_HASHES.ts. Ported from tests/recordMergeCommits.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/RECORD_MERGE_COMMIT_HASHES.ts";
import { appendTaskCommits, claimTask, getCurrentTaskRun } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(
    dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-mergeSucceededExit/RECORD_MERGE_COMMIT_HASHES.template.json",
);

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function seedTaskAndClaim(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

function samplePacket(projectRoot: string, taskNumber: number, runId: string, commits: unknown[]): Record<string, unknown> {
    return {
        box: "MERGE_RECEIPT_INPUT", scriptSignal: "continue", projectRoot, taskNumber, runId,
        worktreePath: `${projectRoot}/.worktrees/task-${taskNumber}`, rootSourceBranch: "main",
        exitNote: "All layers merged successfully.", commits,
    };
}

test("test_RECORD_MERGE_COMMIT_HASHES_keepsTheWorkAndRepairCommitsThatCameBefore", () => {
    const projectRoot = tmpMkdir("record-merge-commit-hashes-");
    const taskNumber = 40;
    const runId = "run-40";
    seedTaskAndClaim(projectRoot, taskNumber, runId);
    acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
    appendTaskCommits(taskNumber, runId, [{ occurrenceId: "", hash: "work-hash", kind: "work" }], projectRoot);
    appendTaskCommits(taskNumber, runId, [{ occurrenceId: "", hash: "repair-hash", kind: "repair" }], projectRoot);

    const output = main(JSON.stringify(samplePacket(projectRoot, taskNumber, runId, [
        { occurrenceId: "child", hash: "merge-child-hash", kind: "merge" },
        { occurrenceId: "", hash: "merge-root-hash", kind: "merge" },
    ])));

    assert.equal(output.box, "RECORD_MERGE_COMMIT_HASHES");
    assert.equal(output.scriptSignal, "continue");
    assert.equal("commits" in output, false);
    const run = getCurrentTaskRun(taskNumber, projectRoot);
    assert.deepEqual(run?.commits.map((commit) => commit.hash), ["work-hash", "repair-hash", "merge-child-hash", "merge-root-hash"]);
});

test("test_RECORD_MERGE_COMMIT_HASHES_refusesAndMutatesNothingWhenTheLockIsHeldByAnotherRun", () => {
    const projectRoot = tmpMkdir("record-merge-commit-hashes-");
    const taskNumber = 42;
    const runId = "run-42";
    seedTaskAndClaim(projectRoot, taskNumber, runId);
    acquireSourceRepoLock(projectRoot, buildLockOwner("other-run", taskNumber));

    assert.throws(() => main(JSON.stringify(samplePacket(projectRoot, taskNumber, runId, [
        { occurrenceId: "", hash: "merge-root-hash", kind: "merge" },
    ]))));

    const run = getCurrentTaskRun(taskNumber, projectRoot);
    assert.deepEqual(run?.commits, []);
});

test("test_RECORD_MERGE_COMMIT_HASHES_carriesTheRestOfThePacketForward", () => {
    const projectRoot = tmpMkdir("record-merge-commit-hashes-");
    const taskNumber = 43;
    const runId = "run-43";
    seedTaskAndClaim(projectRoot, taskNumber, runId);
    acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));

    const output = main(JSON.stringify(samplePacket(projectRoot, taskNumber, runId, [
        { occurrenceId: "", hash: "merge-root-hash", kind: "merge" },
    ])));

    assert.equal(output.worktreePath, `${projectRoot}/.worktrees/task-${taskNumber}`);
    assert.equal(output.rootSourceBranch, "main");
    assert.equal(output.exitNote, "All layers merged successfully.");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
