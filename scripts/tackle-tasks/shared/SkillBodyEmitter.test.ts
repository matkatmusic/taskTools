// Behavioral checks for scripts/tackle-tasks/SkillBodyEmitter.ts.  Run: node --test tests/SkillBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { skillBody } from "./SkillBodyEmitter.ts";
import { buildWorkflowScript } from "../../generateWorkflow.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../prepareTasks.ts";

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
    const tasks = taskNumbers.map((taskNumber) => ({ taskNumber, title: `Target task ${taskNumber}` }));
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
    assert.deepEqual(relativeImports.sort(), ["resolveTaskRun.ts"]);
});

// The preamble's first box reads the task number and the tasks file.
test("test_skillBody_launchesTheWorkflowWithTheTaskNumberAndTheTasksFile", () => {
    const root = makeTargetRepository([74]);
    const brief = skillBody("[74]", root);

    const workflowLine = brief.split("\n").find((line) => line.startsWith("WORKFLOW: "))!;
    const call = JSON.parse(workflowLine.slice("WORKFLOW: ".length));
    assert.deepEqual(call.args, { task: 74, tasksFile: join(root, ".taskTools", "tasks.json") });
    assert.match(call.scriptPath, /skills\/tackle-tasks\/tackle-tasks\.workflow\.js$/);
});

// The skill body makes the workflow file fresh, so a stale copy on disk never reaches the agent.
test("test_skillBody_writesTheWorkflowFileFromTheGenerator", () => {
    const root = makeTargetRepository([74]);
    const brief = skillBody("[74]", root);
    const workflowLine = brief.split("\n").find((line) => line.startsWith("WORKFLOW: "))!;
    const call = JSON.parse(workflowLine.slice("WORKFLOW: ".length));
    assert.equal(readFileSync(call.scriptPath, "utf8"), buildWorkflowScript());
});

test("test_skillMd_invokesTheSkillBodyEmitterOnAQuotedHeredoc", () => {
    // Setup: the skill body is nothing but the dynamic-injection call.
    const skillMd = readFileSync(skillMdPath, "utf8");

    // Verification: the emitter is called, and $ARGUMENTS arrives on single-quoted-heredoc stdin.
    assert.match(skillMd, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tackle-tasks\/SkillBodyEmitter\.ts" <<'TACKLETASKSEOF'\n\$ARGUMENTS\nTACKLETASKSEOF/);
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
