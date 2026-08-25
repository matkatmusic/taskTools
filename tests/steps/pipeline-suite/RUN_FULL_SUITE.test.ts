// Behavioral checks for scripts/steps/pipeline-suite/RUN_FULL_SUITE.ts. Mutating: runs an inline fixture package.json, never this repo's suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-suite/RUN_FULL_SUITE.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-suite/RUN_FULL_SUITE.template.json");

const FIXTURE_PACKAGE_JSON = JSON.stringify({
    name: "run-full-suite-fixture",
    private: true,
    scripts: { test: `node -e "process.exit(0)"` },
});

function seedClaimedTask(rootOrigin: string, taskNumber: number): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "fixture task", files: [] }]);
    const outcome = claimTask(taskNumber, "run-1", rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_RUN_FULL_SUITE_runsTheTinyFixtureProjectAndForwardsThePacket", () => {
    const rootOrigin = makeCommittedRepo();
    writeFileSync(join(rootOrigin, "package.json"), FIXTURE_PACKAGE_JSON);
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "add fixture test script");
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 601;
    seedClaimedTask(rootOrigin, taskNumber);

    const input = JSON.stringify({
        taskNumber, runId: "run-1", projectRoot: rootOrigin, worktreePath, rootSourceBranch: "main",
        ownedFilePaths: [], testFilePaths: [], suiteFixAttempts: 0,
    });
    const output = main(input);

    assert.equal(output.box, "RUN_FULL_SUITE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.passed, true);
    assert.equal(typeof output.output, "string");
    assert.equal(output.suiteFixAttempts, 0);
    assert.equal(output.worktreePath, worktreePath);
    assert.equal(output.taskNumber, taskNumber);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
