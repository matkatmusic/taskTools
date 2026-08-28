// Behavioral checks for RECORD_MODIFIED_FILES_FAILURE.ts. Ported from tests/recordTaskModifiedFiles.test.ts.  Run: node --test scripts/tackle-tasks/failuresExit/RECORD_MODIFIED_FILES_FAILURE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./RECORD_MODIFIED_FILES_FAILURE.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { git, makeCommittedRepo, makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";

const TEMPLATE_PATH = join(import.meta.dirname, "RECORD_MODIFIED_FILES_FAILURE.template.json");

function activeRun() {
    return {
        active: true, worktree: null, leaseRunId: null,
        history: [{
            runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
            exitType: "run-failed", exitNote: "boom", modifiedFiles: [] as string[], commits: [],
            implementationNotesFile: null, taskTests: null, fullSuite: null,
        }],
    };
}

function writeTasksJson(projectRoot: string, task: unknown): void {
    writeFileSync(join(projectRoot, "tasks.json"), `${JSON.stringify([task], null, 2)}\n`);
}

function readTasksJson(projectRoot: string): any[] {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return JSON.parse(readFileSync(tasksPath, "utf8"));
}

function packet(projectRoot: string, worktree: string | null) {
    return JSON.stringify({
        box: "WRITE_EXIT_TYPE_AND_NOTE", scriptSignal: "continue", taskNumber: 1, runId: "run-a",
        projectRoot, worktree, branch: "task-1", exitType: "run-failed", exitNote: "boom",
        publicationState: "NONE LANDED",
    });
}

// projectRoot must be a real git repo: this box derives its base branch with `git rev-parse` first.
test("test_RECORD_MODIFIED_FILES_FAILURE_leavesAnExistingRecordAloneWhenTheWorktreeIsGone", () => {
    const root = makeCommittedRepo("recordModifiedFilesFailure-");
    const run = activeRun();
    run.history[0].modifiedFiles = ["scripts/foo.ts"];
    writeTasksJson(root, { taskNumber: 1, title: "t", files: [], run });

    const output = main(packet(root, null));

    assert.deepEqual(output.modifiedFiles, []);
    const tasks = readTasksJson(root);
    assert.deepEqual(tasks[0].run.history[0].modifiedFiles, ["scripts/foo.ts"]);
});

test("test_RECORD_MODIFIED_FILES_FAILURE_includesPathsChangedInARealWorktree", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    writeFileSync(join(worktreePath, "changed.txt"), "change\n");
    git(worktreePath, "add", "changed.txt");
    git(worktreePath, "commit", "-q", "-m", "work");
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run: activeRun() });

    const output = main(packet(rootOrigin, worktreePath));

    assert.ok((output.modifiedFiles as string[]).includes("changed.txt"));
    const tasks = readTasksJson(rootOrigin);
    assert.deepEqual(tasks[0].run.history[0].modifiedFiles, output.modifiedFiles);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_RECORD_MODIFIED_FILES_FAILURE_runsTwiceWithTheSameInput", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    writeFileSync(join(worktreePath, "changed.txt"), "change\n");
    git(worktreePath, "add", "changed.txt");
    git(worktreePath, "commit", "-q", "-m", "work");
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run: activeRun() });
    const input = packet(rootOrigin, worktreePath);

    const first = main(input);
    const tasksAfterFirst = readTasksJson(rootOrigin);
    const second = main(input);
    const tasksAfterSecond = readTasksJson(rootOrigin);

    assert.deepEqual(second, first);
    assert.deepEqual(tasksAfterSecond, tasksAfterFirst);
});
