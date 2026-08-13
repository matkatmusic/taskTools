// Behavioral checks for scripts/tackle-tasks/recordMergeCommits.ts. Run: node --test tests/tackle-tasks/recordMergeCommits.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { recordMergeCommits } from "../../scripts/tackle-tasks/recordMergeCommits.ts";
import { appendTaskCommits, claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";

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

test("test_recordMergeCommits_keepsTheWorkAndRepairCommitsThatCameBefore", () => {
    const projectRoot = tmpMkdir("record-merge-commits-");
    const taskNumber = 40;
    seedTaskAndClaim(projectRoot, taskNumber, "run-40");

    appendTaskCommits(taskNumber, [{ occurrenceId: "", hash: "work-hash", kind: "work" }], projectRoot);
    appendTaskCommits(taskNumber, [{ occurrenceId: "", hash: "repair-hash", kind: "repair" }], projectRoot);

    const result = recordMergeCommits({
        projectRoot, taskNumber,
        commits: [
            { occurrenceId: "child", hash: "merge-child-hash", kind: "merge" },
            { occurrenceId: "", hash: "merge-root-hash", kind: "merge" },
        ],
    });

    assert.deepEqual(result.commits.map((commit) => commit.hash), ["merge-child-hash", "merge-root-hash"]);

    const run = getCurrentTaskRun(taskNumber, projectRoot);
    assert.deepEqual(run?.commits.map((commit) => commit.hash), ["work-hash", "repair-hash", "merge-child-hash", "merge-root-hash"]);
    assert.deepEqual(run?.commits.map((commit) => commit.kind), ["work", "repair", "merge", "merge"]);
});
