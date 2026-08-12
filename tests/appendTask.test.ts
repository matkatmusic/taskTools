import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { appendTaskToTasksJson, buildTaskEntry, type NewTaskPayload } from "../scripts/appendTask.ts";
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
        minimalPayload({ chainGoal: [], files: [], blockedBy: [] }),
        projectRoot,
    );
    assert.equal("chainGoal" in entry, false);
    assert.equal("files" in entry, false);
    assert.equal("blockedBy" in entry, false);
    assert.equal("handoffFilePaths" in entry, false);
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

// --- lock races with closeTasks (C86-23): the append must never resurrect a closed task or be lost.

const APPEND_TASK_URL = pathToFileURL(scriptPath).href;
const CLOSE_TASKS_URL = pathToFileURL(fileURLToPath(new URL("../scripts/closeTasks.ts", import.meta.url))).href;

function makeRaceRepo(): string {
    const projectRoot = makeTemporaryTaskRepo([{ taskNumber: 1, title: "first" }]);
    writeFileSync(join(projectRoot, ".taskTools", "completedTasks.json"), "[]\n");
    return projectRoot;
}

function readTaskSummaries(projectRoot: string, file: string): [number, string][] {
    const tasks = JSON.parse(readFileSync(join(projectRoot, ".taskTools", file), "utf8")) as TaskRecord[];
    return tasks.map((t) => [t.taskNumber, t.title ?? ""]);
}

function requireExitZero(child: ChildProcess): Promise<void> {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    return new Promise((resolve, reject) => {
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`child exited ${code}: ${stderr}`));
        });
    });
}

async function waitForFile(path: string): Promise<void> {
    while (!existsSync(path)) await sleep(5);
}

const WAIT_LOOP = `const WAIT = new Int32Array(new SharedArrayBuffer(4));`;

// Waits on startFile, then appends once.
function spawnAppendChild(projectRoot: string, startFile: string): ChildProcess {
    const code = `
import { existsSync } from "node:fs";
import { appendTaskToTasksJson } from ${JSON.stringify(APPEND_TASK_URL)};
${WAIT_LOOP}
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
appendTaskToTasksJson(${JSON.stringify(minimalPayload({ title: "second" }))}, ${JSON.stringify(projectRoot)});
`;
    return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

// Waits on startFile, then closes task 1 once.
function spawnCloseChild(projectRoot: string, startFile: string): ChildProcess {
    const code = `
import { existsSync } from "node:fs";
import { closeTasks } from ${JSON.stringify(CLOSE_TASKS_URL)};
${WAIT_LOOP}
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
closeTasks([1], "closed during race", ${JSON.stringify(projectRoot)});
`;
    return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

// Holds the real lock, writes ackFile, then blocks until releaseFile exists.
function spawnLockAcknowledgingChild(kind: "append" | "close", projectRoot: string, startFile: string, ackFile: string, releaseFile: string): ChildProcess {
    const importLine = kind === "append"
        ? `import { appendTaskToTasksJson } from ${JSON.stringify(APPEND_TASK_URL)};`
        : `import { closeTasks } from ${JSON.stringify(CLOSE_TASKS_URL)};`;
    const callLine = kind === "append"
        ? `appendTaskToTasksJson(${JSON.stringify(minimalPayload({ title: "second" }))}, ${JSON.stringify(projectRoot)}, { onAcquired });`
        : `closeTasks([1], "closed during race", ${JSON.stringify(projectRoot)}, [], { onAcquired });`;
    const code = `
import { existsSync, writeFileSync } from "node:fs";
${importLine}
${WAIT_LOOP}
while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(WAIT, 0, 0, 5);
function onAcquired() {
  writeFileSync(${JSON.stringify(ackFile)}, "ack");
  while (!existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(WAIT, 0, 0, 5);
}
${callLine}
`;
    return spawn("node", ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
}

test("test_appendWinsTheLockThenCloseFollows_closedTaskArchivesAndAppendedTaskSurvives", async () => {
    const projectRoot = makeRaceRepo();
    const startFile = join(projectRoot, "start");
    const ackFile = join(projectRoot, "append-acquired");
    const releaseFile = join(projectRoot, "append-release");

    const append = spawnLockAcknowledgingChild("append", projectRoot, startFile, ackFile, releaseFile);
    writeFileSync(startFile, "go");
    await waitForFile(ackFile); // append provably holds the lock before the closer starts

    const close = spawnCloseChild(projectRoot, startFile);
    writeFileSync(releaseFile, "go");
    await Promise.all([requireExitZero(append), requireExitZero(close)]);

    assert.deepEqual(readTaskSummaries(projectRoot, "tasks.json"), [[2, "second"]]);
    assert.deepEqual(readTaskSummaries(projectRoot, "completedTasks.json").map(([n]) => n), [1]);
});

test("test_closeWinsTheLockThenAppendFollows_task1StaysClosedAndAppendedNumberAccountsForIt", async () => {
    const projectRoot = makeRaceRepo();
    const startFile = join(projectRoot, "start");
    const ackFile = join(projectRoot, "close-acquired");
    const releaseFile = join(projectRoot, "close-release");

    const close = spawnLockAcknowledgingChild("close", projectRoot, startFile, ackFile, releaseFile);
    writeFileSync(startFile, "go");
    await waitForFile(ackFile); // close provably holds the lock before the appender starts

    const append = spawnAppendChild(projectRoot, startFile);
    writeFileSync(releaseFile, "go");
    await requireExitZero(close);
    await requireExitZero(append);

    assert.deepEqual(readTaskSummaries(projectRoot, "tasks.json"), [[2, "second"]]);
    assert.deepEqual(readTaskSummaries(projectRoot, "completedTasks.json").map(([n]) => n), [1]);
});
