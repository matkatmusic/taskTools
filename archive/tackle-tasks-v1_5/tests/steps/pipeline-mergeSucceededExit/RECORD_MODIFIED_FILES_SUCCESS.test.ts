// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/RECORD_MODIFIED_FILES_SUCCESS.ts.  Ported from tests/recordTaskModifiedFiles.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/RECORD_MODIFIED_FILES_SUCCESS.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { git, makeCommittedRepo, addSubmodule } from "../../support/gitFixtures.ts";

const TEMPLATE_PATH = join(
    dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-mergeSucceededExit/RECORD_MODIFIED_FILES_SUCCESS.template.json",
);

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeCommittedRepo("record-modified-files-child-", "main");
    const rootOrigin = makeCommittedRepo("record-modified-files-root-", "main");
    addSubmodule(rootOrigin, childOrigin, "child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

function writeTasksJson(projectRoot: string, task: unknown): void {
    writeFileSync(join(projectRoot, "tasks.json"), `${JSON.stringify([task], null, 2)}\n`);
}

function readTasksJson(projectRoot: string): any[] {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return JSON.parse(readFileSync(tasksPath, "utf8"));
}

function activeRun() {
    return {
        active: true, worktree: null, leaseRunId: null,
        history: [{
            runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
            exitType: null, exitNote: null, modifiedFiles: [] as string[], commits: [],
            implementationNotesFile: null, taskTests: null, fullSuite: null,
        }],
    };
}

function samplePacket(projectRoot: string, taskNumber: number, worktreePath: string): Record<string, unknown> {
    return {
        box: "WRITE_EXIT_TYPE_COMPLETED", scriptSignal: "continue", projectRoot, taskNumber,
        runId: "run-a", worktreePath, rootSourceBranch: "main",
    };
}

test("test_RECORD_MODIFIED_FILES_SUCCESS_includesPathsChangedInsideASubmodule", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    writeFileSync(join(worktreePath, "child", "newfile.txt"), "change\n");
    git(join(worktreePath, "child"), "add", "newfile.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child change");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run: activeRun() });

    const output = main(JSON.stringify(samplePacket(rootOrigin, 1, worktreePath)));

    assert.equal(output.box, "RECORD_MODIFIED_FILES_SUCCESS");
    assert.equal("rootSourceBranch" in output, false);
    assert.equal(output.worktreePath, worktreePath);
    const tasks = readTasksJson(rootOrigin);
    assert.ok(tasks[0].run.history[0].modifiedFiles.includes("child::newfile.txt"));

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_RECORD_MODIFIED_FILES_SUCCESS_throwsWithASiblingRunId", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const run = activeRun();
    run.history[0].runId = "run-new";
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run });

    assert.throws(() => main(JSON.stringify(samplePacket(rootOrigin, 1, worktreePath))));
});
