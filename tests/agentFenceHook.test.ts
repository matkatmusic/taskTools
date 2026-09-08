// Tests the PreToolUse hook that blocks Edit or Write outside modifiableFiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "hooks", "agentFenceHook.ts");

function makeTasksFile(): string {
    const folder = mkdtempSync(join(tmpdir(), "agent-fence-hook-"));
    const tasksPath = join(folder, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify([{ taskNumber: 1, modifiableFiles: ["src/thing.ts"] }]));
    return tasksPath;
}

function runHook(tasksFile: string, filePath: string, box = "IMPLEMENT_TASK"): string {
    return execFileSync("node", ["--no-inspect", SCRIPT, "1", tasksFile, box], {
        input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath } }),
        encoding: "utf8",
    });
}

test("allows an edit inside the task's modifiableFiles fence", () => {
    const tasksFile = makeTasksFile();
    const output = runHook(tasksFile, "/worktree/src/thing.ts");
    assert.equal(output, "");
});

test("denies an edit outside the task's modifiableFiles fence", () => {
    const tasksFile = makeTasksFile();
    const output = runHook(tasksFile, "/worktree/src/other.ts");
    const parsed = JSON.parse(output);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /\/worktree\/src\/other\.ts/);
});

test("denies a path that only shares a suffix with a fenced file, not a real segment boundary", () => {
    const tasksFile = makeTasksFile();
    const output = runHook(tasksFile, "/worktree/other-src/thing.ts");
    const parsed = JSON.parse(output);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("PLAN_THE_TASK may edit only plans/plan.json", () => {
    const tasksFile = makeTasksFile();
    assert.equal(runHook(tasksFile, "/worktree/plans/plan.json", "PLAN_THE_TASK"), "");
    const denied = JSON.parse(runHook(tasksFile, "/worktree/src/thing.ts", "PLAN_THE_TASK"));
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /PLAN_THE_TASK fence/);
});

test("FIX_CONFLICTS may edit modifiableFiles and the paths git reports unmerged", () => {
    const tasksFile = makeTasksFile();
    const repo = mkdtempSync(join(tmpdir(), "agent-fence-conflict-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "lib"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "lib", "clash.ts"), "base\n");
    writeFileSync(join(repo, "lib", "calm.ts"), "base\n");
    git("add", "."); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(repo, "lib", "clash.ts"), "side\n");
    git("commit", "-q", "-am", "side");
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "lib", "clash.ts"), "main\n");
    git("commit", "-q", "-am", "main");
    assert.throws(() => git("merge", "side"));

    assert.equal(runHook(tasksFile, join(repo, "lib", "clash.ts"), "FIX_CONFLICTS"), "");
    assert.equal(runHook(tasksFile, join(repo, "src", "thing.ts"), "FIX_CONFLICTS"), "");
    const denied = JSON.parse(runHook(tasksFile, join(repo, "lib", "calm.ts"), "FIX_CONFLICTS"));
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
});

test("throws loudly when the task number is not in tasks.json", () => {
    const tasksFile = makeTasksFile();
    assert.throws(() => execFileSync("node", ["--no-inspect", SCRIPT, "99", tasksFile, "IMPLEMENT_TASK"], {
        input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/worktree/src/thing.ts" } }),
    // Exit 2 is the blocking exit; exit 1 would let the edit through.
    }), (error: { status: number }) => error.status === 2);
});
