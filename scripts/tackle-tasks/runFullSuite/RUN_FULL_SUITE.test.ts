// Behavioral checks for scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts. Mutating: runs an inline fixture package.json, never this repo's suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./RUN_FULL_SUITE.ts";
import { claimTask, getCurrentTaskRun } from "../shared/taskRunState.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "RUN_FULL_SUITE.template.json");

const FIXTURE_PACKAGE_JSON = JSON.stringify({
    name: "run-full-suite-fixture",
    private: true,
    scripts: { test: `node -e "process.exit(0)"` },
});

function seedActiveTaskWithBrief(rootOrigin: string, worktree: string, taskNumber: number): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files: [] }]);
    const outcome = claimTask(taskNumber, "run-1", rootOrigin);
    assert.equal(outcome.status, "claimed");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, `plans/brief-${taskNumber}.md`), "brief\n");
}

test("test_RUN_FULL_SUITE_runsTheTinyFixtureProjectAndForwardsThePacket", async () => {
    const rootOrigin = makeCommittedRepo();
    writeFileSync(join(rootOrigin, "package.json"), FIXTURE_PACKAGE_JSON);
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "add fixture test script");
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 601;
    seedActiveTaskWithBrief(rootOrigin, worktree, taskNumber);

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}` });
    const output = await main(input);

    assert.equal(output.box, "RUN_FULL_SUITE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.passed, true);
    assert.equal(typeof output.output, "string");
    assert.equal(output.worktree, worktree);
    assert.equal(output.taskNumber, taskNumber);
    assert.deepEqual(output.ownedFilePaths, []);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_RUN_FULL_SUITE_runsTwiceWithTheSameInput", async () => {
    const rootOrigin = makeCommittedRepo();
    writeFileSync(join(rootOrigin, "package.json"), FIXTURE_PACKAGE_JSON);
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "add fixture test script");
    const worktree = makeLinkedWorktree(rootOrigin);
    const taskNumber = 602;
    seedActiveTaskWithBrief(rootOrigin, worktree, taskNumber);

    const input = JSON.stringify({ taskNumber, runId: "run-1", projectRoot: rootOrigin, worktree, branch: `task-${taskNumber}` });

    const first = await main(input);
    const { checkedAt: _checkedAtFirst, ...fullSuiteAfterFirst } = getCurrentTaskRun(taskNumber, rootOrigin)!.fullSuite!;

    const second = await main(input);
    const { checkedAt: _checkedAtSecond, ...fullSuiteAfterSecond } = getCurrentTaskRun(taskNumber, rootOrigin)!.fullSuite!;

    assert.deepEqual(second, first);
    assert.deepEqual(fullSuiteAfterSecond, fullSuiteAfterFirst);
});
