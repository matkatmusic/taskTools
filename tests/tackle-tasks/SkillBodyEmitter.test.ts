// Behavioral checks for scripts/tackle-tasks/SkillBodyEmitter.ts and skills/tackle-tasks/resolve.workflow.js.
// Run: node --test tests/tackle-tasks/SkillBodyEmitter.test.ts
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

// A real repository standing in for the project the skill is invoked on, distinct from this
// plugin checkout, so a project-root bug cannot hide behind the two paths being the same.
const makeTargetRepository = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillBody-target-")));
    temporaryDirectories.push(root);
    const git = (...gitArguments: string[]) => execFileSync("git", ["-C", root, ...gitArguments], { encoding: "utf8" });
    git("init", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "tasks.json"), JSON.stringify({ tasks: [] }));
    git("add", "tasks.json");
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

// A main agent told to run any emitter with Bash keeps that output in the main context,
// which is the leak the whole chain exists to prevent.
const namesAnEmitterBashCommand = (body: string): boolean => /node\s+"?[^"\s]*Emitter\.ts/.test(body);

test("test_skillBody_leavesNoUnexpandedPluginRootOrArgumentsPlaceholder", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[169]");

    // Verification: the emitted brief is ready to run, with nothing left for a shell to expand.
    assert.ok(brief.trim().length > 0);
    assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("test_skillBodyEmitter_importsOnlyNodeFsAndNodeUrlAndRunsNoSubprocess", () => {
    // Setup: the emitter's own source is the boundary under test.
    const source = readFileSync(emitterPath, "utf8");

    // Verification: no subprocess, no relative import — paths and prose only.
    assert.doesNotMatch(source, /execFileSync|spawn|from "\./);
});

test("test_skillMd_invokesTheSkillBodyEmitterOnAQuotedHeredoc", () => {
    // Setup: the skill body is nothing but the dynamic-injection call.
    const skillMd = readFileSync(skillMdPath, "utf8");

    // Verification: the emitter is called, and $ARGUMENTS arrives on single-quoted-heredoc stdin.
    assert.match(skillMd, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tackle-tasks\/SkillBodyEmitter\.ts" <<'TACKLETASKSEOF'\n\$ARGUMENTS\nTACKLETASKSEOF/);
});

test("test_skillBody_namesNoDataScriptAndNoTaskFile", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75]");

    // Verification: the main agent never learns of a data script or a task file.
    assert.doesNotMatch(brief, /checkBlockers\.ts/);
    assert.doesNotMatch(brief, /getTaskDetails\.ts/);
    assert.doesNotMatch(brief, /prepareTasks\.ts/);
    assert.doesNotMatch(brief, /closeTasks\.ts/);
    assert.doesNotMatch(brief, /tasks\.json/);
});

test("test_skillBody_usesNoBootstrapPrepareMode", () => {
    // The plan forbids bootstrap's prepare mode: it takes worktree leases before preflight runs.
    const brief = skillBody("[75]");

    assert.doesNotMatch(brief, /bootstrap/i);
    assert.doesNotMatch(brief, /"mode": *"prepare"/);
});

test("test_skillBody_emitsTheResolverWorkflowPath", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75]");

    // Verification: the resolver runs as a workflow, carrying the arguments as an argument value.
    assert.ok(brief.includes(resolveWorkflowPath), "the resolver workflow path must appear in the brief");
    assert.match(brief, /Workflow\(\{"scriptPath": *"[^"]*resolve\.workflow\.js", *"args": *\{/);
    assert.match(brief, /"argsValue": *"\[75\]"/);
});

test("test_skillBody_emitsOneWorkflowLaunchPerTaskNumber", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75,76]");

    // Test action: count the task-workflow launch templates in the brief.
    const launchTemplates = brief.split("tackle-tasks.workflow.js").length - 1;

    // Verification: exactly one template, applied once per entry of taskNumbers, never batched.
    assert.equal(launchTemplates, 1);
    assert.match(brief, /for every task number in `taskNumbers`/);
    assert.match(brief, /"task": <task number>/);
    assert.match(brief, /never batch/i);
});

test("test_skillBody_tellsTheAgentTasksMayRunConcurrentlyBehindTheSourceRepositoryLock", () => {
    // Nobody may reintroduce a merge queue: the source-repository lock is what serializes the tails.
    const brief = skillBody("[75,76]");

    assert.match(brief, /concurrent/i);
    assert.match(brief, /source-repository lock/);
    assert.match(brief, /merge queue/);
});

test("test_skillBody_reportsEachRunsExitTypeAndExitNote", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75]");

    // Verification: the report format names the two fields the workflow returns.
    assert.match(brief, /\{task, exitType, exitNote, chainRan\}/);
    assert.match(brief, /Task <task>: <exitType>/);
});

test("test_skillBody_survivesArgumentsContainingQuotesAndNewlines", () => {
    // Setup: arguments a naive JSON interpolation would corrupt.
    const argsValue = '[75] valid "quoted" back\\slash\nsecond line';

    // Test action: the workflow declaration is built with JSON.stringify, not string interpolation.
    const brief = skillBody(argsValue);
    const declaration = brief.slice(brief.indexOf("{"), brief.indexOf("})") + 1);
    const parsed = JSON.parse(declaration) as { args: { argsValue: string } };

    // Verification: the arguments survive byte for byte.
    assert.equal(parsed.args.argsValue, argsValue);
});

test("test_skillBodyEmitter_failsLoudlyOnEmptyStdin", () => {
    // A brief built from missing arguments points nowhere, so an empty read must stop the run.
    assert.throws(() => execFileSync("node", [emitterPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});

test("test_skillBodyEmitter_printsTheBriefWithoutReadingAnyTaskState", () => {
    // Setup: run the real command the way SKILL.md runs it, from an unrelated working directory.
    const printed = execFileSync("node", [emitterPath], { input: "[169] valid\n", encoding: "utf8", cwd: "/tmp" });

    // Verification: it returns a brief instantly, naming no task file it would have had to read.
    assert.ok(printed.includes(resolveWorkflowPath));
    assert.doesNotMatch(printed, /tasks\.json/);
});

test("test_skillBody_namesNeitherTheResolverScriptNorItsPathKey", () => {
    // The resolver script is named on the agent side of the boundary, never in the main agent's brief.
    const brief = skillBody("[75]");

    assert.doesNotMatch(brief, /resolveTaskRun\.ts/);
    assert.doesNotMatch(brief, /resolveTaskRunPath/);
});

test("test_skillBodyEmitter_resolvesTheRepositoryTopLevelWhenInvokedFromANestedDirectory", () => {
    // Setup: a target repository with a nested directory, distinct from this plugin checkout.
    const targetRepository = makeTargetRepository();
    const nestedDirectory = join(targetRepository, "scripts", "deeper");
    mkdirSync(nestedDirectory, { recursive: true });

    // Test action: run the real emitter, then the resolver boundary, both from the nested directory.
    const brief = execFileSync("node", [emitterPath], { input: "[1]\n", encoding: "utf8", cwd: nestedDirectory });
    const resolverPayload = JSON.parse(
        brief.slice(brief.indexOf("{"), brief.indexOf("})") + 1),
    ) as { args: { scriptsDir: string; projectRoot?: string } };
    const resolved = JSON.parse(execFileSync(
        "node",
        [join(resolverPayload.args.scriptsDir, "resolveTaskRun.ts")],
        { input: JSON.stringify({ args: "[1]" }), encoding: "utf8", cwd: nestedDirectory },
    )) as { projectRoot: string; taskNumbers: number[] };

    // Verification: the brief carries no project root at all, and the resolver reports the top level,
    // so the source lock lands in the repository's real .git rather than in the nested directory.
    assert.equal(resolverPayload.args.projectRoot, undefined);
    assert.notEqual(resolverPayload.args.scriptsDir, join(targetRepository, "scripts"));
    assert.equal(resolved.projectRoot, targetRepository);
    assert.deepEqual(resolved.taskNumbers, [1]);
    assert.deepEqual(acquireSourceRepoLock(resolved.projectRoot, "run-1:1"), { status: "acquired" });
    assert.equal(existsSync(join(targetRepository, ".git", "taskTools-source.lock")), true);
    assert.equal(existsSync(join(nestedDirectory, ".git")), false);
});

test("test_skillBody_declaresAWorkflowRatherThanAMainAgentEmitterCommand", () => {
    // Setup: the real brief, plus a negative fixture for the forbidden
    // SkillBodyEmitter -> main-agent Bash -> AnotherEmitter chain.
    const brief = skillBody("[75]");
    const forbiddenChain = 'Run `node "/abs/scripts/tackle-tasks/AgentPromptEmitter.ts" 75 plan` with Bash.';

    // Verification: the checker catches the forbidden chain, and the real brief does not trip it.
    assert.equal(namesAnEmitterBashCommand(forbiddenChain), true);
    assert.equal(namesAnEmitterBashCommand(brief), false);
    assert.match(brief, /Workflow\(\{"scriptPath"/);
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
