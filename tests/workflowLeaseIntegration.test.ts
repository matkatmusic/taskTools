// Integration proof for phase10-audit finding 1, on a real repository with a real retained lease.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimTask, endTaskRun, updateCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { runPreamble } from "../../scripts/tackle-tasks/PreambleDataEmitter.ts";
import { WorkflowResultCodes } from "../../scripts/tackle-tasks/WorkflowResultCodes.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";

const TASK = 92910;
const OLD_RUN_ID = "run-old-lease";
const NEW_RUN_ID = "run-new-lease";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// The recovery state the audit describes: an ended run left a safe worktree and its own lease behind.
function makeFixture(taskNumber: number): { root: string; worktree: string; notesFile: string } {
    const root = mkdtempSync(join(tmpdir(), "tackle-tasks-lease-integ-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");

    // Generated docs are never tracked, so the resumed worktree's fence sees no change outside the task.
    writeFileSync(join(root, ".gitignore"), [
        "plans/brief-*.md",
        "plans/plan.json",
        "plans/codex-review.json",
        "plans/test-review.json",
        "plans/implementation-notes-*.md",
        "",
    ].join("\n"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    writeFileSync(join(root, "taskfile.txt"), "root\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const task = {
        taskNumber, title: "fixture task", description: "fixture", files: ["taskfile.txt"],
        tests: "skip", blockedBy: [],
    };
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify([task], null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), "[]");

    assert.equal(claimTask(taskNumber, OLD_RUN_ID, root).status, "claimed");
    const created = createTaskWorktree(taskNumber, OLD_RUN_ID, root);
    assert.equal(created.branch, `task-${taskNumber}`);

    // The old run recorded a stopping point, which is what makes its worktree resumable.
    const notesFile = join(created.worktree, "plans", `implementation-notes-${taskNumber}.md`);
    mkdirSync(dirname(notesFile), { recursive: true });
    writeFileSync(notesFile, "did the work\n");

    // It then ended run-failed, exactly as a failed cleanup leaves it: worktree and lease retained.
    updateCurrentTaskRun(
        taskNumber,
        OLD_RUN_ID,
        { exitType: "run-failed", exitNote: "cleanup failed", implementationNotesFile: notesFile },
        root,
    );
    endTaskRun(taskNumber, OLD_RUN_ID, root);

    return { root, worktree: created.worktree, notesFile };
}

function readTaskLeaseRunId(root: string, taskNumber: number): string | null {
    const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8")) as {
        taskNumber: number;
        run?: { leaseRunId: string | null };
    }[];
    return tasks.find((task) => task.taskNumber === taskNumber)?.run?.leaseRunId ?? null;
}

test("test_preamble_adoptsTheRetainedLeaseBeforeItWritesTheDocsIntoThatWorktree", async () => {
    const { root, worktree } = makeFixture(TASK);
    const leasePath = taskWorktreeLeasePath(worktree);

    try {
        // Setup: the retained lease still names the run that died, not the run about to start.
        assert.equal(readTaskWorktreeLeaseOwner(leasePath)?.runId, OLD_RUN_ID);

        // Test action: a new run walks the preamble against that same worktree.
        const result = runPreamble(TASK, NEW_RUN_ID, root);

        // 1. The preamble resumed the retained worktree rather than refusing or resetting it.
        assert.equal(result.code, WorkflowResultCodes.PROCEED, result.reason ?? "");
        assert.equal(result.receipt?.worktree, worktree);

        // 2. Both lease records name the new run, so ownership was taken over, not left dangling.
        assert.equal(readTaskWorktreeLeaseOwner(leasePath)?.runId, NEW_RUN_ID);
        assert.equal(readTaskLeaseRunId(root, TASK), NEW_RUN_ID);

        // 3. The docs box did write into that worktree, which is the write ownership had to precede.
        const briefFile = result.receipt!.briefFile;
        assert.ok(existsSync(briefFile), `no brief at ${briefFile}`);

        // 4. Ownership was taken over first: the lease was written no later than the brief it guards.
        assert.ok(statSync(leasePath).mtimeMs <= statSync(briefFile).mtimeMs);
    } finally {
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
        rmSync(leasePath, { force: true });
        rmSync(root, { recursive: true, force: true });
    }
});

test("test_preamble_refusesTheWorktreeWhoseLeaseAnotherLiveRunStillOwns", async () => {
    const { root, worktree } = makeFixture(TASK);
    const leasePath = taskWorktreeLeasePath(worktree);

    try {
        // Setup: a live process owns the lease, so it can be neither adopted nor re-acquired.
        writeFileSync(leasePath, JSON.stringify({ pid: process.pid, runId: "run-someone-else" }));

        // Test action: a new run tries to take the same worktree.
        const result = runPreamble(TASK, NEW_RUN_ID, root);

        // Verification: the run stops, and the live owner's lease is left exactly as it was.
        assert.equal(result.code, WorkflowResultCodes.DO_NOT_PROCEED);
        assert.equal(readTaskWorktreeLeaseOwner(leasePath)?.runId, "run-someone-else");
    } finally {
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
        rmSync(leasePath, { force: true });
        rmSync(root, { recursive: true, force: true });
    }
});
