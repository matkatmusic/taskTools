// Integration proof for phase10-audit.md finding 1 / feedback-phase10-1.md "finding 1 remains
// unresolved": a real ended run retains a structurally safe worktree and its old physical lease;
// a new claimed run must adopt both lease records before the real updateTaskDocs box runs, and
// real cleanupTaskWorktree must then succeed with no owner mismatch.
//
// Every green (script) box in skills/tackle-tasks/tackle-tasks.workflow.js runs for real, via
// `node <script>.ts` fed the exact stdin the workflow builds — no script is mocked. Only the 8
// yellow (agent-role) boxes are stubbed, and each stub performs the real filesystem work the next
// green box depends on (a real plans/plan.json, a real codex-review.json, a real edited owned
// file, a real implementation-notes file), exactly as an implementing agent would.
// Run: node --test tests/tackle-tasks/workflowLeaseIntegration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { claimTask, endTaskRun, updateCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { readSourceRepoLock } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, "skills", "tackle-tasks", "tackle-tasks.workflow.js");
const workflowSource = readFileSync(workflowPath, "utf8").replace("export const meta", "const meta");
const scriptsDir = join(repoRoot, "scripts", "tackle-tasks");

const TASK = 92910;
const OLD_RUN_ID = "run-old-lease";
const NEW_RUN_ID = "run-new-lease";

// Same two helpers as tests/tackle-tasks/workflowBehavior.test.ts: the box name is everything
// before the trailing ":<taskNumber>" in the label, and every prompt carries its stdin payload
// inside one quoted heredoc.
const boxOf = (label: string) => label.slice(0, label.lastIndexOf(":"));
const payloadOf = (prompt: string) => {
    const match = /<<'TASK_PAYLOAD'\n([\s\S]*?)\nTASK_PAYLOAD/.exec(prompt);
    assert.ok(match, "prompt carries no TASK_PAYLOAD heredoc");
    return JSON.parse(match[1]) as Record<string, unknown>;
};

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// A real repo, a real ended run, a real linked worktree, a real retained physical lease — the
// exact starting state phase10-audit.md finding 1 describes: "a normal recovery state, not a
// speculative race".
function makeFixture(taskNumber: number): { root: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), "tackle-tasks-lease-integ-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    // Mirrors the real repo's .gitignore (§1f): generated plan/brief/notes artifacts are never
    // tracked, so the file fence never sees them as a change outside the task's owned files.
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

    // The old run ends run-failed, exactly as a failed clean-up leaves it: worktree and physical
    // lease both retained, both still naming the old run.
    updateCurrentTaskRun(taskNumber, OLD_RUN_ID, { exitType: "run-failed", exitNote: "cleanup failed" }, root);
    endTaskRun(taskNumber, OLD_RUN_ID, root);

    return { root, worktree: created.worktree };
}

function readTaskLeaseRunId(root: string, taskNumber: number): string | null {
    const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8")) as { taskNumber: number; run?: { leaseRunId: string | null } }[];
    return tasks.find((task) => task.taskNumber === taskNumber)?.run?.leaseRunId ?? null;
}

// The 8 yellow boxes. Each performs the real filesystem work the next green box needs, matching
// plans/plan-format.md and scripts/tackle-tasks/validateCodexReview.ts's "amend" shape exactly.
const ROLE_STUBS: Record<string, (worktree: string, taskNumber: number) => Record<string, unknown>> = {
    plan: (worktree, taskNumber) => {
        const planFile = join(worktree, "plans", "plan.json");
        mkdirSync(dirname(planFile), { recursive: true });
        writeFileSync(planFile, JSON.stringify({
            task: taskNumber, revision: 1,
            sections: [{ id: "do-the-work", title: "Do the work", body: `Implement task ${taskNumber}.` }],
        }));
        return { planWritten: true };
    },
    "review-plan": (worktree) => {
        const reviewFile = join(worktree, "plans", "codex-review.json");
        writeFileSync(reviewFile, JSON.stringify({
            verdict: "amend",
            amendments: [{ op: "replace", id: "do-the-work", title: "Do the work", body: "Implement it fully." }],
        }));
        return { reviewWritten: true, reviewer: "codex" };
    },
    implement: (worktree, taskNumber) => {
        writeFileSync(join(worktree, "taskfile.txt"), "implemented\n");
        const notesFile = join(worktree, "plans", `implementation-notes-${taskNumber}.md`);
        mkdirSync(dirname(notesFile), { recursive: true });
        writeFileSync(notesFile, "did the work\n");
        return { implemented: true, implementationNotesFile: notesFile, remaining: [] };
    },
    "review-tests": () => ({ flagged: false, reviewer: "codex" }),
    "fix-tests": () => ({ fixed: true }),
    "fix-suite": () => ({ fixed: true }),
    "fix-conflicts": () => ({ resolved: true, unresolvedPaths: [] }),
    "amend-tests": () => ({ amended: true }),
};

test("test_workflow_adoptsTheRetainedLeaseBeforeUpdateTaskDocsAndCleansUpWithoutAnOwnerMismatch", async () => {
    const { root, worktree } = makeFixture(TASK);
    let leaseSnapshotBeforeUpdateTaskDocs: { taskLeaseRunId: string | null; physicalLeaseRunId: string | null } | null = null;
    const calls: string[] = [];

    try {
        const stubAgent = async (prompt: string, options: { label: string }) => {
            const box = boxOf(options.label);
            const payload = payloadOf(prompt);
            calls.push(box);

            if (box === "updateTaskDocs" && leaseSnapshotBeforeUpdateTaskDocs === null) {
                leaseSnapshotBeforeUpdateTaskDocs = {
                    taskLeaseRunId: readTaskLeaseRunId(root, TASK),
                    physicalLeaseRunId: readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktree))?.runId ?? null,
                };
            }

            const roleStub = ROLE_STUBS[box];
            if (roleStub) return roleStub(worktree, TASK);

            const scriptPath = join(scriptsDir, `${box}.ts`);
            try {
                const output = execFileSync("node", [scriptPath], { input: JSON.stringify(payload), encoding: "utf8" });
                return JSON.parse(output);
            } catch (error) {
                const failure = error as { stderr?: string; message?: string };
                throw new Error(`${box} exited non-zero: ${failure.stderr || failure.message}`);
            }
        };

        const compiled = compileFunction(
            `return (async () => { 'use strict'\n${workflowSource}\n })()`,
            ["args", "log", "agent"],
            { filename: workflowPath },
        ) as (a: string, l: (m: string) => void, g: typeof stubAgent) => Promise<{ task: number; exitType: string; exitNote: string; chainRan: boolean }>;

        const args = {
            task: TASK, projectRoot: root, sourceBranch: "main", runId: NEW_RUN_ID,
            scriptsDir, agentPromptEmitterPath: join(scriptsDir, "AgentPromptEmitter.ts"),
        };
        const result = await compiled(JSON.stringify(args), () => {}, stubAgent);

        // 1. Before the real updateTaskDocs box ran, both lease records named the new run.
        assert.ok(leaseSnapshotBeforeUpdateTaskDocs, "updateTaskDocs never ran");
        const snapshot = leaseSnapshotBeforeUpdateTaskDocs as { taskLeaseRunId: string | null; physicalLeaseRunId: string | null };
        assert.equal(snapshot.taskLeaseRunId, NEW_RUN_ID);
        assert.equal(snapshot.physicalLeaseRunId, NEW_RUN_ID);
        assert.notEqual(snapshot.taskLeaseRunId, OLD_RUN_ID);
        assert.ok(calls.indexOf("isTaskRunResumable") < calls.indexOf("updateTaskDocs"));

        // 2. The workflow ran to a completed exit, not run-failed.
        assert.equal(result.exitType, "completed");
        assert.equal(result.exitNote, "archived to completedTasks.json");
        assert.equal(result.chainRan, true);

        // 3. Real cleanupTaskWorktree succeeded (a real owner mismatch throws, which would have
        // surfaced above as run-failed) and released the worktree lease and the source lock.
        assert.equal(calls.filter((box) => box === "cleanupTaskWorktree").length, 1);
        assert.equal(existsSync(worktree), false);
        assert.equal(existsSync(taskWorktreeLeasePath(worktree)), false);
        assert.equal(readSourceRepoLock(root), null);
    } finally {
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
        rmSync(`${worktree}.lease`, { force: true });
        rmSync(root, { recursive: true, force: true });
    }
});
