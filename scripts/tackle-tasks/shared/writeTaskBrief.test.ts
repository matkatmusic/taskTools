// Behavioral checks for writeTaskBrief.ts: pure rendering, idempotent writing, generated-artifact isolation.  Run alone: node --test tests/writeTaskBrief.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
    configureGeneratedArtifactIsolation,
    generateTaskBriefContents,
    writeTaskBriefToDisk,
} from "./writeTaskBrief.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";
import type { TaskGroup } from "../../shared/taskGroups.ts";
import type { TaskRunRecord } from "./taskRunState.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "write-task-brief-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeTempRepoWithLocalSubmodule(): string {
    const submoduleOrigin = makeTempRepoWithCommit();
    const repoRoot = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return repoRoot;
}

function writeTasksFile(repoRoot: string, tasks: unknown[]): void {
    writeFileSync(join(repoRoot, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

function endedRun(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-x", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
        exitType: "run-failed", exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function listFilesRecursively(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        if (entry === ".git") continue;
        const fullPath = join(root, entry);
        if (statSync(fullPath).isDirectory()) results.push(...listFilesRecursively(fullPath));
        else results.push(relative(root, fullPath));
    }
    return results.sort();
}

test("test_generateTaskBriefContents_writesNothingToDisk", () => {
    // Scenario: rendering a brief must be a pure read, no side effects on disk.
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] }]);
    // Snapshot the project directory before rendering.
    const before = listFilesRecursively(repoRoot);
    // Render the brief.
    generateTaskBriefContents(1, repoRoot);
    // The directory listing is unchanged: nothing was written.
    const after = listFilesRecursively(repoRoot);
    assert.deepEqual(after, before);
});

test("test_generateTaskBriefContents_rendersTheTasksClarifyRequest", () => {
    // Scenario: a stored clarifyRequest must reach the planner through the brief.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [], clarifyRequest: "which file holds the parser?" }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(brief.includes("## clarifyRequest"));
    assert.ok(brief.includes("which file holds the parser?"));
});

test("test_generateTaskBriefContents_omitsTheClarifyRequestSectionWhenTheTaskHasNone", () => {
    // Scenario: no clarifyRequest on the task, no clarifyRequest heading in the brief.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [] }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(!brief.includes("## clarifyRequest"));
});

test("test_generateTaskBriefContents_rendersProblemSolvedByTaskVerbatim", () => {
    // Scenario: a task with problemSolvedByTask carries it verbatim into the brief.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [], problemSolvedByTask: "reviewers cannot tell what problem the task solves" }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(brief.includes("## problemSolvedByTask"));
    assert.ok(brief.includes("reviewers cannot tell what problem the task solves"));
});

test("test_generateTaskBriefContents_saysWhenProblemSolvedByTaskIsNotProvided", () => {
    // Scenario: an older task without the field gets an explicit not-provided line.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [] }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(brief.includes("## problemSolvedByTask"));
    assert.ok(brief.includes("(not provided: this task was created before the problemSolvedByTask field existed)"));
});

test("test_generateTaskBriefContents_returnsTheSameBytesWriteTaskBriefToDiskWrites", () => {
    // Scenario: writeTaskBriefToDisk writes exactly what generateTaskBriefContents computes.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [] }]);
    const worktreePath = mkdtempSync(join(tmpdir(), "write-task-brief-wt-"));
    // Render, then write, and compare bytes.
    const rendered = generateTaskBriefContents(1, repoRoot);
    const briefFile = writeTaskBriefToDisk(1, worktreePath, repoRoot);
    const written = readFileSync(briefFile, "utf8");
    assert.equal(written, rendered);
});

test("test_writeTaskBriefToDisk_isIdempotent", () => {
    // Scenario: running writeTaskBriefToDisk twice must produce the same file with the same bytes.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [] }]);
    const worktreePath = mkdtempSync(join(tmpdir(), "write-task-brief-wt-"));
    // Write once.
    const firstPath = writeTaskBriefToDisk(1, worktreePath, repoRoot);
    const firstBytes = readFileSync(firstPath, "utf8");
    // Write again.
    const secondPath = writeTaskBriefToDisk(1, worktreePath, repoRoot);
    const secondBytes = readFileSync(secondPath, "utf8");
    // Same path, same bytes.
    assert.equal(secondPath, firstPath);
    assert.equal(secondBytes, firstBytes);
});

test("test_generateTaskBriefContents_carriesAtMostThreePreviousRuns", () => {
    // Scenario: a task has five ended previous runs; the brief must only mention the three most recent.
    const repoRoot = makeTempRepoWithCommit();
    const history = ["run-1", "run-2", "run-3", "run-4", "run-5"].map((runId) => endedRun({ runId }));
    writeTasksFile(repoRoot, [{
        taskNumber: 1, title: "t1", description: "do the thing", files: [],
        run: { active: false, worktree: null, leaseRunId: null, history },
    }]);
    // Render the brief.
    const brief = generateTaskBriefContents(1, repoRoot);
    // Only the three most recent runs appear; the two oldest are absent.
    assert.ok(brief.includes("run-3"));
    assert.ok(brief.includes("run-4"));
    assert.ok(brief.includes("run-5"));
    assert.ok(!brief.includes("run-1"));
    assert.ok(!brief.includes("run-2"));
});

test("test_generateTaskBriefContents_saysHowManyEarlierRunsWereOmitted", () => {
    // Scenario: a task has seven ended previous runs; four are earlier than the three kept.
    const repoRoot = makeTempRepoWithCommit();
    const history = Array.from({ length: 7 }, (_, index) => endedRun({ runId: `run-${index + 1}` }));
    writeTasksFile(repoRoot, [{
        taskNumber: 1, title: "t1", description: "do the thing", files: [],
        run: { active: false, worktree: null, leaseRunId: null, history },
    }]);
    // Render the brief.
    const brief = generateTaskBriefContents(1, repoRoot);
    // The exact omission wording appears.
    assert.ok(brief.includes("(4 earlier runs omitted)"));
});

test("test_generateTaskBriefContents_omitsThePreviousRunSectionWhenThereAreNone", () => {
    // Scenario: a task has never run before.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", files: [] }]);
    // Render the brief.
    const brief = generateTaskBriefContents(1, repoRoot);
    // No "previous runs" heading appears anywhere in the brief.
    assert.ok(!/previous runs/i.test(brief));
});

test("test_generateTaskBriefContents_carriesTheFieldsThatTellTwoRunsApart", () => {
    // A previous-run section must show its start time, touched files, and notes file, so two runs read differently.
    const repoRoot = makeTempRepoWithCommit();
    const history = [endedRun({
        runId: "run-a", startedAt: "2026-08-02T03:04:05-07:00", exitType: "tests-red",
        exitNote: "task tests failed", modifiedFiles: ["src/a.ts", "src/b.ts"],
        implementationNotesFile: "plans/implementation-notes-1.md",
    })];
    writeTasksFile(repoRoot, [{
        taskNumber: 1, title: "t1", description: "do the thing", files: [],
        run: { active: false, worktree: null, leaseRunId: null, history },
    }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(brief.includes("### Run run-a — 2026-08-02T03:04:05-07:00"));
    assert.ok(brief.includes("Exit type: tests-red"));
    assert.ok(brief.includes("Exit note: task tests failed"));
    assert.ok(brief.includes("Modified files: src/a.ts, src/b.ts"));
    assert.ok(brief.includes("Implementation notes: plans/implementation-notes-1.md"));
});

test("test_generateTaskBriefContents_ordersPreviousRunsNewestFirstAndSkipsRunsWithNoExitType", () => {
    // Scenario: a run that never recorded an exit type explains nothing, so it is left out.
    const repoRoot = makeTempRepoWithCommit();
    const history = [
        endedRun({ runId: "run-old", startedAt: "2026-08-01T00:00:00-07:00" }),
        endedRun({ runId: "run-silent", exitType: null }),
        endedRun({ runId: "run-new", startedAt: "2026-08-03T00:00:00-07:00" }),
    ];
    writeTasksFile(repoRoot, [{
        taskNumber: 1, title: "t1", description: "do the thing", files: [],
        run: { active: false, worktree: null, leaseRunId: null, history },
    }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(!brief.includes("run-silent"));
    assert.ok(brief.indexOf("run-new") < brief.indexOf("run-old"));
});

test("test_generateTaskBriefContents_writesThePreviousRunsHeadingExactlyOnce", () => {
    // The old box appended a second "## Previous runs" heading; one renderer must mean one heading.
    const repoRoot = makeTempRepoWithCommit();
    writeTasksFile(repoRoot, [{
        taskNumber: 1, title: "t1", description: "do the thing", files: [],
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRun()] },
    }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.equal(brief.split("## Previous runs").length - 1, 1);
});

test("test_configureGeneratedArtifactIsolation_marksAnAlreadyTrackedBriefSkipWorktree", () => {
    // Scenario: a linked worktree's index already tracks a generated brief file.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    writeFileSync(join(repoRoot, "plans", "brief-9.md"), "old brief\n");
    git(repoRoot, "add", "plans/brief-9.md");
    git(repoRoot, "commit", "-q", "-m", "add brief-9");
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Mark generated artifacts skip-worktree in the linked worktree's own index.
    const marked = configureGeneratedArtifactIsolation(9, worktreePath);
    // The already tracked brief was found and marked.
    assert.ok(marked.includes("plans/brief-9.md"));
    const lsFilesOutput = git(worktreePath, "ls-files", "-v", "--", "plans/brief-9.md");
    assert.match(lsFilesOutput, /^S plans\/brief-9\.md/m);
});

test("test_configureGeneratedArtifactIsolation_hidesAnAlreadyTrackedBriefFromGitAddAll", () => {
    // Scenario: after marking skip-worktree, rewriting the brief must not surface it to `git add -A`.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    writeFileSync(join(repoRoot, "plans", "brief-9.md"), "old brief\n");
    git(repoRoot, "add", "plans/brief-9.md");
    git(repoRoot, "commit", "-q", "-m", "add brief-9");
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    configureGeneratedArtifactIsolation(9, worktreePath);
    // Rewrite the tracked brief, as the pipeline does when it regenerates the brief.
    writeFileSync(join(worktreePath, "plans", "brief-9.md"), "new brief\n");
    // Stage everything the same way commitTaskWork does.
    git(worktreePath, "add", "-A");
    // The brief is absent from status, from the staged diff, and from a resulting commit.
    const status = git(worktreePath, "status", "--porcelain");
    assert.ok(!status.includes("plans/brief-9.md"));
    const stagedNames = git(worktreePath, "diff", "--cached", "--name-only");
    assert.ok(!stagedNames.includes("plans/brief-9.md"));
    git(worktreePath, "commit", "-q", "-m", "unrelated change", "--allow-empty");
    const committedNames = git(worktreePath, "show", "--name-only", "--pretty=format:", "HEAD");
    assert.ok(!committedNames.includes("plans/brief-9.md"));
});

test("test_configureGeneratedArtifactIsolation_leavesTheCanonicalCheckoutsIndexUntouched", () => {
    // Scenario: skip-worktree is set inside a linked worktree; the canonical checkout must not be affected.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    writeFileSync(join(repoRoot, "plans", "brief-9.md"), "old brief\n");
    git(repoRoot, "add", "plans/brief-9.md");
    git(repoRoot, "commit", "-q", "-m", "add brief-9");
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    configureGeneratedArtifactIsolation(9, worktreePath);
    // The canonical repo's own index still shows the file as a normal tracked entry.
    const canonicalLsFilesOutput = git(repoRoot, "ls-files", "-v", "--", "plans/brief-9.md");
    assert.match(canonicalLsFilesOutput, /^H plans\/brief-9\.md/m);
});

test("test_configureGeneratedArtifactIsolation_isANoOpWhenNoGeneratedPathIsTracked", () => {
    // Scenario: a freshly created worktree tracks no generated-document paths.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 10, taskNumbers: [10], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // No paths are marked and nothing throws.
    const marked = configureGeneratedArtifactIsolation(10, worktreePath);
    assert.deepEqual(marked, []);
});

test("test_generateTaskBriefContents_rendersTheTasksTitleDescriptionsAndModifiableFiles", () => {
    // Scenario: the brief for task N must carry task N's own title, both descriptions, and its file list.
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "x\n");
    writeTasksFile(repoRoot, [{ taskNumber: 1, title: "t1", description: "do the thing", userDescription: "user asked for the thing", modifiableFiles: ["fileA.txt"] }]);
    const brief = generateTaskBriefContents(1, repoRoot);
    assert.ok(brief.includes("# Task 1: t1"));
    assert.ok(brief.includes("do the thing"));
    assert.ok(brief.includes("user asked for the thing"));
    assert.ok(brief.includes("@fileA.txt"));
});
