// Behavioral checks for scripts/tackle-tasks/SkillBodyEmitter.ts and skills/tackle-tasks/resolve.workflow.js.
// Run: node --test tests/tackle-tasks/SkillBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { skillBody } from "../../scripts/tackle-tasks/SkillBodyEmitter.ts";

const emitterPath = fileURLToPath(new URL("../../scripts/tackle-tasks/SkillBodyEmitter.ts", import.meta.url));
const skillMdPath = fileURLToPath(new URL("../../skills/tackle-tasks/SKILL.md", import.meta.url));
const resolveWorkflowPath = fileURLToPath(new URL("../../skills/tackle-tasks/resolve.workflow.js", import.meta.url));

// A main agent told to run any emitter with Bash keeps that output in the main context,
// which is the leak the whole chain exists to prevent.
const namesAnEmitterBashCommand = (body: string): boolean => /node\s+"?[^"\s]*Emitter\.ts/.test(body);

test("test_skillBody_leavesNoUnexpandedPluginRootOrArgumentsPlaceholder", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[169]", "/abs/project");

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
    const brief = skillBody("[75]", "/abs/project");

    // Verification: the main agent never learns of a data script or a task file.
    assert.doesNotMatch(brief, /checkBlockers\.ts/);
    assert.doesNotMatch(brief, /getTaskDetails\.ts/);
    assert.doesNotMatch(brief, /prepareTasks\.ts/);
    assert.doesNotMatch(brief, /closeTasks\.ts/);
    assert.doesNotMatch(brief, /tasks\.json/);
});

test("test_skillBody_usesNoBootstrapPrepareMode", () => {
    // The plan forbids bootstrap's prepare mode: it takes worktree leases before preflight runs.
    const brief = skillBody("[75]", "/abs/project");

    assert.doesNotMatch(brief, /bootstrap/i);
    assert.doesNotMatch(brief, /"mode": *"prepare"/);
});

test("test_skillBody_emitsTheResolverWorkflowPath", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75]", "/abs/project");

    // Verification: the resolver runs as a workflow, carrying the arguments as an argument value.
    assert.ok(brief.includes(resolveWorkflowPath), "the resolver workflow path must appear in the brief");
    assert.match(brief, /Workflow\(\{"scriptPath": *"[^"]*resolve\.workflow\.js", *"args": *\{/);
    assert.match(brief, /"argsValue": *"\[75\]"/);
});

test("test_skillBody_emitsOneWorkflowLaunchPerTaskNumber", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75,76]", "/abs/project");

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
    const brief = skillBody("[75,76]", "/abs/project");

    assert.match(brief, /concurrent/i);
    assert.match(brief, /source-repository lock/);
    assert.match(brief, /merge queue/);
});

test("test_skillBody_reportsEachRunsExitTypeAndExitNote", () => {
    // Setup: a normal invocation.
    const brief = skillBody("[75]", "/abs/project");

    // Verification: the report format names the two fields the workflow returns.
    assert.match(brief, /\{task, exitType, exitNote, chainRan\}/);
    assert.match(brief, /Task <task>: <exitType>/);
});

test("test_skillBody_survivesArgumentsContainingQuotesAndNewlines", () => {
    // Setup: arguments a naive JSON interpolation would corrupt.
    const argsValue = '[75] valid "quoted" back\\slash\nsecond line';

    // Test action: the workflow declaration is built with JSON.stringify, not string interpolation.
    const brief = skillBody(argsValue, "/abs/project");
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

test("test_skillBodyEmitter_takesProjectRootFromTheWorkingDirectoryNotTheInstalledPluginDirectory", () => {
    // Setup: an installed plugin lives outside the project it works on, so the two paths differ.
    const printed = execFileSync("node", [emitterPath], { input: "[169]\n", encoding: "utf8", cwd: "/tmp" });

    // Verification: the resolver is told to work on the invoking project, not on this checkout.
    const declaration = printed.slice(printed.indexOf("{"), printed.indexOf("})") + 1);
    const parsed = JSON.parse(declaration) as { args: { projectRoot: string } };
    assert.equal(parsed.args.projectRoot, realpathSync("/tmp"));
});

test("test_skillBody_declaresAWorkflowRatherThanAMainAgentEmitterCommand", () => {
    // Setup: the real brief, plus a negative fixture for the forbidden
    // SkillBodyEmitter -> main-agent Bash -> AnotherEmitter chain.
    const brief = skillBody("[75]", "/abs/project");
    const forbiddenChain = 'Run `node "/abs/scripts/tackle-tasks/AgentPromptEmitter.ts" 75 plan` with Bash.';

    // Verification: the checker catches the forbidden chain, and the real brief does not trip it.
    assert.equal(namesAnEmitterBashCommand(forbiddenChain), true);
    assert.equal(namesAnEmitterBashCommand(brief), false);
    assert.match(brief, /Workflow\(\{"scriptPath"/);
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
