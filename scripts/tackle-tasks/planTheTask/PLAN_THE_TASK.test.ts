import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./PLAN_THE_TASK.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "plan-the-task-run-log.json");

const HERE = dirname(fileURLToPath(import.meta.url));

// Sets up a project root and worktree with a brief file, since loadPreparedTask is read-only and never creates one.
function makeFixture(taskNumber = 35, difficulty?: number): { projectRoot: string; worktree: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "plan-the-task-"));
    mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(projectRoot, ".taskTools/tasks.json"), JSON.stringify([
        { taskNumber, files: ["src/thing.ts"], tests: "node --test tests/thing.test.ts", codexReviewNotes: "", difficulty },
    ]));
    writeFileSync(join(projectRoot, ".taskTools/completedTasks.json"), "[]");
    const worktree = join(projectRoot, "worktree");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), `# fixture sentinel brief for task ${taskNumber}\n`);
    return { projectRoot, worktree };
}

test("test_PLAN_THE_TASK_returnsAPromptNamingTheTaskWithNoContinuationInstructions", () => {
    const { projectRoot, worktree } = makeFixture();
    const packet = JSON.stringify({
        box: "DOCUMENT_GENERATION", scriptSignal: "continue", taskNumber: 35, runId: "run-1",
        projectRoot, worktree, branch: "task-35", docsMode: "AUTOGEN", planFile: "", exitType: "", exitNote: "",
    });

    const output = main(packet);

    assert.equal(output.box, "PLAN_THE_TASK");
    assert.equal(output.scriptSignal, "prompt");
    const promptFile = join(worktree, "plans", "PLAN_THE_TASK.prompt.md");
    assert.equal(output.prompt, `invoke '/read-file "${promptFile}"' and follow the instructions.`);
    assert.doesNotMatch(String(output.prompt), /\/run-step|invoke the skill/i);
    const promptFileContents = readFileSync(promptFile, "utf8");
    assert.match(promptFileContents, /task 35/);
    assert.match(promptFileContents, /Codex reviews this plan before it is implemented\./);
});

test("test_PLAN_THE_TASK_spawnsCodexToDraftThePlanWhenDifficultyIsAtLeast7", () => {
    const { projectRoot, worktree } = makeFixture(35, 7);
    const packet = JSON.stringify({
        box: "DOCUMENT_GENERATION", scriptSignal: "continue", taskNumber: 35, runId: "run-1",
        projectRoot, worktree, branch: "task-35", docsMode: "AUTOGEN", planFile: "", exitType: "", exitNote: "",
    });

    main(packet);

    // Codex outruns one Bash() call: the script holds the command, the prompt starts and polls it.
    const promptFile = join(worktree, "plans", "PLAN_THE_TASK.prompt.md");
    const runScript = join(worktree, "plans", "PLAN_THE_TASK.codex-run.sh");
    const doneFile = join(worktree, "plans", "PLAN_THE_TASK.codex-done");
    const promptFileContents = readFileSync(promptFile, "utf8");
    assert.match(promptFileContents, /You are spawning a plan agent running in the CLI\./);
    // macOS has no setsid; a plain nohup job outlives the Bash() call that started it.
    assert.ok(promptFileContents.includes(`nohup sh ${runScript} >/dev/null 2>&1 </dev/null &`));
    assert.doesNotMatch(promptFileContents, /setsid/);
    assert.ok(promptFileContents.includes(`[ -f ${doneFile} ]`));
    assert.doesNotMatch(promptFileContents, /codex exec/);
    const runScriptContents = readFileSync(runScript, "utf8");
    assert.match(runScriptContents, /codex exec -s workspace-write -m gpt-5\.6-terra -c 'model_reasoning_effort="high"'/);
    assert.ok(runScriptContents.includes(`echo $? >${doneFile}`));
    // macOS sh chokes on a heredoc inside $(...) holding an apostrophe, so the prompt is a file.
    const codexPromptFile = join(worktree, "plans", "PLAN_THE_TASK.codex-prompt.md");
    assert.ok(runScriptContents.includes(`"$(cat ${codexPromptFile})"`));
    assert.doesNotMatch(runScriptContents, /PLANEOF/);
    assert.match(readFileSync(codexPromptFile, "utf8"), /task 35/);
    execFileSync("sh", ["-n", runScript]);
});

test("test_PLAN_THE_TASK_runsTwiceWithTheSameInput", () => {
    const { projectRoot, worktree } = makeFixture();
    const input = JSON.stringify({
        box: "DOCUMENT_GENERATION", scriptSignal: "continue", taskNumber: 35, runId: "run-1",
        projectRoot, worktree, branch: "task-35", docsMode: "AUTOGEN", planFile: "", exitType: "", exitNote: "",
    });
    const promptFile = join(worktree, "plans", "PLAN_THE_TASK.prompt.md");

    const firstOutput = main(input);
    const firstPrompt = readFileSync(promptFile, "utf8");
    const secondOutput = main(input);
    const secondPrompt = readFileSync(promptFile, "utf8");

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(secondPrompt, firstPrompt);
});
