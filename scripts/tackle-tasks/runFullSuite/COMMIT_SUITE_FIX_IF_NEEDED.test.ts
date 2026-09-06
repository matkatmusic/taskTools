// Behavioral checks for scripts/tackle-tasks/runFullSuite/COMMIT_SUITE_FIX_IF_NEEDED.ts. Mutating: commits in a real temp worktree, never this repo's tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./COMMIT_SUITE_FIX_IF_NEEDED.ts";
import { claimTask } from "../shared/taskRunState.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "COMMIT_SUITE_FIX_IF_NEEDED.template.json");

function seedActiveTask(rootOrigin: string, taskNumber: number): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files: ["fixed.txt"] }]);
    const outcome = claimTask(taskNumber, "run-1", rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_COMMIT_SUITE_FIX_IF_NEEDED_commitsDirtyWorkAndForwardsTheCorePacket", () => {
    const rootOrigin = makeCommittedRepo();
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 801;
    seedActiveTask(rootOrigin, taskNumber);
    writeFileSync(join(worktree, "fixed.txt"), "fixed\n");

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}`, message: "", additionalData: { fixSummary: "fixed it" } });
    const output = main(input);

    assert.equal(output.box, "COMMIT_SUITE_FIX_IF_NEEDED");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.worktree, worktree);
    assert.equal(git(worktree, "status", "--porcelain"), "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_COMMIT_SUITE_FIX_IF_NEEDED_runsTwiceWithTheSameInput", () => {
    const rootOrigin = makeCommittedRepo();
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 803;
    seedActiveTask(rootOrigin, taskNumber);
    writeFileSync(join(worktree, "fixed.txt"), "fixed\n");

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}`, message: "", additionalData: { fixSummary: "fixed it" } });

    const first = main(input);
    const logAfterFirst = git(worktree, "log", "--format=%H %s");

    const second = main(input);
    const logAfterSecond = git(worktree, "log", "--format=%H %s");

    assert.deepEqual(second, first);
    assert.equal(logAfterSecond, logAfterFirst);
    assert.equal(git(worktree, "status", "--porcelain"), "");
});

test("test_COMMIT_SUITE_FIX_IF_NEEDED_isIdempotentWhenNothingIsDirty", () => {
    const rootOrigin = makeCommittedRepo();
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 802;
    seedActiveTask(rootOrigin, taskNumber);

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}`, message: "", additionalData: { fixSummary: "fixed it" } });
    const output = main(input);

    assert.equal(output.box, "COMMIT_SUITE_FIX_IF_NEEDED");
    assert.equal(git(worktree, "status", "--porcelain"), "");
});

test("test_main_throwsWhenAdditionalDataHasNoStringFixSummary", () => {
    const rootOrigin = makeCommittedRepo();
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 804;
    seedActiveTask(rootOrigin, taskNumber);

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}`, message: "", additionalData: {} });

    assert.throws(() => main(input), /additionalData holds no string "fixSummary"/);
});

test("test_main_carriesFixSummaryForwardOnTheOutputPacket", () => {
    const rootOrigin = makeCommittedRepo();
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 805;
    seedActiveTask(rootOrigin, taskNumber);
    writeFileSync(join(worktree, "fixed.txt"), "fixed\n");

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}`, message: "fixed it", additionalData: { fixSummary: "renamed the failing assertion" } });
    const output = main(input);

    assert.equal(output.fixSummary, "renamed the failing assertion");
});
