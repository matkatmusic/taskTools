// Behavioral checks for scripts/tackle-tasks/SkillBodyEmitter.ts and skills/tackle-tasks/resolve.workflow.js.  Run: node --test tests/tackle-tasks/SkillBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { after } from "node:test";
import { skillBody } from "../../scripts/tackle-tasks/SkillBodyEmitter.ts";
import { acquireSourceRepoLock } from "../../scripts/tackle-tasks/sourceRepoLock.ts";

const emitterPath = fileURLToPath(new URL("../../scripts/tackle-tasks/SkillBodyEmitter.ts", import.meta.url));
const skillMdPath = fileURLToPath(new URL("../../skills/tackle-tasks/SKILL.md", import.meta.url));
const resolveWorkflowPath = fileURLToPath(new URL("../../skills/tackle-tasks/resolve.workflow.js", import.meta.url));

const temporaryDirectories: string[] = [];
after(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// A real repository standing in for the project, distinct from this plugin checkout.
const makeTargetRepository = (taskNumbers: number[] = [1]): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillBody-target-")));
    temporaryDirectories.push(root);
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

// Runs resolve.workflow.js for real, with the harness globals stubbed, and records every agent call.
const runResolveWorkflow = async (
    workflowArguments: Record<string, unknown>,
    agentResults: unknown[],
): Promise<{ result: unknown; prompts: string[]; schemas: unknown[] }> => {
    const prompts: string[] = [];
    const schemas: unknown[] = [];
    const stubAgent = async (prompt: string, options: { schema?: unknown }) => {
        prompts.push(prompt);
        schemas.push(options.schema);
        return agentResults[prompts.length - 1] ?? null;
    };
    const compiled = compileFunction(
        `return (async () => { 'use strict'\n${readFileSync(resolveWorkflowPath, "utf8").replace("export const meta", "const meta")}\n })()`,
        ["args", "log", "agent"],
        { filename: resolveWorkflowPath },
    ) as (a: string, l: (m: string) => void, g: typeof stubAgent) => Promise<unknown>;
    const result = await compiled(JSON.stringify(workflowArguments), () => {}, stubAgent);
    return { result, prompts, schemas };
};

// An emitter run by the main agent leaks its output into the main context.
const namesAnEmitterBashCommand = (body: string): boolean => /node\s+"?[^"\s]*Emitter\.ts/.test(body);

test("test_skillBody_leavesNoUnexpandedPluginRootOrArgumentsPlaceholder", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[74]", makeTargetRepository([74]));

    // Verification: the emitted brief is ready to run, with nothing left for a shell to expand.
    assert.ok(brief.trim().length > 0);
    assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("test_skillBodyEmitter_runsNoSubprocessAndImportsOnlyPreambleChecks", () => {
    // Setup: the emitter's own source is the boundary under test.
    const source = readFileSync(emitterPath, "utf8");

    // Verification: still no subprocess, and only the preamble checks are imported.
    assert.doesNotMatch(source, /execFileSync|spawn/);
    const relativeImports = [...source.matchAll(/from "\.\/([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(relativeImports.sort(), ["PreambleDataEmitter.ts", "WorkflowResultCodes.ts", "resolveTaskRun.ts"]);
});

test("test_skillBody_replacesTheWholeBodyWithOneLineWhenATaskNumberIsInNoTaskStore", () => {
    // Setup: a task number present in neither tasks.json nor completedTasks.json.
    const brief = skillBody("[191]", makeTargetRepository([74]));

    // Verification: nothing to resolve, launch, merge or commit — so none of it is emitted.
    assert.equal(brief, "Say: '191 not found in `.taskTools/tasks.json`'\n");
    assert.doesNotMatch(brief, /Workflow\(/);
    assert.doesNotMatch(brief, /Commit message/);
});

test("test_skillMd_invokesTheSkillBodyEmitterOnAQuotedHeredoc", () => {
    // Setup: the skill body is nothing but the dynamic-injection call.
    const skillMd = readFileSync(skillMdPath, "utf8");

    // Verification: the emitter is called, and $ARGUMENTS arrives on single-quoted-heredoc stdin.
    assert.match(skillMd, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tackle-tasks\/SkillBodyEmitter\.ts" <<'TACKLETASKSEOF'\n\$ARGUMENTS\nTACKLETASKSEOF/);
});

test("test_skillBody_namesNoDataScriptAndNoTaskFile", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[74]", makeTargetRepository([74]));

    // Verification: the main agent never learns of a data script or a task file.
    assert.doesNotMatch(brief, /checkBlockers\.ts/);
    assert.doesNotMatch(brief, /getTaskDetails\.ts/);
    assert.doesNotMatch(brief, /prepareTasks\.ts/);
    assert.doesNotMatch(brief, /closeTasks\.ts/);
    assert.doesNotMatch(brief, /tasks\.json/);
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

test("test_resolveWorkflow_namesTheResolverScriptOnlyInsideTheAgentPromptAndReturnsItsResult", async () => {
    // Setup: a resolver result the workflow must pass through untouched.
    const resolved = { taskNumbers: [1, 2], projectRoot: "/abs/repo", sourceBranch: "master", runId: "abc" };

    // Test action: run the real workflow with a stub agent.
    const run = await runResolveWorkflow({ argsValue: "[1,2]", scriptsDir: "/abs/scripts/tackle-tasks" }, [resolved]);

    // Verification: the script is named in the prompt, the schema is enforced, the result passes through.
    assert.equal(run.prompts.length, 1);
    assert.match(run.prompts[0], /node "\/abs\/scripts\/tackle-tasks\/resolveTaskRun\.ts" <<'RESOLVE_PAYLOAD'/);
    assert.match(run.prompts[0], /\{"args":"\[1,2\]"\}/);
    assert.deepEqual((run.schemas[0] as { required: string[] }).required, [
        "taskNumbers", "projectRoot", "sourceBranch", "runId",
    ]);
    assert.deepEqual(run.result, resolved);
});

test("test_resolveWorkflow_respawnsTheReadOnlyResolverUpToThreeTimes", async () => {
    // Setup: the harness loses the first two results, then returns one.
    const resolved = { taskNumbers: [1], projectRoot: "/abs/repo", sourceBranch: "master", runId: "abc" };

    // Test action: two lost spawns followed by a real answer.
    const run = await runResolveWorkflow({ argsValue: "[1]", scriptsDir: "/abs/scripts" }, [null, null, resolved]);

    // Verification: three attempts, and the third answer wins.
    assert.equal(run.prompts.length, 3);
    assert.deepEqual(run.result, resolved);
});

test("test_resolveWorkflow_failsAfterThreeLostSpawns", async () => {
    // A fourth silent attempt would hide a broken resolver, so the workflow must stop instead.
    await assert.rejects(
        () => runResolveWorkflow({ argsValue: "[1]", scriptsDir: "/abs/scripts" }, []),
        /no result after 3 attempts/,
    );
});

test("test_resolveWorkflow_runsTheResolverInsideAnAgentUnderAPureLiteralMeta", () => {
    // Setup: the resolver workflow source.
    const source = readFileSync(resolveWorkflowPath, "utf8");
    const metaLiteral = source.slice(0, source.indexOf("\n}\n") + 3);

    // Verification: meta comes first and interpolates nothing; the script itself runs only inside agent().
    assert.ok(source.startsWith("export const meta = {"));
    assert.doesNotMatch(metaLiteral, /\$\{/);
    assert.doesNotMatch(source, /\brequire\(|^import\b|\bprocess\./m);
    assert.match(source, /agent\(/);
    assert.match(source, /RESOLVE_PAYLOAD/);
});
