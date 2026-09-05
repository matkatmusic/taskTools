// Behavioral checks for IS_DIFFICULTY_7_PLUS_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_DIFFICULTY_7_PLUS_Q.ts";

function makeProjectRoot(taskNumber: number, difficulty: number): string {
    const root = mkdtempSync(join(tmpdir(), "is-difficulty-7-plus-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber, difficulty }]));
    return root;
}

function packet(projectRoot: string, taskNumber: number) {
    return {
        box: "DOCUMENT_GENERATION", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot,
        worktree: "/abs/worktree", branch: `task-${taskNumber}`, docsMode: "AUTOGEN", planFile: "", exitType: "", exitNote: "",
    };
}

test("test_main_choosesPlanTheTaskCodexWhenDifficultyIsAtLeast7", () => {
    // Setup: tasks.json records difficulty 7 for the task.
    const root = makeProjectRoot(1, 7);
    const input = packet(root, 1);
    // Verification: the walk lands on PLAN_THE_TASK_CODEX.
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "IS_DIFFICULTY_7_PLUS_Q", next: "PLAN_THE_TASK_CODEX" });
});

test("test_main_choosesPlanTheTaskWhenDifficultyIsBelow7", () => {
    // Setup: tasks.json records difficulty 6 for the task.
    const root = makeProjectRoot(2, 6);
    const input = packet(root, 2);
    // Verification: the walk lands on the claude-authored PLAN_THE_TASK block.
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "IS_DIFFICULTY_7_PLUS_Q", next: "PLAN_THE_TASK" });
});

test("test_main_throwsWhenTaskIsNotInTasksJson", () => {
    const root = mkdtempSync(join(tmpdir(), "is-difficulty-7-plus-missing-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools/tasks.json"), "[]");
    const input = packet(root, 9);
    assert.throws(() => main(JSON.stringify(input)), /task 9 not found in tasks\.json/);
});
