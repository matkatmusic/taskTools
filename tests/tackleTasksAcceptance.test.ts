// Acceptance test: runs tackle-tasks on a real repo, separate from this checkout, through worktree, tests, merge, archive.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { skillBody } from "../scripts/tackle-tasks/shared/SkillBodyEmitter.ts";
import { resolveTaskWorktreeConventionDirectory } from "../scripts/shared/prepareTasks.ts";
import { readSourceRepoLock } from "../scripts/tackle-tasks/shared/sourceRepoLock.ts";
import { readCheckpoint } from "../scripts/tackle-tasks/shared/checkpoint.ts";
import { resolveTaskFiles, seedTaskFilesIfAbsent } from "../scripts/shared/taskFiles.ts";

const RUN_STEP_HOOK_PATH = fileURLToPath(new URL("../scripts/hooks/runStepHook.ts", import.meta.url));
const WRITE_AGENT_ANSWER_PATH = fileURLToPath(new URL("../scripts/tackle-tasks/shared/writeAgentAnswer.ts", import.meta.url));

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

const temporaryDirectories: string[] = [];
after(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// A real git repository standing in for a target project, distinct from this plugin checkout.
function makeFixtureRepository({ taskNumber, files, difficulty, hasTests = false, nameSuffix = "target" }: {
    taskNumber: number;
    files: string[];
    difficulty: number;
    hasTests?: boolean;
    nameSuffix?: string;
}): { root: string; tasksFile: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `tackle-tasks-${nameSuffix}-`)));
    temporaryDirectories.push(root, resolveTaskWorktreeConventionDirectory(root));
    git(root, "init", "-b", "master");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node --test" } }));
    writeFileSync(join(root, "greeting.txt"), "");
    git(root, "add", "package.json", "greeting.txt");
    git(root, "commit", "-m", "initial");
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    const task = {
        taskNumber,
        title: `Target task ${taskNumber}`,
        userDescription: "",
        description: "",
        modifiableFiles: files,
        createsFiles: files,
        readOnlyFiles: ["*"],
        goal: "",
        notInScope: "",
        hasTests,
        difficulty,
        schemaVersion: "1.0.1",
    };
    const tasksFile = join(root, ".taskTools", "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([task]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify([]));
    return { root, tasksFile };
}

function taskWorktreePath(root: string, taskNumber: number): string {
    return join(resolveTaskWorktreeConventionDirectory(root), `task-${taskNumber}`);
}

type ScriptedAnswer = { message: string; additionalData: Record<string, unknown> };
// One entry per expected prompt box, in order; the driver throws on running out or an unlisted box.
type AnswerScript = Record<string, (packetFile: string) => ScriptedAnswer>;

function runHookOnce(box: string, input: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; ran: string[]; outcome: { next: string | null; payload: string; agent?: { model: string; effort: string } } | null; errors: string[] } {
    const command = `/run-step ${box} ${input}`;
    const raw = execFileSync("node", ["--no-inspect", RUN_STEP_HOOK_PATH], {
        cwd: projectRoot,
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "SubagentStart", prompt: command }),
        env,
    });
    const injected = JSON.parse(raw) as { hookSpecificOutput: { additionalContext: string } };
    const firstLine = injected.hookSpecificOutput.additionalContext.split("\n")[0]!;
    return JSON.parse(firstLine);
}

// Drives one full pass exactly like the generated workflow.js's while(true) loop, minus the real agent.
function driveRun(taskNumber: number, tasksFile: string, projectRoot: string, answers: AnswerScript, env: NodeJS.ProcessEnv = process.env): { ok: boolean; errors: string[] } {
    skillBody(`[${taskNumber}]`, projectRoot);
    let box = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
    let input = JSON.stringify({ taskNumber, tasksFile });
    while (true) {
        const result = runHookOnce(box, input, projectRoot, env);
        if (result.outcome === null || result.outcome.next === null) {
            return { ok: result.ok, errors: result.errors };
        }
        const packet = JSON.parse(readFileSync(result.outcome.payload, "utf8")) as Record<string, unknown>;
        if ("prompt" in packet) {
            const stoppedAtBox = result.ran[result.ran.length - 1]!.split("::").pop()!;
            const answerFn = answers[stoppedAtBox];
            if (answerFn === undefined) throw new Error(`no scripted answer for prompt box ${stoppedAtBox}`);
            execFileSync("node", ["--no-inspect", WRITE_AGENT_ANSWER_PATH, result.outcome.payload], { input: JSON.stringify(answerFn(result.outcome.payload)) });
        }
        box = result.outcome.next;
        input = JSON.stringify({ packetFile: result.outcome.payload });
    }
}

test("test_driveRun_dispatchesToTheBoxThatActuallyStoppedNotTheOneThePassStartedAt", async () => {
    // Scenario: task 1 walks from PREAMBLE_STATUS_CHECK through several green preamble boxes before PLAN_THE_TASK prompts.
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 1, files: ["greeting.txt"], difficulty: 1 });
    let sawPlanPrompt = false;
    // The scripted plan answer alone does not resolve the prompt after it (IMPLEMENT_TASK), so the driver throws naming that box — proof it dispatched to the box that actually stopped, not to PREAMBLE_STATUS_CHECK.
    assert.throws(() => driveRun(1, tasksFile, root, {
        PLAN_THE_TASK: () => {
            sawPlanPrompt = true;
            return { message: "stop here", additionalData: { outcome: "PLAN", planFile: "", clarifyRequest: "" } };
        },
    }), /no scripted answer for prompt box IMPLEMENT_TASK/);
    // Verification: the driver found and answered PLAN_THE_TASK, not PREAMBLE_STATUS_CHECK (which never prompts).
    assert.equal(sawPlanPrompt, true);
});

test("test_driveRun_stopsBeforeEveryPromptBlockWithItsAgentOptions", async () => {
    // Scenario: difficulty 5 routes the plan through codex review before IMPLEMENT_TASK, unlike difficulty 1 above.
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 10, files: ["a.txt"], difficulty: 5 });
    const worktreePath = taskWorktreePath(root, 10);
    const answers: AnswerScript = {
        PLAN_THE_TASK: () => {
            const planFile = join(worktreePath, "plans", "plan.json");
            mkdirSync(dirname(planFile), { recursive: true });
            writeFileSync(planFile, JSON.stringify({ sections: [], revision: 0 }));
            return { message: "planned", additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } };
        },
        CODEX_REVIEWS_PLAN: () => {
            const reviewFile = join(worktreePath, "plans", "review.json");
            writeFileSync(reviewFile, JSON.stringify({ outcome: "OK", missingFiles: [], message: "", fixes: [] }));
            return { message: "reviewed", additionalData: { reviewFile, codexSucceeded: true } };
        },
    };
    skillBody("[10]", root);
    let box = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
    let input = JSON.stringify({ taskNumber: 10, tasksFile });
    const outcomes: { next: string | null; agent?: { model: string; effort: string } }[] = [];
    // Stop once every outcome this test cares about has been seen, before an unanswered IMPLEMENT_TASK prompt could throw.
    while (true) {
        const result = runHookOnce(box, input, root);
        if (result.outcome === null || result.outcome.next === null) break;
        outcomes.push(result.outcome);
        if (
            outcomes.some((o) => o.next?.endsWith("::IMPLEMENT_TASK"))
            && outcomes.some((o) => o.next?.endsWith("::CODEX_REVIEWS_PLAN"))
            && outcomes.some((o) => o.next?.endsWith("::COMMIT_IMPLEMENTATION_IF_NEEDED"))
        ) break;
        const packet = JSON.parse(readFileSync(result.outcome.payload, "utf8")) as Record<string, unknown>;
        if ("prompt" in packet) {
            const stoppedAtBox = result.ran[result.ran.length - 1]!.split("::").pop()!;
            const answerFn = answers[stoppedAtBox];
            if (answerFn === undefined) throw new Error(`no scripted answer for prompt box ${stoppedAtBox}`);
            execFileSync("node", ["--no-inspect", WRITE_AGENT_ANSWER_PATH, result.outcome.payload], { input: JSON.stringify(answerFn(result.outcome.payload)) });
        }
        box = result.outcome.next;
        input = JSON.stringify({ packetFile: result.outcome.payload });
    }
    const implementOutcome = outcomes.find((o) => o.next?.endsWith("::IMPLEMENT_TASK"));
    const codexOutcome = outcomes.find((o) => o.next?.endsWith("::CODEX_REVIEWS_PLAN"));
    const commitOutcome = outcomes.find((o) => o.next?.endsWith("::COMMIT_IMPLEMENTATION_IF_NEEDED"));
    assert.deepEqual(implementOutcome?.agent, { model: "claude-sonnet-5[1m]", effort: "xhigh" });
    assert.deepEqual(codexOutcome?.agent, { model: "sonnet", effort: "high" });
    assert.deepEqual(commitOutcome?.agent, { model: "sonnet", effort: "high" });
});

function standardHappyPathAnswers(root: string, taskNumber: number, fileName: string, newContent: string, hasTests: boolean = false): AnswerScript {
    const worktreePath = taskWorktreePath(root, taskNumber);
    return {
        PLAN_THE_TASK: () => {
            const planFile = join(worktreePath, "plans", "plan.json");
            mkdirSync(dirname(planFile), { recursive: true });
            writeFileSync(planFile, JSON.stringify({ sections: [], revision: 0 }));
            return { message: "planned", additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } };
        },
        IMPLEMENT_TASK: () => {
            writeFileSync(join(worktreePath, fileName), newContent);
            const filesToCommit = [fileName];
            if (hasTests) {
                writeFileSync(join(worktreePath, "greeting.test.ts"), [
                    `const { test } = require("node:test");`,
                    `const assert = require("node:assert");`,
                    `const { readFileSync } = require("node:fs");`,
                    `test("greeting file has the expected content", () => {`,
                    `    assert.equal(readFileSync(__dirname + "/${fileName}", "utf8"), ${JSON.stringify(newContent)});`,
                    `});`,
                ].join("\n"));
                filesToCommit.push("greeting.test.ts");
            }
            execFileSync("git", ["-C", worktreePath, "add", ...filesToCommit]);
            execFileSync("git", ["-C", worktreePath, "commit", "-m", "implement"]);
            return { message: "done", additionalData: { implemented: true, notes: "" } };
        },
    };
}

test("test_acceptance_runsAMinimalTaskFromWorktreeCreationThroughStagingMergeAndArchive", async () => {
    // Scenario: a fresh target repository elsewhere on disk, distinct from this plugin checkout.
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 1, files: ["greeting.txt", "greeting.test.ts"], difficulty: 1, hasTests: true });
    // Test action: drive the whole run, answering every prompt box with the minimum valid change.
    const result = driveRun(1, tasksFile, root, standardHappyPathAnswers(root, 1, "greeting.txt", "hello\n", true));
    // Verification: the run reported success and the task moved from open to completed.
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(tasksFile, "utf8")), []);
    const completed = JSON.parse(readFileSync(join(root, ".taskTools/completedTasks.json"), "utf8"));
    assert.deepEqual(completed.map((t: { taskNumber: number }) => t.taskNumber), [1]);
    assert.equal(git(root, "show", "staging:greeting.txt").trim(), "hello");
});

test("test_acceptance_runsFromATargetPathContainingSpaces", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 2, files: ["greeting.txt"], difficulty: 1, nameSuffix: "target with spaces" });
    const result = driveRun(2, tasksFile, root, standardHappyPathAnswers(root, 2, "greeting.txt", "hi\n"));
    assert.equal(result.ok, true);
});

test("test_acceptance_runsInAProjectThatAlreadyHasATaskToolsDirectory", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 3, files: ["greeting.txt"], difficulty: 1 });
    // Step: seed .taskTools before the run, the way an established project already looks (task 12's scenario).
    seedTaskFilesIfAbsent(resolveTaskFiles(root));
    const result = driveRun(3, tasksFile, root, standardHappyPathAnswers(root, 3, "greeting.txt", "hi\n"));
    assert.equal(result.ok, true);
    // Verification: task 12's ignore patterns reached this established project.
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /^\*\*\/plans\/checkpoint\.json$/m);
    assert.match(gitignore, /^\.taskTools\/workflows\/$/m);
});

test("test_acceptance_runsTwoConcurrentTargetRepositoriesWithoutCrossingWires", async () => {
    const first = makeFixtureRepository({ taskNumber: 4, files: ["a.txt"], difficulty: 1 });
    const second = makeFixtureRepository({ taskNumber: 4, files: ["b.txt"], difficulty: 1 });
    const startFile = join(tmpdir(), `tackle-tasks-concurrency-start-${process.pid}`);

    // One process per project; each waits for the same start file, then drives its own task 4 through the same fileName/content pair a real driveRun would, without depending on anything defined in this test's own process.
    const skillBodyEmitterUrl = pathToFileURL(fileURLToPath(new URL("../scripts/tackle-tasks/shared/SkillBodyEmitter.ts", import.meta.url))).href;
    const childSource = (fileName: string, content: string, projectRoot: string, worktreePath: string) => `
        import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
        import { execFileSync } from "node:child_process";
        import { join } from "node:path";
        import { skillBody } from ${JSON.stringify(skillBodyEmitterUrl)};
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(wait, 0, 0, 10);
        skillBody("[4]", ${JSON.stringify(projectRoot)});
        function runHookOnce(box, input) {
            const raw = execFileSync("node", ["--no-inspect", ${JSON.stringify(RUN_STEP_HOOK_PATH)}], {
                cwd: ${JSON.stringify(projectRoot)}, encoding: "utf8",
                input: JSON.stringify({ hook_event_name: "SubagentStart", prompt: \`/run-step \${box} \${input}\` }),
            });
            return JSON.parse(JSON.parse(raw).hookSpecificOutput.additionalContext.split("\\n")[0]);
        }
        const answers = {
            PLAN_THE_TASK: () => {
                const planFile = join(${JSON.stringify(worktreePath)}, "plans", "plan.json");
                mkdirSync(join(${JSON.stringify(worktreePath)}, "plans"), { recursive: true });
                writeFileSync(planFile, JSON.stringify({ sections: [], revision: 0 }));
                return { message: "planned", additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } };
            },
            IMPLEMENT_TASK: () => {
                writeFileSync(join(${JSON.stringify(worktreePath)}, ${JSON.stringify(fileName)}), ${JSON.stringify(content)});
                execFileSync("git", ["-C", ${JSON.stringify(worktreePath)}, "add", ${JSON.stringify(fileName)}]);
                execFileSync("git", ["-C", ${JSON.stringify(worktreePath)}, "commit", "-m", "implement"]);
                return { message: "done", additionalData: { implemented: true, notes: "" } };
            },
        };
        let box = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
        let input = JSON.stringify({ taskNumber: 4, tasksFile: ${JSON.stringify(join(projectRoot, ".taskTools/tasks.json"))} });
        let ok = false;
        while (true) {
            const result = runHookOnce(box, input);
            if (result.outcome === null || result.outcome.next === null) { ok = result.ok; break; }
            const packet = JSON.parse(readFileSync(result.outcome.payload, "utf8"));
            if ("prompt" in packet) {
                const stoppedAtBox = result.ran[result.ran.length - 1].split("::").pop();
                execFileSync("node", ["--no-inspect", ${JSON.stringify(WRITE_AGENT_ANSWER_PATH)}, result.outcome.payload], { input: JSON.stringify(answers[stoppedAtBox]()) });
            }
            box = result.outcome.next;
            input = JSON.stringify({ packetFile: result.outcome.payload });
        }
        writeFileSync(${JSON.stringify(join(projectRoot, "child-result.json"))}, JSON.stringify({ ok }));
    `;

    const children = [
        spawn(process.execPath, ["--input-type=module", "--eval", childSource("a.txt", "one\n", first.root, taskWorktreePath(first.root, 4))]),
        spawn(process.execPath, ["--input-type=module", "--eval", childSource("b.txt", "two\n", second.root, taskWorktreePath(second.root, 4))]),
    ];
    const exits = children.map((child) => once(child, "exit"));
    // Test action: release both children at once, so their hook invocations genuinely overlap.
    writeFileSync(startFile, "go\n");
    for (const [code, signal] of await Promise.all(exits)) {
        assert.equal(signal, null);
        assert.equal(code, 0);
    }

    // Verification: both finished, and each project's own change landed on its own staging — neither crossed into the other.
    assert.equal(JSON.parse(readFileSync(join(first.root, "child-result.json"), "utf8")).ok, true);
    assert.equal(JSON.parse(readFileSync(join(second.root, "child-result.json"), "utf8")).ok, true);
    assert.equal(git(first.root, "show", "staging:a.txt").trim(), "one");
    assert.equal(git(second.root, "show", "staging:b.txt").trim(), "two");
});

test("test_acceptance_reportsAFailureWhenWorktreeCreationCannotWrite", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 5, files: ["a.txt"], difficulty: 1 });
    // Setup: an isolated tmp root for this one test, never the real shared taskTools-wt parent.
    const isolatedTmp = mkdtempSync(join(tmpdir(), "tackle-tasks-worktree-base-"));
    const worktreeParent = join(isolatedTmp, "taskTools-wt");
    mkdirSync(worktreeParent, { recursive: true });
    chmodSync(worktreeParent, 0o444);
    const env = { ...process.env, TMPDIR: isolatedTmp };
    try {
        // Test action: drive the run; it should fail at or before CREATE_WORKTREE, never reach a prompt box.
        const result = driveRun(5, tasksFile, root, {}, env);
        // Verification: a clean failure report, and the task is still open (never silently marked done).
        assert.equal(result.ok, false);
        assert.deepEqual(JSON.parse(readFileSync(tasksFile, "utf8")).map((t: { taskNumber: number }) => t.taskNumber), [5]);
        // Verification: the real shared taskTools-wt parent was never touched by this test.
        assert.notEqual(realpathSync(tmpdir()), realpathSync(isolatedTmp));
    } finally {
        chmodSync(worktreeParent, 0o755);
    }
});

test("test_acceptance_releasesTheSourceLockWhenAFailureHappensWhileItIsHeld", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 6, files: ["a.txt"], difficulty: 1 });
    // Setup: staging now names an all-zero SHA, an invalid object. Every git command resolving "staging" fails the same way — deterministic, and confined to this one fixture repo's own .git.
    writeFileSync(join(root, ".git/refs/heads/staging"), `${"0".repeat(40)}\n`);
    const result = driveRun(6, tasksFile, root, standardHappyPathAnswers(root, 6, "a.txt", "x\n"));
    // Verification: the run failed, and the lock file this task's run held is gone, not orphaned.
    assert.equal(result.ok, false);
    assert.equal(readSourceRepoLock(root), null);
});

test("test_acceptance_resolvesOneConflictThroughTheFixConflictsPrompt", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 7, files: ["a.txt"], difficulty: 1 });
    const worktreePath = taskWorktreePath(root, 7);
    const answers = standardHappyPathAnswers(root, 7, "a.txt", "task change\n");
    // Setup: IMPLEMENT_TASK's own answer additionally advances staging with a conflicting edit to the same file,
    // right after the worktree (already branched from staging's prior tip) has made its own commit — the rebase
    // stage that follows must now hit a real conflict on a.txt.
    const implementAnswer = answers.IMPLEMENT_TASK!;
    answers.IMPLEMENT_TASK = (packetFile) => {
        const answer = implementAnswer(packetFile);
        writeFileSync(join(root, "a.txt"), "staging change\n");
        execFileSync("git", ["-C", root, "checkout", "staging"]);
        execFileSync("git", ["-C", root, "add", "a.txt"]);
        execFileSync("git", ["-C", root, "commit", "-m", "conflicting staging change"]);
        return answer;
    };
    // FIX_CONFLICTS.template.json (task 22): additionalData is {resolved, unresolvedPaths}, checked against live `git diff --name-only --diff-filter=U` by COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED. The resolution itself is a real side effect: pick the task's own change and stage it, the way a real conflict resolution would.
    answers.FIX_CONFLICTS = () => {
        writeFileSync(join(worktreePath, "a.txt"), "task change\n");
        execFileSync("git", ["-C", worktreePath, "add", "a.txt"]);
        return { message: "resolved", additionalData: { resolved: true, unresolvedPaths: [] } };
    };
    const result = driveRun(7, tasksFile, root, answers);
    assert.equal(result.ok, true);
    assert.equal(git(root, "show", "staging:a.txt").trim(), "task change");
});

test("test_acceptance_resumesAfterAnInterruptedCleanup", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 8, files: ["a.txt"], difficulty: 1 });
    const worktreePath = taskWorktreePath(root, 8);
    const answers = standardHappyPathAnswers(root, 8, "a.txt", "x\n");

    // Test action: drive the two prompt hops (PLAN_THE_TASK, IMPLEMENT_TASK) normally, the same way driveRun does.
    skillBody("[8]", root);
    let box = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
    let input = JSON.stringify({ taskNumber: 8, tasksFile });
    let answersWritten = 0;
    while (answersWritten < 2) {
        const result = runHookOnce(box, input, root);
        const packet = JSON.parse(readFileSync(result.outcome!.payload, "utf8")) as Record<string, unknown>;
        if ("prompt" in packet) {
            const stoppedAtBox = result.ran[result.ran.length - 1]!.split("::").pop()!;
            execFileSync("node", ["--no-inspect", WRITE_AGENT_ANSWER_PATH, result.outcome!.payload], { input: JSON.stringify(answers[stoppedAtBox]!(result.outcome!.payload)) });
            answersWritten++;
        }
        box = result.outcome!.next!;
        input = JSON.stringify({ packetFile: result.outcome!.payload });
    }

    // Test action: spawn the final pass as a real child process, so it can be killed mid-flight instead of run to completion.
    const child = spawn("node", ["--no-inspect", RUN_STEP_HOOK_PATH], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(JSON.stringify({ hook_event_name: "SubagentStart", prompt: `/run-step ${box} ${input}` }));
    // Setup: poll the worktree's own checkpoint until the walk reaches CLEAN_UP_WORKTREES, then kill it right there.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (readCheckpoint(worktreePath)?.block === "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES") break;
        await setTimeout(20);
    }
    child.kill("SIGKILL");
    await once(child, "exit");

    // Verification before resume: a checkpoint survives the kill.
    assert.equal(readCheckpoint(worktreePath)?.block, "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES");

    // Test action: relaunch from scratch input; PREAMBLE_STATUS_CHECK's own findResumeEntry (runStepHook.ts lines 296-300) finds the checkpoint and continues from CLEAN_UP_WORKTREES, not from PLAN_THE_TASK again.
    const result = driveRun(8, tasksFile, root, answers);
    assert.equal(result.ok, true);
    assert.equal(readCheckpoint(worktreePath), null); // gone once the run finishes cleanly.
});

test("test_acceptance_packetStillCarriesTaskNsIdentityAfterCrossingRealBlocks", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 9, files: ["a.txt"], difficulty: 1 });
    const answers = standardHappyPathAnswers(root, 9, "a.txt", "x\n");
    // The packet reaching IMPLEMENT_TASK has crossed every block from PREAMBLE_STATUS_CHECK through PLAN_THE_TASK.
    let packetAtImplement: Record<string, unknown> | null = null;
    const implementAnswer = answers.IMPLEMENT_TASK!;
    answers.IMPLEMENT_TASK = (packetFile) => {
        packetAtImplement = JSON.parse(readFileSync(packetFile, "utf8"));
        return implementAnswer(packetFile);
    };
    const result = driveRun(9, tasksFile, root, answers);
    assert.equal(result.ok, true);
    const packet = packetAtImplement!;
    assert.equal(packet.taskNumber, 9);
    assert.equal(packet.worktree, taskWorktreePath(root, 9));
    assert.equal(packet.branch, "task-9");
    assert.equal(typeof packet.runId, "string");
    assert.equal(packet.planFile, join(taskWorktreePath(root, 9), "plans", "plan.json"));
    assert.ok("docsMode" in packet);
});
