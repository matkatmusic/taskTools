// Behavioral checks for scripts/tackle-tasks/shared/checkResumedWorktreeFence.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkResumedWorktreeFence } from "./checkResumedWorktreeFence.ts";
import { notesFile } from "./writableFiles.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

function seedTask(rootOrigin: string, taskNumber: number, files: string[], overrides: Record<string, unknown> = {}): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", modifiableFiles: files, ...overrides }]);
}

test("test_checkResumedWorktreeFence_acceptsAPairedTestFileAndTheNotesFile", () => {
    const rootOrigin = makeCommittedRepo("check-resumed-fence-", "main");
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const taskNumber = 50;
    seedTask(rootOrigin, taskNumber, ["src/thing.ts"], { schemaVersion: "1.0.1", hasTests: true });

    mkdirSync(join(worktreePath, "src"));
    mkdirSync(join(worktreePath, "tests"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "src", "thing.ts"), "thing\n");
    writeFileSync(join(worktreePath, "tests", "thing.test.ts"), "test thing\n");
    writeFileSync(join(worktreePath, notesFile(taskNumber)), "notes\n");
    git(worktreePath, "add", "src", "tests", "plans");
    git(worktreePath, "commit", "-q", "-m", "add thing, its paired test, and the notes file");

    const result = checkResumedWorktreeFence({ projectRoot: rootOrigin, worktreePath, taskNumber });

    assert.equal(result.inside, true);
    assert.deepEqual(result.violations, []);
});
