# Task 26 plan — acceptance test: run tackle-tasks end to end from a separate target repository

Depends on tasks 10, 12, 22, 23 by number only (their own plans/implementations own those changes). This task adds no production code; it is acceptance-test-only, matching its own description ("Build one test..."). Every unit test written by tasks 10/12/22/23 mocks paths or runs from this plugin checkout — this is the one test that does not, and it is what the audit calls "the proof that the skill works outside this repo."

## Scope confirmation

- New file: `tests/tackleTasksAcceptance.test.ts`. Does not exist yet.
- `scripts/runStepHook.ts` (read in full for this plan; not edited by this task) — the driver below re-implements, in the test file, exactly the loop the generated `workflow.js` runs (`scripts/generateWorkflow.ts` lines 61–99, read in full): call the hook, and whenever it returns `outcome.next !== null` the hook stopped at a prompt box (confirmed: `buildSuccess`, `scripts/runStepHook.ts` lines 252–263, sets `next = null` whenever `scriptSignal === SCRIPT_SIGNAL.STOP`, and every other continuation is walked internally inside `walkFromStep`'s `while (true)` loop, lines 306–430 — so a `next !== null` return is only ever a `SCRIPT_SIGNAL.PROMPT` stop).
- `scripts/tackle-tasks/shared/writeAgentAnswer.ts` (read in full) — `writeAgentAnswer(packetFile, answerJson)` requires `answerJson` to parse to an object with a string `message` and a plain-object `additionalData`; it merges those two fields into the packet file at `packetFile` and nothing else. The driver's scripted "agent" calls this for every prompt box.
- `scripts/tackle-tasks/shared/sourceRepoLock.ts` line 37: `return join(sourceRepoGitDir(projectRoot), "taskTools-source.lock");` — the exact lock file path the "failure while the source lock is held" case reads to confirm release.
- `scripts/tackle-tasks/shared/checkpoint.ts` lines 18–20: `checkpointPath(worktree)` returns `join(worktree, "plans", "checkpoint.json")` — the file the "interrupted cleanup followed by resume" case reads to confirm a checkpoint exists after a kill, and confirms gone after a clean finish.
- `scripts/prepareTasks.ts` lines 377–381, `resolveTaskWorktreeConventionDirectory(repoRoot)`: `join(tmpdir(), "taskTools-wt", \`${basename(repoRoot)}-${hash}\`)` where `hash` is a sha256 of `realpathSync(repoRoot)`. The worktree lives outside the fixture repo entirely, in the OS temp directory — the "injected failure before worktree creation" case chmods this path's parent, not anything inside the fixture repo.
- `scripts/tackle-tasks/shared/SkillBodyEmitter.test.ts`'s `makeTargetRepository` helper (lines 22–37, read in full) is the existing pattern for "a real git repository standing in for a project, distinct from this plugin checkout" — this task's fixture builder follows the same shape (real `git init`, real commit, real `.taskTools/tasks.json`) but adds a real task record with `modifiableFiles`/`goal`/`hasTests` etc. (schema confirmed live via `.taskTools/tasks.json`'s task 194 record read above) instead of the bare `{taskNumber, title}` stub that helper uses, because this task must run the task through real planning/implementation/test stubs, not just reach `PREAMBLE_STATUS_CHECK`.
- Found during research, out of this task's scope but recorded so it is not silently missed: `scripts/tackle-tasks/resetTask.ts` line 22 reads the **plugin's own** `scripts/steps.json` (`fileURLToPath(new URL("../steps.json", import.meta.url))`), and line 32 resolves `tasksFile` via `execSync("git rev-parse --show-toplevel")` joined with `.taskTools/tasks.json`, never via `resolveTaskFiles`. Neither the acceptance scenarios below nor the natural resume path (`findResumeEntry`, `scripts/runStepHook.ts` lines 296–300) invoke `resetTask.ts` — resume here happens by re-invoking `PREAMBLE_STATUS_CHECK` with the same `{taskNumber, tasksFile}` packet after a kill, which finds the checkpoint on its own. `resetTask.ts` is only reached through the explicit `/tackle-tasks reset N BLOCK` command (`scripts/runStepHook.ts` lines 443–448), which this plan's scenarios do not use. Confirm this stays true before implementing; if a later design change routes automatic resume through `resetTask.ts`, its plugin-relative config path needs its own fix first.

## Steps

### Step 1 — the driver: run a real hook loop, answering prompts with scripted stubs

This is test infrastructure, not itself a behavior under test; there is no red/green cycle for it in isolation; its correctness is proven by Step 2's baseline scenario passing.

Add to `tests/tackleTasksAcceptance.test.ts`:

```ts
type ScriptedAnswer = { message: string; additionalData: Record<string, unknown> };
// One entry per prompt box this scenario expects to hit, in the order they occur; the driver throws if it runs out or hits an unlisted box.
type AnswerScript = Record<string, () => ScriptedAnswer>;

function runHookOnce(box: string, input: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; ran: string[]; outcome: { next: string | null; payload: string } | null; errors: string[] } {
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
// skillBody is called first because it — not this driver — is what generates .taskTools/workflows/<N>/{steps.json,workflow.js}
// (scripts/tackle-tasks/shared/SkillBodyEmitter.ts, read in full for plan 10): a real invocation goes SKILL.md ->
// skillBody() -> the generated workflow.js -> /run-step. Skipping skillBody would leave runStepHook.ts with no
// per-task config to read at all. `env` defaults to this process's own — a scenario that needs an isolated
// TMPDIR (Step 6) passes its own override, which flows into every hook invocation this run makes.
function driveRun(taskNumber: number, tasksFile: string, projectRoot: string, answers: AnswerScript, env: NodeJS.ProcessEnv = process.env): { ok: boolean; errors: string[] } {
    skillBody(`[${taskNumber}]`, projectRoot);
    let box = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
    let input = JSON.stringify({ taskNumber, tasksFile });
    while (true) {
        const result = runHookOnce(box, input, projectRoot, env);
        if (result.outcome === null || result.outcome.next === null) {
            return { ok: result.ok, errors: result.errors };
        }
        // The hook can walk through many green blocks before stopping at a prompt — `box` names where this pass
        // STARTED, not where it stopped. `result.ran`'s last entry is the block that actually produced the prompt
        // (runStepHook.ts pushes onto `boxesRun` before checking scriptSignal, so the last entry is always that box),
        // and its packet file is literally named `${output.box}-${pid}.json` (runStepHook.ts line 257) — same source.
        const stoppedAtBox = result.ran[result.ran.length - 1]!.split("::").pop()!;
        const answerFn = answers[stoppedAtBox];
        if (answerFn === undefined) throw new Error(`no scripted answer for prompt box ${stoppedAtBox}`);
        execFileSync("node", ["--no-inspect", WRITE_AGENT_ANSWER_PATH, result.outcome.payload], { input: JSON.stringify(answerFn()) });
        box = result.outcome.next;
        input = JSON.stringify({ packetFile: result.outcome.payload });
    }
}
```

`RUN_STEP_HOOK_PATH` and `WRITE_AGENT_ANSWER_PATH` are `fileURLToPath` constants pointing at this plugin checkout's own `scripts/runStepHook.ts` and `scripts/tackle-tasks/shared/writeAgentAnswer.ts` (this repo, not the fixture repo — the hook is invoked with `cwd: projectRoot` set to the fixture, matching how `hooks.json`'s `${CLAUDE_PLUGIN_ROOT}`-rooted command runs against whatever project the agent is working in). `skillBody` is imported directly from `scripts/tackle-tasks/shared/SkillBodyEmitter.ts` and called in-process (it does not spawn anything itself, confirmed by `test_skillBodyEmitter_runsNoSubprocessAndImportsOnlyTheArgumentParser` in its own test file).

A driver-level test, before any acceptance scenario uses it, proves `stoppedAtBox` is read correctly across several green hops:

```ts
test("test_driveRun_dispatchesToTheBoxThatActuallyStoppedNotTheOneThePassStartedAt", async () => {
    // Scenario: task 1 walks from PREAMBLE_STATUS_CHECK through several green preamble boxes before PLAN_THE_TASK prompts.
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 1, files: ["greeting.txt"], difficulty: 1 });
    let sawPlanPrompt = false;
    const result = driveRun(1, tasksFile, root, {
        PLAN_THE_TASK: () => {
            sawPlanPrompt = true;
            return { message: "stop here", additionalData: { outcome: "PLAN", planFile: "", clarifyRequest: "" } };
        },
    });
    // Verification: the driver found and answered PLAN_THE_TASK, not PREAMBLE_STATUS_CHECK (which never prompts).
    assert.equal(sawPlanPrompt, true);
    // The scripted plan answer alone does not resolve the review prompt after it, so the run itself is expected to fail here.
    assert.equal(result.ok, false);
});
```

This fails today: `box.split("::").pop()` on the pass that started at `PREAMBLE_STATUS_CHECK` looks up `answers.PREAMBLE_STATUS_CHECK`, which is undefined, so the driver throws before it ever reaches `PLAN_THE_TASK`.

Each scenario's `answers` object supplies one closure per prompt box it actually reaches. Before writing a closure, read that box's own `steps/<BOX>.template.json` `output` shape and the block's own script (`scripts/tackle-tasks/<diagram>/<BOX>.ts` or its `pipeline-<diagram>.mmd` neighbor) to know what `additionalData` fields it requires.

### Step 2 — baseline: a minimal task runs end to end and gets archived

The exact prompt boxes a run visits are not fixed — they branch on the task's own `difficulty`. Read live: `scripts/tackle-tasks/whatDidThePlannerReturn/WHAT_DID_THE_PLANNER_RETURN.ts` routes straight to `pipeline-implementTask.mmd::IMPLEMENT_TASK` when `Number(entry.difficulty) <= 3`, skipping `CODEX_REVIEWS_PLAN` entirely; otherwise it goes to `pipeline-codexReviewsPlan.mmd::CODEX_REVIEWS_PLAN` first. Symmetrically, `scripts/tackle-tasks/commitImplementationIfNeeded/DO_TASK_TESTS_PASS_Q.ts` routes a passing, difficulty-3-or-less task straight to `pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO`, skipping `CODEX_REVIEWS_TESTS`. The fixture below sets `difficulty: 1`, so the baseline's only two prompt boxes are `PLAN_THE_TASK` and `IMPLEMENT_TASK` — this is deliberate, not an oversight: a "minimal task" acceptance baseline should take the shortest real path the pipeline defines, not an arbitrary one. The two answer shapes below are read directly from the live templates `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.template.json` and `scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.template.json`.

Also confirmed live, `diagrams/tackle-tasks/pipeline-commitImplementationIfNeeded.mmd`: `ARE_TASK_TESTS_SKIPPED_Q -- "YES, no task tests, no codex test review" --> LOCK_SOURCE_REPO`, and on the "NO" branch a conflict-free rebase always continues into `RUN_FULL_SUITE` regardless of `hasTests`. So `hasTests: false` does not keep this scenario out of the full-suite stage — nothing does, in the default pipeline — and it skips `RUN_TASK_TESTS` outright, which the task's own acceptance requirement ("...task tests, staging merge, and archive") names as a stage this baseline must actually exercise. The fixture uses `hasTests: true` with one real, fast test instead.

```ts
test("test_acceptance_runsAMinimalTaskFromWorktreeCreationThroughStagingMergeAndArchive", async () => {
    // Scenario: a fresh target repository elsewhere on disk, distinct from this plugin checkout.
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 1, files: ["greeting.txt", "greeting.test.js"], difficulty: 1, hasTests: true });
    // Test action: drive the whole run, answering every prompt box with the minimum valid change.
    const result = driveRun(1, tasksFile, root, standardHappyPathAnswers(root, 1, "greeting.txt", "hello\n"));
    // Verification: the run reported success and the task moved from open to completed.
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(tasksFile, "utf8")), []);
    const completed = JSON.parse(readFileSync(join(root, ".taskTools/completedTasks.json"), "utf8"));
    assert.deepEqual(completed.map((t: { taskNumber: number }) => t.taskNumber), [1]);
    assert.equal(git(root, "show", "staging:greeting.txt").trim(), "hello");
});
```

`makeFixtureRepository({taskNumber, files, difficulty, hasTests})` builds a real git repo:
- `git init -b master`, `git config user.email`/`user.name`, an initial commit containing `package.json` (`{"name": "fixture", "private": true, "scripts": {"test": "node --test"}}`, so `RUN_FULL_SUITE`'s and `RUN_TASK_TESTS`'s own real test-run command — confirmed via `scripts/tackle-tasks/shared/runFullSuite.ts`'s `runCompleteSuite(checkoutPath, command)` and `scripts/tackle-tasks/shared/runTaskTestsImpl.ts` — has something real and fast to run; the exact command string either module actually invokes must be confirmed live at implementation time, since neither was fully traced by this plan) and an empty `greeting.txt`.
- `.taskTools/tasks.json` holding one open task record shaped like the live schema — `taskNumber`, `title`, `userDescription`, `description`, `modifiableFiles: files`, `readOnlyFiles: ["*"]`, `goal`, `notInScope`, `hasTests`, `difficulty`, `schemaVersion: "1.0.1"`.
- `.taskTools/completedTasks.json` holding `[]`.

Returns `{root, tasksFile}`.

`taskWorktreePath(root, taskNumber)` is a small shared helper: `join(resolveTaskWorktreeConventionDirectory(root), \`task-${taskNumber}\`)` — confirmed live at `scripts/tackle-tasks/shared/createTaskWorktree.ts` line 161, the exact same formula `taskBranchName`/`resolveTaskWorktreeConventionDirectory` compose everywhere else in this codebase (including the existing `scripts/tackle-tasks/resetTask.test.ts` fixture).

`standardHappyPathAnswers(root, taskNumber, fileName, newContent, hasTests = false)`. `hasTests` decides whether `IMPLEMENT_TASK`'s closure also writes and commits `greeting.test.js` — every scenario's fixture task record must declare exactly the files its own `standardHappyPathAnswers` call ends up committing in its `modifiableFiles`, or the preamble's `DOES_FENCE_COVER_WORKTREE_Q` fence check rejects the run; keeping the test file conditional on `hasTests` keeps every non-test scenario's fence to the one file it names:

```ts
function standardHappyPathAnswers(root: string, taskNumber: number, fileName: string, newContent: string, hasTests: boolean = false): AnswerScript {
    const worktreePath = taskWorktreePath(root, taskNumber);
    return {
        // PLAN_THE_TASK.template.json: additionalData is {outcome, planFile, clarifyRequest}. A real plan.json is
        // written because WHAT_IS_REVIEW_VERDICT.ts (scripts/tackle-tasks/whatIsReviewVerdict/, read in full) later
        // expects plan.sections to be an array even off this difficulty-1 path, so the fixture stays consistent.
        PLAN_THE_TASK: () => {
            const planFile = join(worktreePath, "plans", "plan.json");
            mkdirSync(dirname(planFile), { recursive: true });
            writeFileSync(planFile, JSON.stringify({ sections: [], revision: 0 }));
            return { message: "planned", additionalData: { outcome: "PLAN", planFile, clarifyRequest: "" } };
        },
        // IMPLEMENT_TASK.template.json: additionalData is {implemented, notes}. The file edit (and its test, when
        // hasTests) is a real side effect this closure performs directly on the worktree, the way a real agent would.
        IMPLEMENT_TASK: () => {
            writeFileSync(join(worktreePath, fileName), newContent);
            const filesToCommit = [fileName];
            if (hasTests) {
                writeFileSync(join(worktreePath, "greeting.test.js"), [
                    `const { test } = require("node:test");`,
                    `const assert = require("node:assert");`,
                    `const { readFileSync } = require("node:fs");`,
                    `test("greeting file has the expected content", () => {`,
                    `    assert.equal(readFileSync(__dirname + "/${fileName}", "utf8"), ${JSON.stringify(newContent)});`,
                    `});`,
                ].join("\n"));
                filesToCommit.push("greeting.test.js");
            }
            execFileSync("git", ["-C", worktreePath, "add", ...filesToCommit]);
            execFileSync("git", ["-C", worktreePath, "commit", "-m", "implement"]);
            return { message: "done", additionalData: { implemented: true, notes: "" } };
        },
    };
}
```

A scenario whose fixture chooses `difficulty` above 3 additionally needs `CODEX_REVIEWS_PLAN` (`{reviewFile}`, read by `WHAT_IS_REVIEW_VERDICT.ts`, whose accepted verdicts are `"ACCEPT"`/`"AMEND_THEN_ACCEPT"` from `scripts/planReviewRuling.ts`'s ruling tables — read that module at implementation time for the exact review-file shape those rulings require) and `CODEX_REVIEWS_TESTS` (`{reviewFile}`) answers too; none of this plan's scenarios need difficulty above 3, so neither is defined here.

Every remaining scenario's `makeFixtureRepository` call must set `difficulty: 1` (so it takes the same two-prompt path) and its `standardHappyPathAnswers(...)` call updates to the new `(root, taskNumber, fileName, newContent)` signature, `hasTests` defaulting to `false` unless the scenario says otherwise.

### Step 3 — a target path containing spaces

```ts
test("test_acceptance_runsFromATargetPathContainingSpaces", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 2, files: ["greeting.txt"], difficulty: 1, nameSuffix: "target with spaces" });
    const result = driveRun(2, tasksFile, root, standardHappyPathAnswers(root, 2, "greeting.txt", "hi\n"));
    assert.equal(result.ok, true);
});
```

`makeFixtureRepository`'s `nameSuffix` option makes its `mkdtempSync` prefix end in a literal space (`mkdtempSync(join(tmpdir(), "tackle-tasks-target with spaces-"))`), so `root`, `tasksFile`, and the worktree path (derived from `root` via `resolveTaskWorktreeConventionDirectory`) all contain a space. This exercises every `execFileSync`/`spawnSync` call in the real hook with an unquoted-shell-unsafe path, since `execFileSync`/`spawnSync` pass argument arrays (never a shell string) — a real path-with-spaces bug would surface as a spawn or git failure here, not as a shell-quoting test.

### Step 4 — an existing `.taskTools` directory

```ts
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
```

This is the one scenario that directly proves task 12's fix reaches a real target project, from outside `scripts/taskFiles.ts`'s own unit tests.

### Step 5 — two concurrent target repositories

`driveRun`'s own `execFileSync` calls are synchronous; passing two `driveRun(...)` calls to `Promise.all` evaluates them one after the other before `Promise.all` ever runs, which is not concurrency. Genuine concurrency needs two real OS processes, the same `spawn` + `--input-type=module --eval` shape `tests/taskFiles.test.ts`'s own concurrent-seeders test already uses (read in full, lines 74–114). Each child process is self-contained (a driver's `answers` closures cannot cross a process boundary), so it inlines its own two-prompt happy path directly rather than importing `standardHappyPathAnswers`:

```ts
test("test_acceptance_runsTwoConcurrentTargetRepositoriesWithoutCrossingWires", async () => {
    const first = makeFixtureRepository({ taskNumber: 4, files: ["a.txt"], difficulty: 1 });
    const second = makeFixtureRepository({ taskNumber: 4, files: ["b.txt"], difficulty: 1 });
    const startFile = join(tmpdir(), `tackle-tasks-concurrency-start-${process.pid}`);

    // One process per project; each waits for the same start file, then drives its own task 4 through the same
    // fileName/content pair a real driveRun would, without depending on anything defined in this test's own process.
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
            const stoppedAtBox = result.ran[result.ran.length - 1].split("::").pop();
            execFileSync("node", ["--no-inspect", ${JSON.stringify(WRITE_AGENT_ANSWER_PATH)}, result.outcome.payload], { input: JSON.stringify(answers[stoppedAtBox]()) });
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
```

Add `spawn` and `once` imports (`node:child_process`'s `spawn`, `node:events`' `once`) and `pathToFileURL` (`node:url`) to this test file, matching `tests/taskFiles.test.ts`'s own concurrent test imports.

Both fixtures use the same `taskNumber` (4) on purpose — the point under test is that two different *projects*, not two different task numbers, must never race on one file; task 10's per-project derivation (`taskWorkflowDirectory` keys off `tasksFile`'s own project root, not off a shared plugin path) is exactly what makes this safe. A byte-for-byte comparison of the two projects' own `steps.json` files is not a meaningful isolation check on its own: both use the identical default pipeline, so `generateSteps` produces identical *content* for both (confirmed live — every `script`/`template` path in `scripts/steps.json` is repo-relative, e.g. `"scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.ts"`, never project-absolute) — isolation here is about the two files never colliding at the *same path* or one write corrupting the other while both processes generate concurrently, which the "both processes exit 0 and each project's own commit lands on its own staging" assertions above already prove.

### Step 6 — one injected failure before worktree creation

`resolveTaskWorktreeConventionDirectory(repoRoot)` (`scripts/prepareTasks.ts` lines 377–381) is `join(tmpdir(), "taskTools-wt", ...)` for every project — `tmpdir()`'s parent, `taskTools-wt`, is shared by every fixture and every other test in the whole suite. Chmodding it, even temporarily, can break an unrelated concurrently-running test (including Step 5's, if the suite runs files in parallel). Node's `os.tmpdir()` reads `process.env.TMPDIR` at call time, so this scenario gives its own child process (and only that process) an isolated `TMPDIR`, and computes the same path locally instead of calling the real function under a mutated environment:

`driveRun`'s fifth, optional `env` parameter (Step 1) exists exactly for this:

```ts
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
```

Passing `{}` for `answers` is deliberate: this scenario must never reach a prompt box; if it does, `driveRun` throws `no scripted answer for prompt box ...`, which itself fails the test loudly instead of silently answering something wrong.

### Step 7 — one injected failure while the source lock is held

`diagrams/tackle-tasks/pipeline-rebase.mmd` (read in full): `REBASE_ONTO_TARGET_BRANCH`, the block right after the lock succeeds, rebases the task branch onto `staging` (`scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts`'s own `baseBranch()` hardcodes `"staging"` as the same target). Deleting the `staging` branch outright (as an earlier draft of this scenario did) risks a different, less controlled git error than an ordinary rebase failure; corrupting the ref file `staging` points at, in-place, is deterministic and fails resolving `staging` the same way for every git command that touches it, without deleting anything:

```ts
test("test_acceptance_releasesTheSourceLockWhenAFailureHappensWhileItIsHeld", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 6, files: ["a.txt"], difficulty: 1 });
    // Setup: staging now names an all-zero SHA, an invalid object. Every git command resolving "staging" fails the
    // same way — deterministic, and confined to this one fixture repo's own .git.
    writeFileSync(join(root, ".git/refs/heads/staging"), `${"0".repeat(40)}\n`);
    const result = driveRun(6, tasksFile, root, standardHappyPathAnswers(root, 6, "a.txt", "x\n"));
    // Verification: the run failed, and the lock file this task's run held is gone, not orphaned.
    assert.equal(result.ok, false);
    assert.equal(readSourceRepoLock(root), null);
});
```

`readSourceRepoLock` is imported from `scripts/tackle-tasks/shared/sourceRepoLock.ts` (already read; `readSourceRepoLock(projectRoot)` returns `null` when no lock file exists at `join(sourceRepoGitDir(projectRoot), "taskTools-source.lock")`).

### Step 8 — one conflict-fix round

The task's own worktree branches from `staging`'s tip when its worktree is created (the preamble's `CREATE_WORKTREE`). Committing a second, conflicting change directly to `staging` in the source repo *after* that point — before the run reaches `REBASE_ONTO_TARGET_BRANCH` — guarantees `git rebase` hits a real content conflict on the same file `IMPLEMENT_TASK` touches:

```ts
test("test_acceptance_resolvesOneConflictThroughTheFixConflictsPrompt", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 7, files: ["a.txt"], difficulty: 1 });
    const worktreePath = taskWorktreePath(root, 7);
    const answers = standardHappyPathAnswers(root, 7, "a.txt", "task change\n");
    // Setup: IMPLEMENT_TASK's own answer additionally advances staging with a conflicting edit to the same file,
    // right after the worktree (already branched from staging's prior tip) has made its own commit — the rebase
    // stage that follows must now hit a real conflict on a.txt.
    const implementAnswer = answers.IMPLEMENT_TASK!;
    answers.IMPLEMENT_TASK = () => {
        const answer = implementAnswer();
        writeFileSync(join(root, "a.txt"), "staging change\n");
        execFileSync("git", ["-C", root, "checkout", "staging"]);
        execFileSync("git", ["-C", root, "add", "a.txt"]);
        execFileSync("git", ["-C", root, "commit", "-m", "conflicting staging change"]);
        return answer;
    };
    // FIX_CONFLICTS.template.json (implied by task 22's fix): additionalData is {resolved, unresolvedPaths}, checked
    // against live `git diff --name-only --diff-filter=U` by COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED. The resolution
    // itself is a real side effect: pick the task's own change and stage it, the way a real conflict resolution would.
    answers.FIX_CONFLICTS = () => {
        writeFileSync(join(worktreePath, "a.txt"), "task change\n");
        execFileSync("git", ["-C", worktreePath, "add", "a.txt"]);
        return { message: "resolved", additionalData: { resolved: true, unresolvedPaths: [] } };
    };
    const result = driveRun(7, tasksFile, root, answers);
    assert.equal(result.ok, true);
    assert.equal(git(root, "show", "staging:a.txt").trim(), "task change");
});
```

This is the scenario task 22 exists for: before task 22 lands, `FIX_CONFLICTS.ts` ends on `printAsFinalMessageSection()` (raw `{resolved, unresolvedPaths}`, not `{message, additionalData}`), which `writeAgentAnswer` rejects outright — so this test is expected to fail loudly (a thrown `writeAgentAnswer: answer holds no string "message"`) until task 22 is implemented. Do not adapt this test's answer shape to the pre-task-22 raw shape to make it pass early; that would hide the exact defect task 22 fixes. Task 22 is a hard prerequisite for this scenario, not an optional enhancement — see Verification.

### Step 9 — one interrupted cleanup followed by resume

`CLEAN_UP_WORKTREES` (`diagrams/tackle-tasks/pipeline-mergeSucceededExit.mmd` line 10, read in full) is a real, live box name — the second-to-last stage before archive, after every other check has already passed. For a difficulty-1, no-conflict, no-suite-fix run, `IMPLEMENT_TASK`'s answer is the *last* prompt: everything from there to `STOP` is one continuous hook invocation (confirmed: `walkFromStep` only returns to its caller at a `SCRIPT_SIGNAL.PROMPT` stop, and no diagram between `IMPLEMENT_TASK`'s answer and `STOP` marks another box `returns_a_prompt` on this path). That invocation is the one to spawn and kill — `runStepHook.ts` writes a checkpoint for every non-prompt box before running it (lines 317–332), including `CLEAN_UP_WORKTREES` itself, so a kill right after that write, before the block's own cleanup work removes the worktree, leaves a checkpoint pointing at `CLEAN_UP_WORKTREES` inside a worktree that still exists to read it from:

```ts
test("test_acceptance_resumesAfterAnInterruptedCleanup", async () => {
    const { root, tasksFile } = makeFixtureRepository({ taskNumber: 8, files: ["a.txt"], difficulty: 1 });
    const worktreePath = taskWorktreePath(root, 8);
    const answers = standardHappyPathAnswers(root, 8, "a.txt", "x\n");

    // Test action: drive the two prompt hops (PLAN_THE_TASK, IMPLEMENT_TASK) normally, the same way driveRun does.
    skillBody("[8]", root);
    let box = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
    let input = JSON.stringify({ taskNumber: 8, tasksFile });
    for (let hop = 0; hop < 2; hop++) {
        const result = runHookOnce(box, input, root);
        const stoppedAtBox = result.ran[result.ran.length - 1]!.split("::").pop()!;
        execFileSync("node", ["--no-inspect", WRITE_AGENT_ANSWER_PATH, result.outcome!.payload], { input: JSON.stringify(answers[stoppedAtBox]!()) });
        box = result.outcome!.next!;
        input = JSON.stringify({ packetFile: result.outcome!.payload });
    }

    // Test action: spawn the final pass as a real child process, so it can be killed mid-flight instead of run to completion.
    const child = spawn("node", ["--no-inspect", RUN_STEP_HOOK_PATH], { stdio: ["pipe", "ignore", "ignore"] });
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

    // Test action: relaunch from scratch input; PREAMBLE_STATUS_CHECK's own findResumeEntry (runStepHook.ts lines
    // 296-300) finds the checkpoint and continues from CLEAN_UP_WORKTREES, not from PLAN_THE_TASK again.
    const result = driveRun(8, tasksFile, root, answers);
    assert.equal(result.ok, true);
    assert.equal(readCheckpoint(worktreePath), null); // gone once the run finishes cleanly.
});
```

Add `setTimeout` from `node:timers/promises` to this test file's imports. If the kill lands before `CLEAN_UP_WORKTREES`'s own checkpoint write is even reachable within the 30-second deadline, that is this test correctly catching a real gap in the pipeline's cleanup crash-safety — the audit lists that gap separately ("Missing critical task: worktree reset and creation are not crash-safe") under tasks not in this plan's dependency list; do not raise the deadline or relax the assertion to paper over a genuine failure to reach that checkpoint.

## Verification

This task is not complete while any scenario is red. Tasks 10, 12, 22, and 23 are hard prerequisites, not aspirational context: Step 8 needs task 22's `FIX_CONFLICTS` fix to pass at all, and Step 9 needs whatever this run of the suite reveals about cleanup crash-safety to actually be fixed (by task 23 or a follow-up) before it can pass. Do not mark this task done, and do not weaken an assertion, while Steps 2–9 are not every one green.

```sh
npm test -- tests/tackleTasksAcceptance.test.ts
```
Expected: every scenario in Steps 2–9, and the driver-level test in Step 1, pass. Run this first, in isolation, since it is the fastest signal.

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```
Expected: `all passing`, with tasks 10, 12, 22, and 23 already merged ahead of this one. A red result here is not this task's own bug to chase in isolation from those four dependencies' plans — trace it to whichever of the four (or a gap none of them covers) actually owns the fix, and confirm that dependency's own plan addresses it before closing this task.
