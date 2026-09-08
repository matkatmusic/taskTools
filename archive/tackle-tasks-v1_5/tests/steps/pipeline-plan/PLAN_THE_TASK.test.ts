import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-plan/PLAN_THE_TASK.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_OUTPUT_TEMPLATE_PATH = join(HERE, "../../../plans/plan-output-template.json");
const PLAN_THE_TASK_TEMPLATE_PATH = join(HERE, "../../../scripts/steps/pipeline-plan/PLAN_THE_TASK.template.json");

// Sets up a project root and worktree with a brief file, since loadPreparedTask is read-only and never creates one.
function makeFixture(taskNumber = 35): { projectRoot: string; worktree: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "plan-the-task-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([
        { taskNumber, files: ["src/thing.ts"], tests: "node --test tests/thing.test.ts", codexReviewNotes: "" },
    ]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    const worktree = join(projectRoot, "worktree");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), `# fixture sentinel brief for task ${taskNumber}\n`);
    return { projectRoot, worktree };
}

test("test_PLAN_THE_TASK_returnsAPromptNamingTheTaskWithNoContinuationInstructions", () => {
    const { projectRoot, worktree } = makeFixture();
    const packet = JSON.stringify({ taskNumber: 35, runId: "run-1", worktree, sourceBranch: "master", projectRoot });

    const output = main(packet);

    assert.equal(output.box, "PLAN_THE_TASK");
    assert.equal(output.scriptSignal, "prompt");
    const promptFile = join(worktree, "plans", "PLAN_THE_TASK.prompt.md");
    assert.equal(output.prompt, `invoke '/read-file "${promptFile}"' and follow the instructions.`);
    const promptFileContents = readFileSync(promptFile, "utf8");
    assert.match(promptFileContents, /task 35/);
    assert.match(promptFileContents, /Codex reviews this plan before it is implemented\./);
});

// Rule D: PLAN_THE_TASK's declared answer shape must never drift from the planner's actual contract file.
test("test_PLAN_THE_TASK_agentAnswerMatchesThePlanOutputTemplateExactly", () => {
    const planOutputTemplate = JSON.parse(readFileSync(PLAN_OUTPUT_TEMPLATE_PATH, "utf8"));
    const blockTemplate = JSON.parse(readFileSync(PLAN_THE_TASK_TEMPLATE_PATH, "utf8"));
    assert.deepEqual(blockTemplate.agentAnswer, planOutputTemplate);
});
