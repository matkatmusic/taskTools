// Run: node --test tests/AgentPromptEmitter.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EMITTER = fileURLToPath(new URL("../scripts/tackle-tasks/AgentPromptEmitter.ts", import.meta.url));

const temporaryDirectories: string[] = [];
after(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// A project root and a worktree holding the one brief every role refuses to run without.
const stageTask = (taskNumber: number): { projectRoot: string; worktree: string } => {
    const projectRoot = mkdtempSync(join(tmpdir(), "AgentPromptEmitter-"));
    temporaryDirectories.push(projectRoot);
    mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "Staged", files: [] }]));
    writeFileSync(join(projectRoot, ".taskTools", "completedTasks.json"), JSON.stringify([]));
    const worktree = join(projectRoot, "worktree");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), "# staged brief\n");
    return { projectRoot, worktree };
};

test("test_emitterLogsTheSamePromptItPrinted", () => {
    const { projectRoot, worktree } = stageTask(35);
    const runId = "20260817-135641.444";
    const payload = JSON.stringify({ worktree, projectRoot, sourceBranch: "master", runId });

    const printed = execFileSync("node", [EMITTER, "35", "plan"], { input: payload, encoding: "utf8" });

    // The log is what a real run leaves behind for diffing against the generated prompt.
    const logged = readFileSync(join(projectRoot, "plans/diagram/output renders/35/runs", runId, "plan.md"), "utf8");
    assert.equal(logged, printed);
});

test("test_eachRoleLogsUnderItsOwnName", () => {
    const { projectRoot, worktree } = stageTask(35);
    const runId = "20260817-140000.000";
    const payload = JSON.stringify({ worktree, projectRoot, sourceBranch: "master", runId });

    execFileSync("node", [EMITTER, "35", "review-plan"], { input: payload, encoding: "utf8" });

    const directory = join(projectRoot, "plans/diagram/output renders/35/runs", runId);
    assert.match(readFileSync(join(directory, "review-plan.md"), "utf8"), /REVIEW_FILE/);
});
