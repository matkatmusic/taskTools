// Behavioral checks for scripts/tackle-tasks/runFullSuite/ARE_2_SUITE_FIXES_DONE_Q.ts. Mutating: raises a persisted counter on an inline tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./ARE_2_SUITE_FIXES_DONE_Q.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "ARE_2_SUITE_FIXES_DONE_Q.template.json");

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeProjectRootWithActiveTask(taskNumber: number, runId: string): string {
    const projectRoot = tmpMkdir("suite-fix-attempts-step-");
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "seed task", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    return projectRoot;
}

function packet(taskNumber: number, runId: string, projectRoot: string): string {
    return JSON.stringify({
        taskNumber, runId, projectRoot, worktree: "/wt", branch: `task-${taskNumber}`,
        ownedFilePaths: [], testFilePaths: [], passed: false, output: "failing output",
    });
}

test("test_ARE_2_SUITE_FIXES_DONE_Q_sendsTheFirstAttemptToTheFixAgentAndRaisesTheCounter", () => {
    const taskNumber = 1;
    const runId = "run-1";
    const projectRoot = makeProjectRootWithActiveTask(taskNumber, runId);

    const output = main(packet(taskNumber, runId, projectRoot));

    assert.equal(output.next, "pipeline-fixTheCodebaseForSuite.mmd::FIX_THE_CODEBASE_FOR_SUITE");
    assert.equal(output.exitType, "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_ARE_2_SUITE_FIXES_DONE_Q_exitsAsSuiteRedOnTheSecondAttempt", () => {
    const taskNumber = 2;
    const runId = "run-2";
    const projectRoot = makeProjectRootWithActiveTask(taskNumber, runId);

    main(packet(taskNumber, runId, projectRoot));
    const output = main(packet(taskNumber, runId, projectRoot));

    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "suite-red");
    assert.match(String(output.exitNote), /2 fix attempts/);
});
