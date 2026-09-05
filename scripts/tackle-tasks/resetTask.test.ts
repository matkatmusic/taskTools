// Behavioral checks for resetTask.ts, against a temp git repo and a real linked worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resetTask } from "./resetTask.ts";
import { getAttemptCount, raiseAttemptCount } from "./shared/taskRunState.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "resetTask-")));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "fixture@example.com");
    git(repoRoot, "config", "user.name", "fixture");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

test("test_resetTask_atBlock_appliesTheBlocksResetScope", async () => {
    // Setup: task 9 is open, its testFixes counter is raised, and a real worktree already has a plan.
    const repoRoot = makeTempRepoWithCommit();
    const runId = "r1";
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 9,
        title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [{
                runId, startedAt: "t", endedAt: "t2", exitType: "tests-red", exitNote: "n",
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");
    raiseAttemptCount(9, runId, "testFixes", "pass-1", repoRoot);

    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    git(repoRoot, "branch", "task-9");
    git(repoRoot, "worktree", "add", worktreePath, "task-9");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "plan.json"), "{}");
    writeFileSync(join(worktreePath, "plans", "brief-9.md"), "brief");

    // A packet naming RUN_TASK_TESTS for this run, the way the hook writes one for every block it runs.
    const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetInput = JSON.stringify({ taskNumber: 9, runId, worktree: worktreePath, projectRoot: repoRoot });
    writeFileSync(join(packetsFolder, "RUN_TASK_TESTS-0-1.json"), JSON.stringify({
        command: `node --no-inspect script.ts '${packetInput}'`,
    }));

    // Action: reset task 9 at RUN_TASK_TESTS, whose resetScope is { counters: true }.
    const cwd = process.cwd();
    process.chdir(repoRoot);
    let said: string;
    try {
        said = await resetTask(9, "RUN_TASK_TESTS");
    } finally {
        process.chdir(cwd);
    }

    // Verification: the counter is cleared, generated files stay, and the report says what was cleared.
    assert.equal(getAttemptCount(9, "testFixes", repoRoot), 0);
    assert.ok(existsSync(join(worktreePath, "plans", "plan.json")));
    assert.ok(existsSync(join(worktreePath, "plans", "brief-9.md")));
    assert.match(said, /cleared: counters/);
});

test("test_resetTask_throwsNamingThePathWhenAPacketFileIsEmpty", async () => {
    // Setup: task 42 is open, and one packet from an earlier run is a zero-byte file.
    const repoRoot = makeTempRepoWithCommit();
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 42, title: "t" }]));
    writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");
    const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const emptyPacketPath = join(packetsFolder, "SOME_BOX-0-1.json");
    writeFileSync(emptyPacketPath, "");

    // Action + verification: a plain reset scans that packet and throws, naming its path.
    const cwd = process.cwd();
    process.chdir(repoRoot);
    try {
        await assert.rejects(() => resetTask(42, ""), new RegExp(emptyPacketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
        process.chdir(cwd);
    }
});

test("test_resetTask_readsThePerTaskStepsJson", async () => {
    // Scenario: task 9 has its own per-task steps.json under .taskTools/workflows/9/, naming RUN_TASK_TESTS
    // under a diagram key ("onlyInPerTaskConfig.mmd") that exists only there, never in the plugin's own scripts/steps.json.
    const repoRoot = makeTempRepoWithCommit();
    const runId = "r2";
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 9,
        title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [{
                runId, startedAt: "t", endedAt: "t2", exitType: "tests-red", exitNote: "n",
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");

    // Setup: task 9's own per-task steps.json, naming RUN_TASK_TESTS under a diagram absent from the plugin's shared config.
    const workflowDirectory = join(repoRoot, ".taskTools", "workflows", "9");
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(join(workflowDirectory, "steps.json"), JSON.stringify({
        "onlyInPerTaskConfig.mmd": [{
            box: "RUN_TASK_TESTS",
            script: "scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.ts",
            template: "scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.template.json",
            producesPrompt: false,
            next: [],
        }],
    }));

    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    git(repoRoot, "branch", "task-9");
    git(repoRoot, "worktree", "add", worktreePath, "task-9");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });

    const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetInput = JSON.stringify({ taskNumber: 9, runId, worktree: worktreePath, projectRoot: repoRoot });
    writeFileSync(join(packetsFolder, "RUN_TASK_TESTS-0-1.json"), JSON.stringify({
        command: `node --no-inspect script.ts '${packetInput}'`,
    }));

    // Test action: reset task 9 at RUN_TASK_TESTS.
    const cwd = process.cwd();
    process.chdir(repoRoot);
    let said: string;
    try {
        said = await resetTask(9, "RUN_TASK_TESTS");
    } finally {
        process.chdir(cwd);
    }

    // Verification: the resume line names task 9's own per-task diagram — proof the per-task steps.json was read, not the plugin's shared one.
    assert.match(said, /resumes at onlyInPerTaskConfig\.mmd::RUN_TASK_TESTS/);
});

test("test_resetTask_regeneratesAMissingPerTaskStepsJsonForAPreTask10Run", async () => {
    // Scenario: task 9's run started before task 10 shipped, so .taskTools/workflows/9/ does not exist at all.
    const repoRoot = makeTempRepoWithCommit();
    const runId = "r3";
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 9,
        title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [{
                runId, startedAt: "t", endedAt: "t2", exitType: "tests-red", exitNote: "n",
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");
    // Deliberately no .taskTools/workflows/9/ directory — the pre-task-10 shape.

    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    git(repoRoot, "branch", "task-9");
    git(repoRoot, "worktree", "add", worktreePath, "task-9");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });

    const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetInput = JSON.stringify({ taskNumber: 9, runId, worktree: worktreePath, projectRoot: repoRoot });
    writeFileSync(join(packetsFolder, "RUN_TASK_TESTS-0-1.json"), JSON.stringify({
        command: `node --no-inspect script.ts '${packetInput}'`,
    }));

    // Test action: reset task 9 at RUN_TASK_TESTS, a real box in the default pipeline.
    const cwd = process.cwd();
    process.chdir(repoRoot);
    let said: string;
    try {
        said = await resetTask(9, "RUN_TASK_TESTS");
    } finally {
        process.chdir(cwd);
    }

    // Verification: reset still worked, against the real default pipeline, and it generated the missing per-task config as a side effect.
    assert.match(said, /resumes at pipeline-commitImplementationIfNeeded\.mmd::RUN_TASK_TESTS/);
    assert.ok(existsSync(join(repoRoot, ".taskTools", "workflows", "9", "steps.json")));
});
