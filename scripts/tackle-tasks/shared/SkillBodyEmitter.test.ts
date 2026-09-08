// Behavioral checks for scripts/tackle-tasks/shared/SkillBodyEmitter.ts.  Run: node --test tests/SkillBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { skillBody } from "./SkillBodyEmitter.ts";
import { buildWorkflowScript } from "../generateWorkflow.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../shared/prepareTasks.ts";
import { taskWorkflowDirectory } from "../../shared/taskFiles.ts";

const emitterPath = fileURLToPath(new URL("./SkillBodyEmitter.ts", import.meta.url));
const skillMdPath = fileURLToPath(new URL("../../../skills/tackle-tasks/SKILL.md", import.meta.url));

const temporaryDirectories: string[] = [];
after(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// A real repository standing in for the project, distinct from this plugin checkout.
const makeTargetRepository = (taskNumbers: number[] = [1]): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillBody-target-")));
    temporaryDirectories.push(root, resolveTaskWorktreeConventionDirectory(root));
    const git = (...gitArguments: string[]) => execFileSync("git", ["-C", root, ...gitArguments], { encoding: "utf8" });
    git("init", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    const tasks = taskNumbers.map((taskNumber) => ({ taskNumber, title: `Target task ${taskNumber}`, difficulty: 1 }));
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify(tasks));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify([]));
    git("add", ".taskTools");
    git("commit", "-m", "initial");
    return root;
};

test("test_skillBody_leavesNoUnexpandedPluginRootOrArgumentsPlaceholder", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[74]", makeTargetRepository([74]));

    // Verification: the emitted brief is ready to run, with nothing left for a shell to expand.
    assert.ok(brief.trim().length > 0);
    assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("test_skillBodyEmitter_runsNoSubprocessAndImportsOnlyTheArgumentParser", () => {
    // Setup: the emitter's own source is the boundary under test.
    const source = readFileSync(emitterPath, "utf8");

    // Verification: still no subprocess, and the hook walks the preamble, so nothing of it is imported.
    assert.doesNotMatch(source, /execFileSync|spawn/);
    const relativeImports = [...source.matchAll(/from "\.\/([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(relativeImports.sort(), ["resolveAgentOptions.ts", "resolveTaskRun.ts"]);
});

// The preamble's first box reads the task number and the tasks file.
test("test_skillBody_launchesTheWorkflowWithTheTaskNumberAndTheTasksFile", () => {
    const root = makeTargetRepository([74]);
    const brief = skillBody("[74]", root);

    const workflowLine = brief.split("\n").find((line) => line.startsWith("WORKFLOW 1: "))!;
    const call = JSON.parse(workflowLine.slice("WORKFLOW 1: ".length));
    assert.deepEqual(call.args, { task: 74, tasksFile: join(root, ".taskTools", "tasks.json") });
    assert.match(call.scriptPath, /\.taskTools\/workflows\/74\/workflow\.js$/);
});

// The skill body makes the workflow file fresh, so a stale copy on disk never reaches the agent.
test("test_skillBody_writesTheWorkflowFileFromTheGenerator", () => {
    const root = makeTargetRepository([74]);
    const brief = skillBody("[74]", root);
    const workflowLine = brief.split("\n").find((line) => line.startsWith("WORKFLOW 1: "))!;
    const call = JSON.parse(workflowLine.slice("WORKFLOW 1: ".length));
    const stepsConfigPath = join(taskWorkflowDirectory(join(root, ".taskTools", "tasks.json"), 74), "steps.json");
    assert.equal(readFileSync(call.scriptPath, "utf8"), buildWorkflowScript(74, stepsConfigPath));
});

test("test_skillBody_givesEachTaskNumberItsOwnStepsJsonAndWorkflowFile", () => {
    // Setup: one invocation naming two task numbers.
    const root = makeTargetRepository([3, 5]);
    const brief = skillBody("[3,5]", root);
    // Test action: pull both WORKFLOW calls' scriptPaths.
    const scriptPaths = brief.split("\n")
        .filter((line) => /^WORKFLOW \d+: /.test(line))
        .map((line) => JSON.parse(line.replace(/^WORKFLOW \d+: /, "")).scriptPath as string);
    // Verification: the two tasks never share a workflow file, and each has its own steps.json beside it.
    assert.notEqual(scriptPaths[0], scriptPaths[1]);
    assert.match(scriptPaths[0], /\.taskTools\/workflows\/3\/workflow\.js$/);
    assert.match(scriptPaths[1], /\.taskTools\/workflows\/5\/workflow\.js$/);
    assert.ok(existsSync(join(root, ".taskTools/workflows/3/steps.json")));
    assert.ok(existsSync(join(root, ".taskTools/workflows/5/steps.json")));
});

test("test_skillBody_twoProjectsWithDifferentDiagramsNeverShareAStepsJson", () => {
    // Setup: two separate target repositories. The second declares a custom diagram folder; the first uses the default pipeline.
    const defaultRoot = makeTargetRepository([9]);
    const customRoot = makeTargetRepository([9]);
    const customDiagramFolder = join(customRoot, "diagrams");
    // Custom diagram folders must still supply PREAMBLE_STATUS_CHECK and SECOND_BOX, like generateSteps.test.ts's fixture.
    mkdirSync(customDiagramFolder, { recursive: true });
    writeFileSync(join(customDiagramFolder, "pipeline-preambleStatusCheck.mmd"), "flowchart TD\n    PREAMBLE_STATUS_CHECK --> SECOND_BOX\n");
    const preambleFolder = join(customDiagramFolder, "preambleStatusCheck");
    mkdirSync(preambleFolder, { recursive: true });
    const preambleOutput = { box: "PREAMBLE_STATUS_CHECK", scriptSignal: "continue", note: "", input: "" };
    writeFileSync(join(preambleFolder, "PREAMBLE_STATUS_CHECK.ts"), `console.log(JSON.stringify(${JSON.stringify(preambleOutput)}));\n`);
    writeFileSync(join(preambleFolder, "PREAMBLE_STATUS_CHECK.template.json"), `${JSON.stringify({ input: {}, output: preambleOutput }, null, 4)}\n`);
    const secondBoxFolder = join(customDiagramFolder, "pipeline-preambleStatusCheck");
    mkdirSync(secondBoxFolder, { recursive: true });
    const secondBoxOutput = { box: "SECOND_BOX", scriptSignal: "stop", note: "", input: "" };
    writeFileSync(join(secondBoxFolder, "SECOND_BOX.ts"), `console.log(JSON.stringify(${JSON.stringify(secondBoxOutput)}));\n`);
    writeFileSync(join(secondBoxFolder, "SECOND_BOX.template.json"), `${JSON.stringify({ input: {}, output: secondBoxOutput }, null, 4)}\n`);
    writeFileSync(join(customRoot, ".taskTools/settings.json"), JSON.stringify({ diagramFolder: customDiagramFolder }));

    // Test action: run task 9 in both.
    skillBody("[9]", defaultRoot);
    skillBody("[9]", customRoot);

    // Each project's steps.json holds only its own diagram set, with no leaking between them.
    const defaultConfig = JSON.parse(readFileSync(join(defaultRoot, ".taskTools/workflows/9/steps.json"), "utf8"));
    const customConfig = JSON.parse(readFileSync(join(customRoot, ".taskTools/workflows/9/steps.json"), "utf8"));
    assert.deepEqual(Object.keys(customConfig), ["pipeline-preambleStatusCheck.mmd"]);
    assert.ok(Object.keys(defaultConfig).length > 1);
});

test("test_skillBody_reusesAnActiveTasksExistingPairInsteadOfRegeneratingIt", () => {
    // Setup: task 9 is already marked active, with a pair already on disk from its first launch.
    const root = makeTargetRepository([9]);
    skillBody("[9]", root);
    const workflowPath = join(root, ".taskTools/workflows/9/workflow.js");
    const stepsPath = join(root, ".taskTools/workflows/9/steps.json");
    const tasks = JSON.parse(readFileSync(join(root, ".taskTools/tasks.json"), "utf8"));
    tasks[0].run = { active: true };
    writeFileSync(join(root, ".taskTools/tasks.json"), JSON.stringify(tasks));
    const workflowBefore = readFileSync(workflowPath, "utf8");
    const stepsBefore = readFileSync(stepsPath, "utf8");

    // Test action: a duplicate launch of the same active task.
    skillBody("[9]", root);

    // Verification: neither file changed byte-for-byte.
    assert.equal(readFileSync(workflowPath, "utf8"), workflowBefore);
    assert.equal(readFileSync(stepsPath, "utf8"), stepsBefore);
});

test("test_skillBody_preservesHandAuthoredMutatingFlagsOnATasksFirstGeneration", () => {
    // Setup: a fresh target repository, task 9's first-ever launch.
    const root = makeTargetRepository([9]);
    skillBody("[9]", root);
    // Verification: RECORD_MERGE_COMMIT_HASHES kept its hand-authored mutating flag on task 9's brand-new config.
    const stepsConfig = JSON.parse(readFileSync(join(root, ".taskTools/workflows/9/steps.json"), "utf8"));
    const entry = stepsConfig["pipeline-mergeSucceededExit.mmd"].find((e: { box: string }) => e.box === "RECORD_MERGE_COMMIT_HASHES");
    assert.equal(entry.mutating, true);
});

test("test_ensureTaskWorkflowPair_writesResolvedAgentOptionsIntoTheTaskStepsJson", () => {
    // Setup: task 9 at difficulty 5, a band block.
    const root = makeTargetRepository([9]);
    const tasksPath = join(root, ".taskTools/tasks.json");
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    tasks[0].difficulty = 5;
    writeFileSync(tasksPath, JSON.stringify(tasks));

    skillBody("[9]", root);

    const stepsConfig = JSON.parse(readFileSync(join(root, ".taskTools/workflows/9/steps.json"), "utf8"));
    const findEntry = (box: string) => {
        for (const entries of Object.values(stepsConfig) as { box: string; agent?: unknown }[][]) {
            const found = entries.find((e) => e.box === box);
            if (found) return found;
        }
        throw new Error(`box ${box} not found`);
    };
    assert.deepEqual(findEntry("IMPLEMENT_TASK").agent, { model: "claude-sonnet-5[1m]", effort: "xhigh", agentType: "task-9-implement-task" });
    assert.deepEqual(findEntry("IS_DIFFICULTY_7_PLUS_Q").agent, { model: "sonnet", effort: "high" });
});

test("test_skillBody_passesTheStartingBlockToTheWorkflowArgs", () => {
    // Step: run the emitter with a starting block named after the task list.
    const root = makeTargetRepository([74]);
    const brief = skillBody("[74] IMPLEMENT_TASK", root);

    // Step: pull the WORKFLOW JSON out of the returned text.
    const workflowLine = brief.split("\n").find((line) => line.startsWith("WORKFLOW 1: "))!;
    const call = JSON.parse(workflowLine.slice("WORKFLOW 1: ".length));
    assert.equal(call.args.startingBlock, "IMPLEMENT_TASK");
});

test("test_skillBody_omitsStartingBlockWhenNoneIsGiven", () => {
    // Step: run the emitter with no starting block named.
    const root = makeTargetRepository([74]);
    const brief = skillBody("[74]", root);

    // Step: the starting block key must not be present at all.
    const workflowLine = brief.split("\n").find((line) => line.startsWith("WORKFLOW 1: "))!;
    const call = JSON.parse(workflowLine.slice("WORKFLOW 1: ".length));
    assert.ok(!("startingBlock" in call.args));
});

test("test_skillBody_launchesOneWorkflowPerTaskNumberInTheOrderGiven", () => {
    // Setup: three task numbers, in order.
    const root = makeTargetRepository([3, 5, 8]);
    // Action: run the emitter with all three task numbers.
    const brief = skillBody("[3,5,8]", root);

    // Step: one WORKFLOW line per task number.
    const workflowLines = brief.split("\n").filter((line) => /^WORKFLOW \d+: /.test(line));
    assert.equal(workflowLines.length, 3);

    // Step: each line's JSON carries its task number, in the order given.
    const taskNumbers = workflowLines.map((line) => JSON.parse(line.replace(/^WORKFLOW \d+: /, "")).args.task);
    assert.deepEqual(taskNumbers, [3, 5, 8]);

    // Step: the body launches every workflow in one message.
    assert.match(brief, /execute `Workflow\(WORKFLOW 1\)`, `Workflow\(WORKFLOW 2\)`, `Workflow\(WORKFLOW 3\)` in one message\./);
});

test("test_skillMd_invokesTheSkillBodyEmitterOnAQuotedHeredoc", () => {
    // Setup: the skill body is nothing but the dynamic-injection call.
    const skillMd = readFileSync(skillMdPath, "utf8");

    // Verification: the emitter is called, and $ARGUMENTS arrives on single-quoted-heredoc stdin.
    assert.match(skillMd, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tackle-tasks\/shared\/SkillBodyEmitter\.ts" <<'TACKLETASKSEOF'\n\$ARGUMENTS\nTACKLETASKSEOF/);
});

test("test_skillBody_namesNoDataScript", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[74]", makeTargetRepository([74]));

    // Verification: the main agent never learns of a data script.
    assert.doesNotMatch(brief, /checkBlockers\.ts/);
    assert.doesNotMatch(brief, /getTaskDetails\.ts/);
    assert.doesNotMatch(brief, /prepareTasks\.ts/);
    assert.doesNotMatch(brief, /closeTasks\.ts/);
});

test("test_skillBody_usesNoBootstrapPrepareMode", () => {
    // The plan forbids bootstrap's prepare mode: it takes worktree leases before preflight runs.
    const brief = skillBody("[74]", makeTargetRepository([74]));

    assert.doesNotMatch(brief, /bootstrap/i);
    assert.doesNotMatch(brief, /"mode": *"prepare"/);
});

test("test_skillBodyEmitter_failsLoudlyOnEmptyStdin", () => {
    // A brief built from missing arguments points nowhere, so an empty read must stop the run.
    assert.throws(() => execFileSync("node", [emitterPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});

test("test_skillBody_namesNeitherTheResolverScriptNorItsPathKey", () => {
    // The resolver script is named on the agent side of the boundary, never in the main agent's brief.
    const brief = skillBody("[74]", makeTargetRepository([74]));

    assert.doesNotMatch(brief, /resolveTaskRun\.ts/);
    assert.doesNotMatch(brief, /resolveTaskRunPath/);
});

test("test_skillBody_resetTellsTheAgentToRunNothingBecauseTheHookRanIt", () => {
    // Setup: a target repository with task 2.
    const root = makeTargetRepository([2]);
    // Action: the skill is invoked as `reset 2 LOCK_SOURCE_REPO`.
    const brief = skillBody("reset 2 LOCK_SOURCE_REPO", root);
    // Verification: the body names no command to run and no workflow; the hook already ran the reset.
    assert.doesNotMatch(brief, /node |WORKFLOW/);
    assert.match(brief, /Run nothing/);
});
