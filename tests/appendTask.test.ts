import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendTaskToTasksJson, buildTaskEntry, validateNewTaskPayload, type NewTaskPayload } from "../scripts/appendTask.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";

const scriptPath = fileURLToPath(new URL("../scripts/appendTask.ts", import.meta.url));

function makeTemporaryTaskRepo(existingTasks: TaskRecord[]): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "appendTask-"));
    execFileSync("git", ["init"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
    const tasksPath = join(projectRoot, ".taskTools", "tasks.json");
    execFileSync("mkdir", ["-p", join(projectRoot, ".taskTools")]);
    writeFileSync(tasksPath, JSON.stringify(existingTasks, null, 2) + "\n");
    execFileSync("git", ["add", ".taskTools/tasks.json"], { cwd: projectRoot });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot });
    return projectRoot;
}

function minimalPayload(overrides: Partial<NewTaskPayload> = {}): NewTaskPayload {
    return {
        title: "Do the thing",
        userDescription: "user asked for the thing",
        goal: ["- the thing works"],
        tests: "skip",
        description: "touches scripts/thing.ts; the root cause is a missing guard",
        files: ["scripts/thing.ts"],
        difficulty: 3,
        ...overrides,
    };
}

test("test_appendTaskAddsEntryAsLastElementOfTasksJson", () => {
    // New task goes last, never in the middle; repo already holds tasks 1 and 2.
    const projectRoot = makeTemporaryTaskRepo([
        { taskNumber: 1, title: "First" },
        { taskNumber: 2, title: "Second" },
    ]);
    // Append a new task through appendTaskToTasksJson.
    appendTaskToTasksJson(minimalPayload(), projectRoot);
    // Read tasks.json back from disk.
    const tasks = JSON.parse(readFileSync(join(projectRoot, ".taskTools", "tasks.json"), "utf8"));
    // Assert the array has 3 entries.
    assert.equal(tasks.length, 3);
    // Assert the last entry is the new one, and entries 1 and 2 are untouched.
    assert.equal(tasks[0].taskNumber, 1);
    assert.equal(tasks[1].taskNumber, 2);
    assert.equal(tasks[2].title, "Do the thing");
});

test("test_appendTaskStampsTheNextTaskNumber", () => {
    const projectRoot = makeTemporaryTaskRepo([
        { taskNumber: 1, title: "First" },
        { taskNumber: 7, title: "Seventh" },
    ]);
    const entry = appendTaskToTasksJson(minimalPayload(), projectRoot);
    assert.equal(entry.taskNumber, 8);
});

test("test_appendTaskWritesTwoSpaceIndentedJsonWithTrailingNewline", () => {
    const projectRoot = makeTemporaryTaskRepo([{ taskNumber: 1, title: "First" }]);
    appendTaskToTasksJson(minimalPayload(), projectRoot);
    const tasksPath = join(projectRoot, ".taskTools", "tasks.json");
    const raw = readFileSync(tasksPath, "utf8");
    const tasks = JSON.parse(raw);
    assert.equal(raw, JSON.stringify(tasks, null, 2) + "\n");
});

test("test_appendTaskOmitsOptionalFieldsThatAreEmpty", () => {
    const projectRoot = makeTemporaryTaskRepo([]);
    const entry = appendTaskToTasksJson(
        minimalPayload({ chainGoal: [], blockedBy: [] }),
        projectRoot,
    );
    assert.equal("chainGoal" in entry, false);
    assert.equal("blockedBy" in entry, false);
    assert.equal("handoffFilePaths" in entry, false);
});

// A workflow agent holds only research, so an incomplete payload must be refused at the door.
test("test_appendTaskRefusesAPayloadMissingARequiredTemplateField", () => {
    for (const missing of ["title", "userDescription", "description", "tests", "files", "goal", "difficulty"]) {
        const payload = minimalPayload();
        delete (payload as Record<string, unknown>)[missing];
        assert.throws(() => validateNewTaskPayload(payload), new RegExp(missing), `${missing} was accepted`);
    }
});

test("test_appendTaskRefusesBlankStringsAndEmptyArrays", () => {
    assert.throws(() => validateNewTaskPayload(minimalPayload({ title: "   " })), /title/);
    assert.throws(() => validateNewTaskPayload(minimalPayload({ goal: [] })), /goal/);
    assert.throws(() => validateNewTaskPayload(minimalPayload({ files: [""] })), /files/);
    assert.throws(() => validateNewTaskPayload(minimalPayload({ difficulty: 0 })), /difficulty/);
});

test("test_appendTaskScriptFailsLoudlyOnAnIncompletePayload", () => {
    const projectRoot = makeTemporaryTaskRepo([]);
    const payload = minimalPayload();
    delete (payload as Record<string, unknown>).difficulty;
    assert.throws(() =>
        execFileSync("node", [scriptPath], {
            cwd: projectRoot,
            input: JSON.stringify(payload),
            encoding: "utf8",
            stdio: "pipe",
        }),
    );
});

test("test_appendTaskOmitsVersionWhenCommitHashIsNotFortyHexCharacters", () => {
    const entry = buildTaskEntry(minimalPayload(), 1, "");
    assert.equal("version" in entry, false);
});

test("test_appendTaskCommitMessageNamesTheTaskNumber", () => {
    const projectRoot = makeTemporaryTaskRepo([
        { taskNumber: 1, title: "First" },
        { taskNumber: 7, title: "Seventh" },
    ]);
    appendTaskToTasksJson(minimalPayload(), projectRoot);
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: projectRoot, encoding: "utf8" }).trim();
    assert.equal(subject, "created task 8");
});

test("test_appendTaskCommitsOnlyTheTasksJsonPath", () => {
    const projectRoot = makeTemporaryTaskRepo([{ taskNumber: 1, title: "First" }]);
    // an unrelated file, already staged, must survive the commit unstaged
    writeFileSync(join(projectRoot, "unrelated.txt"), "dirty\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: projectRoot });
    appendTaskToTasksJson(minimalPayload(), projectRoot);
    const changedPaths = execFileSync("git", ["show", "--stat", "--name-only", "HEAD"], {
        cwd: projectRoot,
        encoding: "utf8",
    });
    assert.match(changedPaths, /\.taskTools\/tasks\.json/);
    assert.doesNotMatch(changedPaths, /unrelated\.txt/);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    assert.match(status, /unrelated\.txt/);
});

test("test_appendTaskScriptReadsPayloadAsJsonFromStdin", () => {
    const projectRoot = makeTemporaryTaskRepo([{ taskNumber: 1, title: "First" }]);
    const payload = minimalPayload();
    const output = execFileSync("node", [scriptPath], {
        cwd: projectRoot,
        input: JSON.stringify(payload),
        encoding: "utf8",
    });
    assert.equal(output.trim(), "2");
});

test("test_appendTaskScriptFailsWhenStdinIsEmpty", () => {
    const projectRoot = makeTemporaryTaskRepo([{ taskNumber: 1, title: "First" }]);
    assert.throws(() =>
        execFileSync("node", [scriptPath], { cwd: projectRoot, input: "", encoding: "utf8", stdio: "pipe" }),
    );
});
