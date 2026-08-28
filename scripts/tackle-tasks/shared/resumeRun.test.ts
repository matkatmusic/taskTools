// Behavioral checks for scripts/tackle-tasks/shared/resumeRun.ts. Run: node --test tests/resumeRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findResumeEntry, findStartAtBlockEntry, prepareResume } from "./resumeRun.ts";
import { readCheckpoint, writeCheckpoint, type Checkpoint } from "./checkpoint.ts";
import {
    claimTask, endTaskRun, readTaskRunState, updateCurrentTaskRun,
} from "./taskRunState.ts";
import { writeTaskExitNotes } from "./writeTaskExitNotes.ts";
import {
    acquireSourceRepoLock, buildLockOwner, readSourceRepoLock, releaseSourceRepoLock,
} from "./sourceRepoLock.ts";
import { createWorktreeForGroup, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("resume-run-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

// The canonical source repository: a root repo with one real submodule, per global rule 9.
function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
// runId is passed through so the worktree's lease names the same run as the seeded task, unlike commitTaskWork.test.ts's version.
function createLinkedWorktree(rootOrigin: string, runId: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, runId);
}

function seedTaskAndClaim(rootOrigin: string, taskNumber: number, title: string, runId: string, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title, files }]);
    const outcome = claimTask(taskNumber, runId, rootOrigin);
    assert.equal(outcome.status, "claimed");
}

// Same escaping runStepHook.ts's getShellQuotedArgument does, so the entry text is byte-for-byte what the hook writes.
function quoteArgumentLikeTheHook(argument: string): string {
    return `'${argument.replaceAll("'", `'\\''`)}'`;
}

// One block-pass packet, written by hand for a test run folder: <runsFolder>/<stamp>/packets/<box>-<pid>-<n>.json.
function writePacketFile(runsFolder: string, stamp: string, box: string, pid: number, n: number, command: string): string {
    const packetsFolder = join(runsFolder, stamp, "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetPath = join(packetsFolder, `${box}-${pid}-${n}.json`);
    writeFileSync(packetPath, JSON.stringify({ input: {}, command, commandOutput: "", output: {} }));
    return packetPath;
}

function baseCheckpoint(taskNumber: number, runId: string, projectRoot: string): Checkpoint {
    return {
        taskNumber, passId: "pass-1", runId, projectRoot,
        block: "diagram.mmd::SOME_BOX", input: JSON.stringify({ taskNumber, runId }),
        state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    };
}

test("test_findResumeEntry_returnsNullForATaskThatIsNotInTasksJson", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, []);

    const entry = findResumeEntry(9201, tasksPath);
    assert.equal(entry, null);
});

test("test_findResumeEntry_returnsTheCheckpointBlockAndInput", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9202;
    const runId = "run-9202";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "resume mid-run", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    const checkpoint = baseCheckpoint(taskNumber, runId, rootOrigin);
    writeCheckpoint(worktreePath, checkpoint);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    assert.deepEqual(entry, { block: checkpoint.block, input: checkpoint.input });
    const after = readCheckpoint(worktreePath);
    assert.equal(after?.state, "running");
    assert.deepEqual(after?.resumedFrom, { block: checkpoint.block, exitType: "", exitNote: "" });
});

test("test_findResumeEntry_keepsAScrapInResumedFromAcrossALaterKill", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9203;
    const runId = "run-9203";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "resume after scrap then kill", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    const scrapped = { block: "pipeline-whatIsReviewVerdict.mmd::TWO_CODEX_REVIEWS_COMPLETED_Q", exitType: "plan-scrapped", exitNote: "n" };
    writeCheckpoint(worktreePath, { ...baseCheckpoint(taskNumber, runId, rootOrigin), resumedFrom: scrapped });

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    findResumeEntry(taskNumber, tasksPath);

    assert.deepEqual(readCheckpoint(worktreePath)?.resumedFrom, scrapped);
});

test("test_findResumeEntry_replacesResumedFromWithAFailureExit", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9204;
    const runId = "run-9204";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "resume after a second failure", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    const earlier = { block: "x.mmd::X", exitType: "plan-scrapped", exitNote: "n" };
    const checkpoint = { ...baseCheckpoint(taskNumber, runId, rootOrigin), state: "failed" as const, exitType: "tests-red", exitNote: "red", resumedFrom: earlier };
    writeCheckpoint(worktreePath, checkpoint);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    findResumeEntry(taskNumber, tasksPath);

    assert.deepEqual(readCheckpoint(worktreePath)?.resumedFrom, { block: checkpoint.block, exitType: "tests-red", exitNote: "red" });
});

test("test_findResumeEntry_resumesTheMergeTailAtBuildClosureNoteWhileActive", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9203;
    const runId = "run-9203";
    seedTaskAndClaim(rootOrigin, taskNumber, "merge tail active", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { exitType: "completed" }, rootOrigin);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    assert.deepEqual(entry, {
        block: "pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE",
        input: JSON.stringify({ box: "CLEAN_UP_WORKTREES", scriptSignal: "continue", projectRoot: rootOrigin, taskNumber, runId }),
    });
});

test("test_findResumeEntry_resumesTheMergeTailAtArchiveTaskWhenInactive", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9204;
    const runId = "run-9204";
    seedTaskAndClaim(rootOrigin, taskNumber, "merge tail inactive", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { exitType: "completed" }, rootOrigin);
    endTaskRun(taskNumber, runId, rootOrigin);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    assert.deepEqual(entry, {
        block: "pipeline-mergeSucceededExit.mmd::ARCHIVE_TASK",
        input: JSON.stringify({ box: "CLEAN_UP_WORKTREES", scriptSignal: "continue", projectRoot: rootOrigin, taskNumber, runId }),
    });
});

test("test_findResumeEntry_endsARunThatDiedBeforeAWorktreeAndReturnsNull", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9205;
    const runId = "run-9205";
    seedTaskAndClaim(rootOrigin, taskNumber, "died before worktree", runId, []);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    assert.equal(entry, null);
    const state = readTaskRunState(taskNumber, rootOrigin);
    assert.equal(state.active, false);
    const newest = state.history[state.history.length - 1];
    assert.equal(newest.exitType, "agent-failed");
});

test("test_findResumeEntry_returnsNullWhenTheWorktreeIsGone", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9206;
    const runId = "run-9206";
    seedTaskAndClaim(rootOrigin, taskNumber, "worktree gone", runId, []);
    endTaskRun(taskNumber, runId, rootOrigin);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);

    assert.equal(entry, null);
});

test("test_prepareResume_reopensTheRecordAndRetakesTheLock", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9207;
    const runId = "run-9207";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "retakes lock", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    const owner = buildLockOwner(runId, taskNumber);
    acquireSourceRepoLock(rootOrigin, owner);
    writeTaskExitNotes({ taskNumber, runId, projectRoot: rootOrigin, exitType: "tests-red", exitNote: "n" });
    endTaskRun(taskNumber, runId, rootOrigin);
    releaseSourceRepoLock(rootOrigin, owner);

    prepareResume({ ...baseCheckpoint(taskNumber, runId, rootOrigin), sourceLockHeld: true });

    assert.equal(readTaskRunState(taskNumber, rootOrigin).active, true);
    assert.equal(readSourceRepoLock(rootOrigin)?.owner, owner);
});

test("test_prepareResume_acceptsALockThisRunStillHolds", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9208;
    const runId = "run-9208";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "crash keeps lock", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    const owner = buildLockOwner(runId, taskNumber);
    acquireSourceRepoLock(rootOrigin, owner);
    writeTaskExitNotes({ taskNumber, runId, projectRoot: rootOrigin, exitType: "tests-red", exitNote: "n" });
    endTaskRun(taskNumber, runId, rootOrigin);
    // Lock never released: this is the crash case.

    assert.doesNotThrow(() => {
        prepareResume({ ...baseCheckpoint(taskNumber, runId, rootOrigin), sourceLockHeld: true });
    });
    assert.equal(readSourceRepoLock(rootOrigin)?.owner, owner);
});

test("test_prepareResume_throwsWhenTheLeaseNamesAnotherRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9209;
    const runId = "run-9209";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "lease mismatch", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    endTaskRun(taskNumber, runId, rootOrigin);
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "other", pid: 1, createdAt: 0 }));

    assert.throws(() => {
        prepareResume(baseCheckpoint(taskNumber, runId, rootOrigin));
    });
});

test("test_prepareResume_throwsWhenAnotherRunHoldsTheSourceLock", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9210;
    const runId = "run-9210";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "lock held by another run", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    endTaskRun(taskNumber, runId, rootOrigin);
    acquireSourceRepoLock(rootOrigin, buildLockOwner("other-run", taskNumber));

    assert.throws(() => {
        prepareResume({ ...baseCheckpoint(taskNumber, runId, rootOrigin), sourceLockHeld: true });
    });
});

test("test_findStartAtBlockEntry_returnsNullWhenTheWorktreeIsGone", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9211;
    const runId = "run-9211";
    seedTaskAndClaim(rootOrigin, taskNumber, "worktree gone for start-at-block", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: join(tmpdir(), "start-at-block-no-such-worktree") }, rootOrigin);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const runLogFolder = tmpMkdir("run-log-");
    const entry = findStartAtBlockEntry(taskNumber, tasksPath, "SOME_BOX", runLogFolder);

    assert.equal(entry, null);
});

test("test_findStartAtBlockEntry_returnsNullWhenThePlanOrBriefIsMissing", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9212;
    const runId = "run-9212";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "plan present brief missing", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "plan.json"), "{}\n");
    // No brief-<taskNumber>.md written on purpose.

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const runLogFolder = tmpMkdir("run-log-");
    const entry = findStartAtBlockEntry(taskNumber, tasksPath, "SOME_BOX", runLogFolder);

    assert.equal(entry, null);
});

test("test_findStartAtBlockEntry_returnsNullWhenNoPacketNamesTheBlockForThisRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9213;
    const runId = "run-9213";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "log entry names another run", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "plan.json"), "{}\n");
    writeFileSync(join(worktreePath, "plans", `brief-${taskNumber}.md`), "# brief\n");

    const runLogFolder = tmpMkdir("run-log-");
    const otherRunInput = JSON.stringify({ taskNumber, runId: "some-other-run", note: "not this run" });
    const command = `node --no-inspect scripts/tackle-tasks/fake/FAKE_SCRIPT.ts ${quoteArgumentLikeTheHook(otherRunInput)}`;
    writePacketFile(runLogFolder, "stamp-1", "SOME_BOX", 1, 1, command);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findStartAtBlockEntry(taskNumber, tasksPath, "SOME_BOX", runLogFolder);

    assert.equal(entry, null);
});

test("test_findStartAtBlockEntry_returnsTheNewestPacketInputForTheBlock", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9214;
    const runId = "run-9214";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "last logged input wins", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "plan.json"), "{}\n");
    writeFileSync(join(worktreePath, "plans", `brief-${taskNumber}.md`), "# brief\n");

    const runLogFolder = tmpMkdir("run-log-");
    const earlierInput = JSON.stringify({ taskNumber, runId, note: "earlier pass" });
    const laterInput = JSON.stringify({ taskNumber, runId, note: "later pass with a 'quoted' word" });
    const earlierCommand = `node --no-inspect scripts/tackle-tasks/fake/FAKE_SCRIPT.ts ${quoteArgumentLikeTheHook(earlierInput)}`;
    const laterCommand = `node --no-inspect scripts/tackle-tasks/fake/FAKE_SCRIPT.ts ${quoteArgumentLikeTheHook(laterInput)}`;
    const earlierPacket = writePacketFile(runLogFolder, "stamp-1", "SOME_BOX", 1, 1, earlierCommand);
    const laterPacket = writePacketFile(runLogFolder, "stamp-1", "SOME_BOX", 1, 2, laterCommand);
    const now = Date.now();
    utimesSync(earlierPacket, now / 1000, now / 1000);
    utimesSync(laterPacket, now / 1000 + 1, now / 1000 + 1);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findStartAtBlockEntry(taskNumber, tasksPath, "SOME_BOX", runLogFolder);

    assert.deepEqual(entry, { input: laterInput, runId, projectRoot: rootOrigin });
});

test("test_findStartAtBlockEntry_ignoresANewerPacketFromAnotherRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9216;
    const runId = "run-9216";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "ignores a newer packet from another run", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "plan.json"), "{}\n");
    writeFileSync(join(worktreePath, "plans", `brief-${taskNumber}.md`), "# brief\n");

    const runLogFolder = tmpMkdir("run-log-");
    const thisRunInput = JSON.stringify({ taskNumber, runId, note: "this run" });
    const otherRunInput = JSON.stringify({ taskNumber, runId: "some-other-run", note: "another task's run" });
    const thisRunCommand = `node --no-inspect scripts/tackle-tasks/fake/FAKE_SCRIPT.ts ${quoteArgumentLikeTheHook(thisRunInput)}`;
    const otherRunCommand = `node --no-inspect scripts/tackle-tasks/fake/FAKE_SCRIPT.ts ${quoteArgumentLikeTheHook(otherRunInput)}`;
    const thisRunPacket = writePacketFile(runLogFolder, "stamp-1", "SOME_BOX", 1, 1, thisRunCommand);
    const otherRunPacket = writePacketFile(runLogFolder, "stamp-2", "SOME_BOX", 2, 1, otherRunCommand);
    const now = Date.now();
    utimesSync(thisRunPacket, now / 1000, now / 1000);
    utimesSync(otherRunPacket, now / 1000 + 1, now / 1000 + 1);

    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findStartAtBlockEntry(taskNumber, tasksPath, "SOME_BOX", runLogFolder);

    assert.deepEqual(entry, { input: thisRunInput, runId, projectRoot: rootOrigin });
});

test("test_prepareResume_acceptsTheFourFieldsAlone", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = 9215;
    const runId = "run-9215";
    const worktreePath = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, "prepareResume accepts four fields", runId, []);
    updateCurrentTaskRun(taskNumber, runId, { worktree: worktreePath }, rootOrigin);

    prepareResume({ taskNumber, runId, projectRoot: rootOrigin, sourceLockHeld: false });

    assert.equal(readTaskRunState(taskNumber, rootOrigin).active, true);
});
