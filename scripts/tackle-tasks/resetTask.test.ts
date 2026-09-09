// Behavioral checks for resetTask.ts, against a temp git repo and a real linked worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetTask } from "./resetTask.ts";
import { getAttemptCount, raiseAttemptCount } from "./shared/taskRunState.ts";
import { generateSteps, resolveDiagramFolderSetting } from "./generateSteps.ts";
import { taskWorkflowDirectory } from "../shared/taskFiles.ts";
import { readCheckpoint } from "./shared/checkpoint.ts";

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

test("test_resetTask_atBlock_checksOutTaskBranchInEveryWorktreeSubmodule", async () => {
    // Task 9 is open; its worktree submodule has a task-9 branch that is not checked out.
    const repoRoot = makeTempRepoWithCommit();
    const submoduleSource = makeTempRepoWithCommit();
    const cwd = process.cwd();
    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    try {
        git(repoRoot, "-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "vendor");
        git(repoRoot, "commit", "-q", "-m", "add vendor submodule");

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

        git(repoRoot, "branch", "task-9");
        git(repoRoot, "worktree", "add", worktreePath, "task-9");
        git(worktreePath, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
        git(join(worktreePath, "vendor"), "checkout", "-b", "task-9");
        const rewindOid = git(join(worktreePath, "vendor"), "rev-parse", "HEAD").trim();
        git(join(worktreePath, "vendor"), "checkout", "-b", "other");
        // Discovery needs one base branch at the gitlink; move `other` off it so only the default branch matches.
        git(join(worktreePath, "vendor"), "commit", "-q", "--allow-empty", "-m", "other");

        const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
        mkdirSync(packetsFolder, { recursive: true });
        const packetInput = JSON.stringify({ taskNumber: 9, runId, worktree: worktreePath, projectRoot: repoRoot });
        writeFileSync(join(packetsFolder, "01-RUN_TASK_TESTS-0-1.json"), JSON.stringify({
            command: `node --no-inspect script.ts '${packetInput}'`,
            rewindPoints: { "": git(worktreePath, "rev-parse", "HEAD").trim(), vendor: rewindOid },
        }));

        // Action: reset task 9 at RUN_TASK_TESTS.
        process.chdir(repoRoot);
        await resetTask(9, "RUN_TASK_TESTS");

        // Verification: the submodule is back on task-9, at its recorded rewind point.
        assert.equal(git(join(worktreePath, "vendor"), "branch", "--show-current").trim(), "task-9");
        assert.equal(git(join(worktreePath, "vendor"), "rev-parse", "HEAD").trim(), rewindOid);
    } finally {
        process.chdir(cwd);
        if (existsSync(worktreePath)) git(repoRoot, "worktree", "remove", "--force", worktreePath);
        rmSync(dirname(worktreePath), { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(submoduleSource, { recursive: true, force: true });
    }
});

test("test_resetTask_atBlock_restoresRootAndSubmoduleToTheChosenPacketsRewindPoints", async () => {
    // Task 9 is open; its worktree has one submodule. Two packets, for two different blocks, carry different rewindPoints.
    const repoRoot = makeTempRepoWithCommit();
    const submoduleSource = makeTempRepoWithCommit();
    const cwd = process.cwd();
    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    try {
        git(repoRoot, "-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "vendor");
        git(repoRoot, "commit", "-q", "-m", "add vendor submodule");

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

        git(repoRoot, "branch", "task-9");
        git(repoRoot, "worktree", "add", worktreePath, "task-9");
        git(worktreePath, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
        git(join(worktreePath, "vendor"), "checkout", "-b", "task-9");

        // The first block's rewind point: root and submodule HEAD before either gets a new commit.
        const rootOidBefore = git(worktreePath, "rev-parse", "HEAD").trim();
        const submoduleOidBefore = git(join(worktreePath, "vendor"), "rev-parse", "HEAD").trim();

        // A commit lands in root, then one in the submodule, between the two blocks.
        writeFileSync(join(worktreePath, "root-change.txt"), "root\n");
        git(worktreePath, "add", "root-change.txt");
        git(worktreePath, "commit", "-q", "-m", "root change");
        writeFileSync(join(worktreePath, "vendor", "vendor-change.txt"), "vendor\n");
        git(join(worktreePath, "vendor"), "add", "vendor-change.txt");
        git(join(worktreePath, "vendor"), "commit", "-q", "-m", "vendor change");

        const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
        mkdirSync(packetsFolder, { recursive: true });
        const packetInput = JSON.stringify({ taskNumber: 9, runId, worktree: worktreePath, projectRoot: repoRoot });
        writeFileSync(join(packetsFolder, "01-RUN_TASK_TESTS-0-1.json"), JSON.stringify({
            command: `node --no-inspect script.ts '${packetInput}'`,
            rewindPoints: { "": rootOidBefore, vendor: submoduleOidBefore },
        }));
        writeFileSync(join(packetsFolder, "02-RUN_FULL_SUITE-0-2.json"), JSON.stringify({
            command: `node --no-inspect script.ts '${packetInput}'`,
            rewindPoints: { "": git(worktreePath, "rev-parse", "HEAD").trim(), vendor: git(join(worktreePath, "vendor"), "rev-parse", "HEAD").trim() },
        }));

        // Action: reset task 9 to the first block, RUN_TASK_TESTS.
        process.chdir(repoRoot);
        await resetTask(9, "RUN_TASK_TESTS");

        // Verification: root and submodule are back at the first packet's oids, and the submodule is on task-9.
        assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), rootOidBefore);
        assert.equal(git(join(worktreePath, "vendor"), "rev-parse", "HEAD").trim(), submoduleOidBefore);
        assert.equal(git(join(worktreePath, "vendor"), "branch", "--show-current").trim(), "task-9");
    } finally {
        process.chdir(cwd);
        if (existsSync(worktreePath)) git(repoRoot, "worktree", "remove", "--force", worktreePath);
        rmSync(dirname(worktreePath), { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(submoduleSource, { recursive: true, force: true });
    }
});

test("test_resetTask_atRunFullSuite_clearsTheSuiteFixCounterWithTasksJsonAtTheRepoRoot", async () => {
    // Setup: tasks.json sits at the repo root, not under .taskTools, and the suiteFix counter is already at 2.
    const repoRoot = makeTempRepoWithCommit();
    const runId = "r1";
    writeFileSync(join(repoRoot, "tasks.json"), JSON.stringify([{
        taskNumber: 9,
        title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [{
                runId, startedAt: "t", endedAt: "t2", exitType: "suite-red", exitNote: "n",
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(join(repoRoot, "completedTasks.json"), "[]");
    raiseAttemptCount(9, runId, "suiteFix", "pass-1", repoRoot);
    raiseAttemptCount(9, runId, "suiteFix", "pass-1", repoRoot);

    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    git(repoRoot, "branch", "task-9");
    git(repoRoot, "worktree", "add", worktreePath, "task-9");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-9.md"), "brief");

    const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetInput = JSON.stringify({ taskNumber: 9, runId, worktree: worktreePath, projectRoot: repoRoot });
    writeFileSync(join(packetsFolder, "RUN_FULL_SUITE-0-1.json"), JSON.stringify({
        command: `node --no-inspect script.ts '${packetInput}'`,
    }));

    // Action: reset task 9 at RUN_FULL_SUITE.
    const cwd = process.cwd();
    process.chdir(repoRoot);
    let said: string;
    try {
        said = await resetTask(9, "RUN_FULL_SUITE");
    } finally {
        process.chdir(cwd);
    }

    // Verification: the suiteFix counter is cleared and the report says so.
    assert.equal(getAttemptCount(9, "suiteFix", repoRoot), 0);
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
    // Scenario: task 9's per-task steps.json names RUN_TASK_TESTS under a diagram key found only there, not in the plugin's steps.json.
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

    // Verification: the resume line names task 9's per-task diagram, proving its steps.json was read, not the plugin's shared one.
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

    // Verification: reset worked against the real default pipeline, and generated the missing per-task config as a side effect.
    assert.match(said, /resumes at pipeline-commitImplementationIfNeeded\.mmd::RUN_TASK_TESTS/);
    assert.ok(existsSync(join(repoRoot, ".taskTools", "workflows", "9", "steps.json")));
});

test("test_resetTask_fullReset_removesRunFoldersAgentFilesWorkflowFolderAndMergedRef", async () => {
    // Setup: task 7 is open with a run folder, five agent files, a workflow folder, and a merged-commits ref.
    const repoRoot = makeTempRepoWithCommit();
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 7, title: "t" }]));
    writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");
    const runFolder = join(repoRoot, ".taskTools", "runs", "0001");
    mkdirSync(join(runFolder, "packets"), { recursive: true });
    writeFileSync(join(runFolder, "packets", "PLAN_THE_TASK-0-1.json"), JSON.stringify({ taskNumber: 7, command: "" }));
    writeFileSync(join(runFolder, "run-log.jsonl"), "");
    const agentsFolder = join(repoRoot, ".claude", "agents");
    mkdirSync(agentsFolder, { recursive: true });
    writeFileSync(join(agentsFolder, "task-7-implement-task.md"), "");
    writeFileSync(join(agentsFolder, "task-70-implement-task.md"), "");
    const workflowFolder = join(repoRoot, ".taskTools", "workflows", "7");
    mkdirSync(workflowFolder, { recursive: true });
    writeFileSync(join(workflowFolder, "steps.json"), "{}");
    git(repoRoot, "update-ref", "refs/taskTools/merged-commits/task-7", "HEAD");

    const cwd = process.cwd();
    process.chdir(repoRoot);
    try {
        await resetTask(7, "");
    } finally {
        process.chdir(cwd);
    }

    assert.equal(existsSync(runFolder), false);
    assert.equal(existsSync(join(agentsFolder, "task-7-implement-task.md")), false);
    assert.equal(existsSync(join(agentsFolder, "task-70-implement-task.md")), true);
    assert.equal(existsSync(workflowFolder), false);
    assert.equal(git(repoRoot, "for-each-ref", "refs/taskTools/merged-commits/"), "");
});

test("test_resetTask_blocksWhenALaterTaskMergeSitsOnStagingAndNamesIt", async () => {
    // Setup: staging holds task 3's merge, then task 4's merge on top; both are in completedTasks.json.
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "branch", "staging");
    const mergeHashes: Record<number, string> = {};
    for (const taskNumber of [3, 4]) {
        git(repoRoot, "checkout", "-q", "-b", `task-${taskNumber}`, "staging");
        writeFileSync(join(repoRoot, `task-${taskNumber}.txt`), "work\n");
        git(repoRoot, "add", `task-${taskNumber}.txt`);
        git(repoRoot, "commit", "-q", "-m", `task ${taskNumber} work`);
        git(repoRoot, "checkout", "-q", "staging");
        git(repoRoot, "merge", "-q", "--no-ff", "-m", `merge task-${taskNumber}`, `task-${taskNumber}`);
        mergeHashes[taskNumber] = git(repoRoot, "rev-parse", "HEAD").trim();
        git(repoRoot, "branch", "-D", `task-${taskNumber}`);
    }
    mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), "[]");
    writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), JSON.stringify([
        { taskNumber: 3, title: "t3", commitHashes: ["aaa", mergeHashes[3]] },
        { taskNumber: 4, title: "t4", commitHashes: ["bbb", mergeHashes[4]] },
    ]));

    const cwd = process.cwd();
    process.chdir(repoRoot);
    try {
        await assert.rejects(() => resetTask(3, ""), /reset of 3 blocked\. reset 4 first to unblock/);
    } finally {
        process.chdir(cwd);
    }
    assert.equal(git(repoRoot, "rev-parse", "staging").trim(), mergeHashes[4]);
});

test("test_resetTask_atEveryBlock_findsThePacketTheHookWrote", async () => {
    // Setup: task 9 is open with a run and a worktree; the real pipeline's steps.json names every block.
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
    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, "task-9");
    git(repoRoot, "branch", "task-9");
    git(repoRoot, "worktree", "add", worktreePath, "task-9");
    const stubFolder = mkdtempSync(join(tmpdir(), "resetTask-stubs-"));
    const cwd = process.cwd();
    try {
        const stepsConfigPath = join(taskWorkflowDirectory(join(repoRoot, ".taskTools", "tasks.json"), 9), "steps.json");
        mkdirSync(dirname(stepsConfigPath), { recursive: true });
        const setting = resolveDiagramFolderSetting(repoRoot);
        const stepsByDiagram = generateSteps(setting.diagramFolder, setting.stepsRoot, stepsConfigPath, setting.allowStubs);
        const boxCounts = new Map<string, number>();
        for (const entry of Object.values(stepsByDiagram).flat()) boxCounts.set(entry.box, (boxCounts.get(entry.box) ?? 0) + 1);
        // resetTask rejects a block named by more than one diagram, so those stay out of the sweep.
        const blocks = [...boxCounts].filter(([, count]) => count === 1).map(([box]) => box);
        assert.ok(blocks.length > 10);

        // A stub config with matching block names, each a stop, so the hook runs and writes its packet.
        const stubConfig: Record<string, unknown[]> = { "stub.mmd": [] };
        for (const box of blocks) {
            const script = join(stubFolder, `${box}.ts`);
            writeFileSync(script, `console.log(JSON.stringify({ box: ${JSON.stringify(box)}, scriptSignal: "stop" }));\n`);
            const template = join(stubFolder, `${box}.template.json`);
            writeFileSync(template, JSON.stringify({ input: {}, output: { box, scriptSignal: "stop" } }));
            stubConfig["stub.mmd"].push({ box, script, template, producesPrompt: false, next: [] });
        }
        const stubConfigPath = join(stubFolder, "steps.json");
        writeFileSync(stubConfigPath, JSON.stringify(stubConfig));

        const hook = fileURLToPath(new URL("../hooks/runStepHook.ts", import.meta.url));
        const packetInput = JSON.stringify({ taskNumber: 9, runId, projectRoot: repoRoot });
        const runLog = join(repoRoot, ".taskTools", "runs", "0000", "task-9-run-log.json");
        for (const box of blocks) {
            const spawned = spawnSync("node", ["--no-inspect", hook], {
                input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `/run-step ${box} ${packetInput}` }),
                encoding: "utf8",
                env: { ...process.env, RUN_STEP_LOG: runLog, RUN_STEP_CONFIG: stubConfigPath },
            });
            assert.equal(spawned.status, 0, `${box}: ${spawned.stderr}`);
            assert.match(spawned.stdout, /\\"ok\\":true/, `${box}: ${spawned.stdout}`);
        }
        const packetNames = readdirSync(join(repoRoot, ".taskTools", "runs", "0000", "packets"));

        // Action and verification: a reset at every block finds the packet the hook wrote for it.
        process.chdir(repoRoot);
        const boxesWithSourceLockHeld = new Set<string>();
        for (const box of blocks) {
            assert.ok(packetNames.some((name) => name.includes(`-${box}-`)), `no packet named ${box} among ${packetNames.join(", ")}`);
            const said = await resetTask(9, box);
            assert.match(said, new RegExp(`resumes at [^:]+::${box} on the next`), `${box}: ${said}`);
            // The checkpoint records whether this block sits inside the source lock's reach.
            if (readCheckpoint(worktreePath)?.sourceLockHeld === true) boxesWithSourceLockHeld.add(box);
        }
        assert.ok(boxesWithSourceLockHeld.has("RUN_FULL_SUITE"));
        assert.ok(boxesWithSourceLockHeld.has("DID_CHANGES_STAY_INSIDE_FENCE_Q"));
        assert.ok(!boxesWithSourceLockHeld.has("CREATE_WORKTREE"));
        assert.ok(!boxesWithSourceLockHeld.has("MARK_TASK_ACTIVE"));
    } finally {
        process.chdir(cwd);
        git(repoRoot, "worktree", "remove", "--force", worktreePath);
        rmSync(dirname(worktreePath), { recursive: true, force: true });
        rmSync(stubFolder, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});
