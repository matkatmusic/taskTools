// Tests the PreToolUse hook that blocks Edit or Write outside modifiableFiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "hooks", "agentFenceHook.ts");

function makeTasksFile(): string {
    const folder = mkdtempSync(join(tmpdir(), "agent-fence-hook-"));
    const tasksPath = join(folder, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify([{ taskNumber: 1, modifiableFiles: ["src/thing.ts"] }]));
    return tasksPath;
}

function runHook(tasksFile: string, filePath: string): string {
    return execFileSync("node", ["--no-inspect", SCRIPT, "1", tasksFile], {
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

test("throws loudly when the task number is not in tasks.json", () => {
    const tasksFile = makeTasksFile();
    assert.throws(() => execFileSync("node", ["--no-inspect", SCRIPT, "99", tasksFile], {
        input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/worktree/src/thing.ts" } }),
    }));
});
