// Behavioral check for AUTO_GENERATE_DOCS.ts. Mutating: exercised only against a temp worktree, never real state.  Run alone: node --test tests/steps/pipeline-documentGeneration/AUTO_GENERATE_DOCS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-documentGeneration/AUTO_GENERATE_DOCS.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import type { TaskGroup } from "../../../scripts/taskGroups.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-documentGeneration/AUTO_GENERATE_DOCS.template.json");

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "auto-generate-docs-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "fileA.txt"), "seed\n");
    git(repoRoot, "add", "fileA.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_AUTO_GENERATE_DOCS_writesTheBriefAndReturnsThePacketWithBriefFile", () => {
    // Setup: a real temp linked worktree for task 9.
    const repoRoot = makeTempRepo();
    seedTasksFile(repoRoot, [{ taskNumber: 9, title: "t9", description: "do it", files: ["fileA.txt"] }]);
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const packet = {
        taskNumber: 9, runId: "run-a", projectRoot: repoRoot, worktree: worktreePath, branch: "task-9",
        docsMode: "AUTOGEN", exitType: "", exitNote: "", clarifyRequest: "",
    };

    // Test action.
    const output = main(JSON.stringify(packet));

    // Verification: the brief was written, and the packet carries forward with briefFile added.
    assert.equal(output.box, "AUTO_GENERATE_DOCS");
    assert.equal(output.scriptSignal, "continue");
    assert.ok(existsSync(String(output.briefFile)));
    assert.deepEqual(output, { ...packet, box: "AUTO_GENERATE_DOCS", scriptSignal: "continue", briefFile: output.briefFile });

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
