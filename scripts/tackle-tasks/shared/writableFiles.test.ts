// Proves writableFiles.ts alone owns writable files and required test files; consumers must read it, not reimplement it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notesFile, requiredTestGroups, taskDeclaresTests, writableFiles } from "./writableFiles.ts";
import { buildImplementPrompt } from "../implementTask/IMPLEMENT_TASK.ts";
import type { PreparedTask } from "./preparedTask.ts";
import type { TaskRecord } from "../../shared/taskFiles.ts";

const TASK_NUMBER = 77;

function makeTask(overrides: Record<string, unknown> = {}): TaskRecord {
    return {
        taskNumber: TASK_NUMBER,
        title: "t",
        schemaVersion: "1.0.1",
        hasTests: true,
        modifiableFiles: ["scripts/a/b.ts", "tests/c.test.ts", "index.html"],
        ...overrides,
    };
}

test("test_writableFiles_matchesModifiableFilesPlusRequiredTestCandidatesPlusNotesFile", () => {
    const task = makeTask();

    const groups = requiredTestGroups(task);
    assert.deepEqual(groups, [
        { source: "scripts/a/b.ts", candidates: ["tests/test-b.ts", "tests/b.test.ts", "scripts/a/b.test.ts"] },
    ]);

    const result = writableFiles(task);
    const expected = [
        "scripts/a/b.ts", "tests/c.test.ts", "index.html",
        "tests/test-b.ts", "tests/b.test.ts", "scripts/a/b.test.ts",
        notesFile(TASK_NUMBER),
    ];
    assert.deepEqual([...result].sort(), [...expected].sort());
});

test("test_writableFiles_aSkipTaskOwesOnlyModifiableFilesPlusTheNotesFile", () => {
    const task = makeTask({ tests: "skip" });

    assert.equal(taskDeclaresTests(task), false);
    assert.deepEqual(requiredTestGroups(task), []);
    assert.deepEqual(
        [...writableFiles(task)].sort(),
        ["scripts/a/b.ts", "tests/c.test.ts", "index.html", notesFile(TASK_NUMBER)].sort(),
    );
});

// Walks scripts/ itself (not git) so an uncommitted fork of the rule is still caught.
function tsFilesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) tsFilesUnder(full, out);
        else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

test("test_writableFiles_isTheOnlyPlaceThatForksTheOwnedOrPairedTestRule", () => {
    const exempt = new Set([
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "writableFiles.ts"),
        join(REPO_ROOT, "scripts", "hooks", "relatedTests.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "writableFiles.test.ts"),
    ]);
    const offenders: string[] = [];
    for (const file of tsFilesUnder(join(REPO_ROOT, "scripts"))) {
        if (exempt.has(file)) continue;
        const codeLines = readFileSync(file, "utf8").split("\n").filter((line) => !line.trim().startsWith("//"));
        const code = codeLines.join("\n");
        if (code.includes("implementation-notes-${") || code.includes("}.test.ts`")) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
});

test("test_writableFiles_everyConsumerImportsFromTheOwnerModule", () => {
    const consumers = [
        join(REPO_ROOT, "scripts", "hooks", "agentFenceHook.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "checkTaskFileFence.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "commitTaskWork.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "checkResumedWorktreeFence.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "runTaskTestsImpl.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "whatDidThePlannerReturn", "WHAT_DID_THE_PLANNER_RETURN.ts"),
        join(REPO_ROOT, "scripts", "tackle-tasks", "shared", "preparedTask.ts"),
    ];
    for (const file of consumers) {
        const content = readFileSync(file, "utf8");
        assert.match(content, /from ["'][^"']*writableFiles\.ts["']/, `${file} does not import from writableFiles.ts`);
    }
});

function makeFakeTask(overrides: Partial<PreparedTask> = {}): PreparedTask {
    return {
        number: TASK_NUMBER,
        briefFile: "/tmp/fake-worktree/plans/brief-77.md",
        planFile: "/tmp/fake-worktree/plans/plan.json",
        reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
        reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
        testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
        notesFile: "/tmp/fake-worktree/plans/implementation-notes-77.md",
        files: ["src/thing.ts"],
        readOnlyFiles: ["*"],
        ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
        writableFiles: ["src/thing.ts", "tests/test-thing.ts", "tests/thing.test.ts", "src/thing.test.ts", "plans/implementation-notes-77.md"],
        requiredTestGroups: [{ source: "src/thing.ts", candidates: ["tests/test-thing.ts", "tests/thing.test.ts", "src/thing.test.ts"] }],
        readFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
        createsFiles: [],
        difficulty: 1,
        clarifyRequest: "",
        testFilePaths: [],
        hasTests: true,
        tests: "node --test tests/thing.test.ts",
        codexReviewNotes: "",
        siblingTasks: [],
        blockedBy: [],
        blocks: [],
        repoRoot: "/tmp/fake-worktree",
        taskStateRoot: "/tmp/fake-worktree",
        ...overrides,
    };
}

test("test_writableFiles_thePromptListsExactlyWhatWritableFilesReturns", () => {
    const taskStateRoot = mkdtempSync(join(tmpdir(), "writable-files-prompt-"));
    mkdirSync(join(taskStateRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(taskStateRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: TASK_NUMBER }]));
    const task = makeFakeTask({ taskStateRoot });

    const prompt = buildImplementPrompt(task, "npx tsc --noEmit", 3);
    const section = prompt.slice(prompt.indexOf("## WHAT YOU MAY EDIT"), prompt.indexOf("## TESTS"));
    for (const path of task.writableFiles) {
        assert.match(section, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `"${path}" missing from WHAT YOU MAY EDIT`);
    }

    const skipTaskStateRoot = mkdtempSync(join(tmpdir(), "writable-files-prompt-skip-"));
    mkdirSync(join(skipTaskStateRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(skipTaskStateRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: TASK_NUMBER }]));
    const skipTask = makeFakeTask({
        taskStateRoot: skipTaskStateRoot, hasTests: false, tests: null,
        writableFiles: ["src/thing.ts", "plans/implementation-notes-77.md"], requiredTestGroups: [],
    });
    const skipPrompt = buildImplementPrompt(skipTask, "npx tsc --noEmit", 3);
    const skipSection = skipPrompt.slice(skipPrompt.indexOf("## WHAT YOU MAY EDIT"), skipPrompt.indexOf("## DO NOT CREATE TESTS"));
    assert.equal(/\.test\.ts/.test(skipSection), false);
});
