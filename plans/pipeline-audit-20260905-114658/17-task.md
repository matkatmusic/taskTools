# Task 17 plan — one process-tree-aware suite runner, used by both unbounded test runners

Confirmed by the codex audit ("High: task 17 leaves another unbounded suite runner in the pipeline"): there are two unbounded runners, not one.

- `scripts/taskTestsRunner.ts:33` — `spawnSync("bash", ["-c", INITIAL_PASS], { cwd, encoding: "utf8", env })` — no `timeout`.
- `scripts/tackle-tasks/shared/runFullSuite.ts:24-34`, inside `runCompleteSuite` — `execSync(command, { cwd: checkoutPath, ... })` — no `timeout`.

Both run underneath a step script that `scripts/runStepHook.ts`'s own `runStepScript` (`scripts/runStepHook.ts:146-174`) spawns with `spawnSync("node", nodeArguments, { ..., timeout: STEP_TIMEOUT_MS })`, `STEP_TIMEOUT_MS = 300_000` (`scripts/runStepHook.ts:47`, 5 minutes). `spawnSync`'s own `timeout` option signals only its **direct child** (the `node RUN_TASK_TESTS.ts`/`node RUN_FULL_SUITE.ts` process) — it does not reach that process's own children (`bash` → `npm` → `node --test`). So today, a hung suite is killed at the direct-child level after 5 minutes, but `npm`/`node --test` (and anything they forked) survive as orphans, and the step never gets to record *why* it failed — `runStepScript` just sees a `null` exit code and reports "did not exit within 300000ms" with no suite-level detail.

Fix (from the task record): one process-tree-aware runner, reused by both call sites — detached spawn, `process.kill(-pid)` on timeout (POSIX-only; stated and tested as such), and the timeout persisted as a normal red/operational result **before** `runStepHook.ts`'s own 300-second kill fires. `runTaskTests`/`runFullSuite` must stay synchronous-looking to their own callers only in the sense that they still return one JSON-serializable result — the runner itself becomes `async` end-to-end, which the task's own callers list makes unavoidable: `scripts/tackle-tasks/shared/runTaskTestsImpl.ts:135`, `scripts/taskTestsHook.ts:36`, `scripts/tackle-tasks/shared/runFullSuite.ts:28` all currently call the runner synchronously and must `await` it once it is async.

## Scope confirmation

- `scripts/taskTestsRunner.ts` (untracked but imported live — the codex audit calls this out explicitly; `git add scripts/taskTestsRunner.ts` is part of this task's own commit, not optional)
  - Line 1 comment: "The one place a suite runs and its failures are parsed." — the intended single home for the new shared runner.
  - Lines 28-37, today:
    ```ts
    export function runSuite(cwd: string): { allPassing: boolean; output: string; log: string } {
        // npm walks up to a parent package.json; from a fixture inside this repo that reruns this whole suite, forever.
        if (!existsSync(join(cwd, "package.json"))) throw new Error(`task-tests: no package.json in ${cwd}`);
        // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
        const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
        const run = spawnSync("bash", ["-c", INITIAL_PASS], { cwd, encoding: "utf8", env });
        const output = `${run.stdout}${run.stderr}`.trim();
        const log = output === "all passing" ? "" : readFileSync(LOG_PATH, "utf8");
        return { allPassing: output === "all passing", output, log };
    }
    ```

- `scripts/tackle-tasks/shared/runFullSuite.ts`
  - Lines 24-35, today:
    ```ts
    function runCompleteSuite(checkoutPath: string, command: string): { passed: boolean; output: string } {
        try {
            // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
            const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
            const stdout = execSync(command, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
            return { passed: true, output: stdout };
        } catch (error) {
            const execError = error as { status?: number | null; stdout?: string; stderr?: string };
            if (execError.status === undefined || execError.status === null) throw error;
            return { passed: false, output: `${execError.stdout ?? ""}${execError.stderr ?? ""}` };
        }
    }
    ```
  - Lines 37-86, `export function runFullSuite(...)` — its `for (const occurrence of occurrences)` loop at line 52 calls `runCompleteSuite` synchronously (line 60).
  - Lines 97-103, CLI entry block — calls `runFullSuite(...)` synchronously and writes its result to stdout.

- `scripts/tackle-tasks/shared/runTaskTestsImpl.ts`
  - Line 84, `export function runTaskTests(...)`.
  - Line 135: `const suite = runSuite(worktreePath);` inside the `else` branch (`testFiles.length > 0`).
  - No CLI entry block in this file (confirmed: no `if (process.argv[1]...)` block present).

- `scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.ts` (full file, 17 lines)
  - Line 10: `export function main(input: string): CommitImplementationIfNeededPacket {`
  - Line 12: `runTaskTests(packet.taskNumber, packet.runId, packet.worktree, "RUN_TASK_TESTS", packet.projectRoot);`
  - Lines 16-17: `if (realpathSync(...) === realpathSync(...)) console.log(JSON.stringify(main(process.argv[2] ?? "")));`

- `scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts` (full file, 39 lines)
  - Line 25: `export function main(input: string): Record<string, unknown> {`
  - Lines 29-31: `const result = runFullSuite(packet.taskNumber, packet.runId, packet.worktree, targetBranch, \`run-full-suite-${attempts}\`, packet.projectRoot);`
  - Lines 38-39: same `if (realpathSync(...)) console.log(JSON.stringify(main(...)));` shape.

- `scripts/taskTestsHook.ts`
  - Line 36: `const suite = runSuite(cwd);` — top-level script code (ESM module, no wrapping function), called synchronously today.
  - `tests/taskTestsHook.test.ts` drives this file only by spawning it as a child process (`execFileSync("node", [hookPath], { input: ..., encoding: "utf8" })`) — it never imports `taskTestsHook.ts`'s internals, so making the hook's own top-level code `async`/`await` (ESM top-level `await` is valid; this file has no wrapping function to convert) requires **no change** to `tests/taskTestsHook.test.ts`.

- Test files that call `runFullSuite`/`runTaskTests`/`main` directly in-process and must add `await` (and mark their `test(...)` callback `async`):
  - `scripts/tackle-tasks/shared/runFullSuite.test.ts` — 5 call sites: lines 77, 93, 107, 128, and the `assert.throws` call at line 147.
  - `scripts/tackle-tasks/shared/runTaskTestsImpl.test.ts` — 14 call sites at lines 80, 100, 120, 144, 163, 200, 219, 246, 267, 286, 311, 335, 367, and the `assert.throws` call at line 354 (line 187 is already commented out; skip it).
  - `scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.test.ts` — 3 call sites, lines 57, 69, 86 and 88.
  - `scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.test.ts` — 3 call sites, lines 42, 67, 70.
  - `tests/taskTestsRunner.test.ts` — calls only `parseFailingTests`/`newFailingTests`/`judgeSuite` (pure functions, unaffected); no change needed.

- `scripts/tackle-tasks/shared/greenBoxPolicy.ts` — lines 43-44 and 87 reference `runFullSuite`/`runTaskTests`/`"runTaskTestsImpl"` only as **string labels** in a policy table (confirmed: `grep -n "runFullSuite(\|runTaskTests(" scripts/tackle-tasks/shared/greenBoxPolicy.ts` finds no call, only labels), not calls — no change needed.

- `scripts/runStepHook.ts:47`, `STEP_TIMEOUT_MS = 300_000` — the outer ceiling the new inner timeout must sit safely under. Not edited by this task.

## Steps

### Step 1 — the shared process-tree-aware runner, in `scripts/taskTestsRunner.ts`

`timeoutMs` is always an explicit argument to `runCommandInProcessGroup`, never read from `process.env` inside it — a test that wants a short timeout passes the number directly. `SUITE_TIMEOUT_MS` exists only as the *production default* that `runSuite`/`runFullSuite`/`runTaskTests` fall back to when their own caller does not override it; no test needs to (or can reliably) change it after the fact, because ES module imports are fully evaluated — including any `process.env` read at a module's own top level — before the importing test file's own top-level statements run, so a `process.env.SUITE_TIMEOUT_MS = "200"` line placed after an `import` in a test file always runs too late to affect an already-evaluated constant.

`test_runCommandInProcessGroup_killsTheWholeProcessGroupOnTimeout`, `test_runCommandInProcessGroup_settlesOnceEvenWhenSpawnItselfFails`, `test_runCommandInProcessGroup_boundsBufferedOutputForANoisyHangingChild`, and `test_isProcessGroupKillSupported_isFalseOnlyOnWin32`, new tests in `tests/taskTestsRunner.test.ts`:

Plain-English behavior: a command that backgrounds a grandchild and outlives its timeout must have its whole process group dead a moment later, reporting `timedOut: true`. A command that cannot even spawn must reject cleanly rather than crash the process. A command that floods stdout forever must still return a small, bounded `output` string. Windows support is a pure yes/no question, answerable without touching the real `process.platform`.

```ts
import { runCommandInProcessGroup, isProcessGroupKillSupported } from "../scripts/taskTestsRunner.ts";

test("test_runCommandInProcessGroup_killsTheWholeProcessGroupOnTimeout", async () => {
    // Setup: a command that backgrounds a grandchild and waits on it, so the bug (killing only the direct child) would leave it alive.
    const result = await runCommandInProcessGroup(`sleep 999 & echo "child pid: $!"; wait`, process.cwd(), process.env, 200);
    // Verification: the runner reports a timeout, not a normal exit.
    assert.equal(result.timedOut, true);
    // Verification: the reported child pid's process group holds nothing alive a moment after the kill.
    const childPid = Number(result.output.match(/child pid: (\d+)/)![1]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test("test_runCommandInProcessGroup_settlesOnceEvenWhenSpawnItselfFails", async () => {
    // A nonexistent cwd makes the underlying spawn emit "error" instead of ever reaching "close".
    await assert.rejects(runCommandInProcessGroup("true", "/no/such/directory", process.env, 1000));
});

test("test_runCommandInProcessGroup_boundsBufferedOutputForANoisyHangingChild", async () => {
    const result = await runCommandInProcessGroup(
        `while true; do echo "noise noise noise noise noise noise noise noise"; done`, process.cwd(), process.env, 300,
    );
    assert.equal(result.timedOut, true);
    assert.ok(result.output.length <= 8_100, `output length was ${result.output.length}`);
});

test("test_isProcessGroupKillSupported_isFalseOnlyOnWin32", () => {
    assert.equal(isProcessGroupKillSupported("win32"), false);
    assert.equal(isProcessGroupKillSupported("darwin"), true);
    assert.equal(isProcessGroupKillSupported("linux"), true);
});
```

Production code, `scripts/taskTestsRunner.ts`:

- Change the import from `spawnSync` to `spawn`:
  ```ts
  import { spawn } from "node:child_process";
  ```
- Add, near the top (after `LOG_PATH`, before `INITIAL_PASS`):
  ```ts
  // Below runStepHook.ts's own 300s per-block kill (scripts/runStepHook.ts:47) — the production default when a caller passes none.
  export const SUITE_TIMEOUT_MS = 240_000;
  // Caps the in-memory buffer a noisy hanging child can grow while still running — the last MAX_LIVE_OUTPUT_LENGTH
  // characters are always what a timeout reports, independent of how long the child ran or how much it printed.
  const MAX_LIVE_OUTPUT_LENGTH = 8_000;

  export type ProcessGroupResult = { code: number | null; timedOut: boolean; output: string };

  // ponytail: POSIX-only — a negative pid signals the whole process group; there is no Windows equivalent here.
  export function isProcessGroupKillSupported(platform: string = process.platform): boolean {
      return platform !== "win32";
  }

  export function runCommandInProcessGroup(
      command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number,
  ): Promise<ProcessGroupResult> {
      if (!isProcessGroupKillSupported()) {
          return Promise.reject(new Error("runCommandInProcessGroup: POSIX-only (process-group kill via negative pid); not supported on win32"));
      }
      return new Promise((resolveResult, rejectResult) => {
          const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
          let output = "";
          let timedOut = false;
          let settled = false;
          child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk).slice(-MAX_LIVE_OUTPUT_LENGTH); });
          child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk).slice(-MAX_LIVE_OUTPUT_LENGTH); });
          const timer = setTimeout(() => {
              timedOut = true;
              if (child.pid === undefined) return;
              try {
                  process.kill(-child.pid, "SIGKILL");
              } catch (killError) {
                  if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;
              }
          }, timeoutMs);
          child.on("error", (error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              rejectResult(error);
          });
          child.on("close", (code) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolveResult({ code, timedOut, output: output.trim() });
          });
      });
  }
  ```
- Replace `runSuite`'s body (lines 28-37) with, taking `timeoutMs` as an explicit parameter defaulting to the production constant so a caller can pass a small value directly:
  ```ts
  export async function runSuite(
      cwd: string, timeoutMs: number = SUITE_TIMEOUT_MS,
  ): Promise<{ allPassing: boolean; output: string; log: string; timedOut: boolean }> {
      // npm walks up to a parent package.json; from a fixture inside this repo that reruns this whole suite, forever.
      if (!existsSync(join(cwd, "package.json"))) throw new Error(`task-tests: no package.json in ${cwd}`);
      // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
      const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
      const run = await runCommandInProcessGroup(INITIAL_PASS, cwd, env, timeoutMs);
      const output = run.timedOut ? `the suite timed out after ${timeoutMs}ms and was killed` : `${run.output}`.trim();
      const log = output === "all passing" ? "" : existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "";
      return { allPassing: output === "all passing", output, log, timedOut: run.timedOut };
  }
  ```

The kill-error guard (`if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;`) matches the existing pattern in this codebase for a benign kill-target-already-gone race — `scripts/tackle-tasks/shared/sourceRepoLock.ts`'s temp-file cleanup does the identical `catch`-check-`ENOENT`-else-rethrow — not a speculative try/catch; the timer's kill and the child's own natural exit can land in either order, and only the "already gone" outcome is expected. `child.on("error", ...)` and the `settled` guard cover the case a bare `close`-only listener cannot: a `spawn` that never produces a child at all (bad `cwd`, missing `bash`) emits `"error"` instead of `"close"`, and without a listener Node treats an unhandled `"error"` event as a thrown exception that would crash the whole hook process.

### Step 2 — `runFullSuite.ts` reuses the same runner, with one total budget across every occurrence

`runFullSuite` walks every occurrence sequentially in one call (`getOccurrencesDeepestFirst`, confirmed live at `scripts/tackle-tasks/shared/runFullSuite.ts:47`) and is itself run as one `RUN_FULL_SUITE.ts` step, subject to the same outer 300s `STEP_TIMEOUT_MS` kill as any other block. A fixed per-occurrence timeout does not bound the *whole call*: two occurrences each allowed up to `SUITE_TIMEOUT_MS` can together exceed `STEP_TIMEOUT_MS` before either result is persisted. `runFullSuite` therefore takes one total budget, decrements it as occurrences run, and stops attempting further occurrences (marking them red, not silently skipped) once it is exhausted — rather than handing every occurrence the same fixed allowance regardless of how many ran before it.

`test_runFullSuite_reportsATimeoutAsARedLayerNotAHang` and `test_runFullSuite_stopsRemainingLayersWhenTheTotalBudgetIsExhausted`, new tests appended to `scripts/tackle-tasks/shared/runFullSuite.test.ts`:

Plain-English behavior: a single occurrence whose complete-suite command hangs forever must come back `passed: false` with an output naming the timeout. A two-occurrence repo (root plus a submodule, the same fixture shape as `test_runFullSuite_failsWhenASubmoduleSuiteIsRedAndTheRootIsGreen`) whose deeper occurrence hangs must never let the shallower, otherwise-green occurrence consume time beyond the run's own total budget — it is marked red for having no budget left, not silently skipped and not given its own fresh allowance.

```ts
test("test_runFullSuite_reportsATimeoutAsARedLayerNotAHang", async () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    writeFileSync(join(rootOrigin, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "sleep 999 & wait" } }));
    git(rootOrigin, "add", "package.json");
    git(rootOrigin, "commit", "-q", "-m", "hang");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin, 200);

    assert.equal(result.passed, false);
    assert.match(result.output, /timed out/);
});

test("test_runFullSuite_stopsRemainingLayersWhenTheTotalBudgetIsExhausted", async () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    writePackageJsonWithTestExitCode(rootOrigin, 0);
    const childOrigin = makeTempRepoWithCommit("main");
    writeFileSync(join(childOrigin, "package.json"), JSON.stringify({ name: "child", scripts: { test: "sleep 999 & wait" } }));
    git(childOrigin, "add", "package.json");
    git(childOrigin, "commit", "-q", "-m", "hang");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule");
    const worktreePath = createLinkedWorktree(rootOrigin);
    seedOpenTaskAndClaim(rootOrigin, 1);

    // Total budget of 200ms: the deeper (submodule) occurrence runs first, hangs, and consumes it all.
    const result = await runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin, 200);

    assert.equal(result.passed, false);
    assert.equal(result.layers.length, 2);
    assert.ok(result.layers.every((layer) => layer.passed === false));
});
```

Production code, `scripts/tackle-tasks/shared/runFullSuite.ts`:

- Drop the `execSync` import (`node:child_process`) — no longer used in this file once `runCompleteSuite` is rewritten.
- Import the shared runner: `import { runCommandInProcessGroup, SUITE_TIMEOUT_MS } from "../../taskTestsRunner.ts";` (added to the existing import line from that file).
- Replace `runCompleteSuite` (lines 24-35), now taking the remaining budget as an explicit timeout and reporting whether it timed out (so the caller can skip the reclassification below, not just persist the message):
  ```ts
  async function runCompleteSuite(checkoutPath: string, command: string, timeoutMs: number): Promise<{ passed: boolean; output: string; timedOut: boolean }> {
      // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
      const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
      const run = await runCommandInProcessGroup(command, checkoutPath, env, timeoutMs);
      if (run.timedOut) return { passed: false, timedOut: true, output: `${run.output}\nthe full suite timed out after ${timeoutMs}ms and was killed` };
      return { passed: run.code === 0, timedOut: false, output: run.output };
  }
  ```
- Change `export function runFullSuite(` (line 37) to `export async function runFullSuite(`, add a `totalTimeoutMs: number = SUITE_TIMEOUT_MS` parameter after `projectRoot`, and replace the `for (const occurrence of occurrences)` loop (lines 52-76):
  ```ts
  const deadlineAt = Date.now() + totalTimeoutMs;
  for (const occurrence of occurrences) {
      const policyResult = discoverTestPolicy(occurrence.occurrenceId, occurrence.checkoutPath, resolutionManifest);
      // A layer with no discoverable suite has nothing to fail, so it counts as passed.
      if (policyResult.status === "needsResolution") {
          layers.push({ occurrenceId: occurrence.occurrenceId, passed: true });
          outputs.push(`occurrence "${occurrence.occurrenceId}" has no discoverable test suite`);
          continue;
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
          layers.push({ occurrenceId: occurrence.occurrenceId, passed: false });
          outputs.push(`occurrence "${occurrence.occurrenceId}" was not run: the full-suite budget (${totalTimeoutMs}ms) was already spent`);
          continue;
      }
      const layerRun = await runCompleteSuite(occurrence.checkoutPath, policyResult.policy.completeSuiteCommand, remainingMs);
      let layerPassed = layerRun.passed;
      let layerOutput = layerRun.output;
      if (!layerRun.passed) {
          if (!layerRun.timedOut) {
              const failing = parseFailingTests(layerRun.output);
              const newFailures = newFailingTests(failing, readKnownFailingTests(projectRoot));
              const knownStillFailing = failing.filter((test) => !newFailures.includes(test));
              layerPassed = judgeSuite(false, failing, newFailures);
              layerOutput = [
                  ...newFailures.map((test) => `new failing test: ${test.file} — ${test.name}`),
                  ...knownStillFailing.map((test) => `known failing test (ignored): ${test.file} — ${test.name}`),
                  layerRun.output,
              ].join("\n");
          }
      }
      layers.push({ occurrenceId: occurrence.occurrenceId, passed: layerPassed });
      outputs.push(layerOutput);
  }
  ```
  The `if (!layerRun.passed) { if (!layerRun.timedOut) { ... } }` nesting is the fix for issue 3 below — it must stay two separate `if`s, not `if (!layerRun.passed && !layerRun.timedOut)`, per this repo's single-condition-per-branch rule.
- CLI entry block (lines 97-103): change `const output = runFullSuite(...)` to `const output = await runFullSuite(...)` — top-level `await` is valid here (ESM module, no wrapping function).

**Issue: a timed-out layer could be reclassified as passing.** Before this change, every non-passing layer — timeout included — was re-judged by `judgeSuite(false, failing, newFailures)`, which returns `true` whenever every failure `parseFailingTests` finds in the (possibly truncated, mid-hang) output is already a *known* failure. A suite that prints a known failure and then hangs would come back green. The `if (!layerRun.timedOut)` guard above means a timed-out layer's `layerPassed` stays exactly what `runCompleteSuite` already decided (`false`) and is never handed to `judgeSuite`.

Every other test in `runFullSuite.test.ts` that calls `runFullSuite(...)` synchronously must add `await` and have its `test("...", () => {` callback changed to `test("...", async () => {`: lines 77, 93, 107, 128. Line 147's `assert.throws(() => runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin), /run-2/);` must become:
```ts
    await assert.rejects(runFullSuite(1, RUN_ID, worktreePath, "main", "step-1", rootOrigin), /run-2/);
```
(`runFullSuite` is now `async`; a synchronous throw inside it — `requireAbsolutePath` and the stale-run-id check both happen before the function's first `await` — still rejects the returned promise rather than throwing synchronously to the caller, so `assert.throws(() => fn())` would pass for the wrong reason (the call not throwing) while never inspecting the rejection; `assert.rejects` is required.)

`scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.ts`:
```ts
export async function main(input: string): Promise<Record<string, unknown>> {
    const { next: _next, ...packet } = JSON.parse(input) as Input & { next?: string };
    const targetBranch = baseBranch(packet.projectRoot);
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const attempts = getAttemptCount(packet.taskNumber, "suiteFix", packet.projectRoot);
    const result = await runFullSuite(
        packet.taskNumber, packet.runId, packet.worktree, targetBranch, `run-full-suite-${attempts}`, packet.projectRoot,
    );
    return {
        ...packet,
        box: "RUN_FULL_SUITE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        ownedFilePaths: prepared.ownedFilePaths,
        testFilePaths: prepared.testFilePaths,
        passed: result.passed,
        output: result.output,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(await main(process.argv[2] ?? "")));
```

`scripts/tackle-tasks/runFullSuite/RUN_FULL_SUITE.test.ts`: its 3 call sites (lines 42, 67, 70) each need `await` in front of `main(...)`, and their enclosing `test(...)` callbacks need `async`.

### Step 3 — `runTaskTestsImpl.ts` reuses the same runner

`test_runTaskTests_reportsATimeoutAsARedResultNotAHang`, new test appended to `scripts/tackle-tasks/shared/runTaskTestsImpl.test.ts`:

Plain-English behavior: a branch that adds a test file, whose `npm test` hangs, must come back `passed: false` with a timeout noted in `output`, not a raw crash or an indefinite hang.

```ts
test("test_runTaskTests_reportsATimeoutAsARedResultNotAHang", async () => {
    const rootOrigin = makeTempRepoWithCommit("main");
    const worktreePath = createLinkedWorktree(rootOrigin);
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    writeFileSync(join(worktreePath, "tests", "foo.test.ts"), `import { test } from "node:test";\ntest("t", () => {});\n`);
    git(worktreePath, "add", "tests/foo.test.ts");
    git(worktreePath, "commit", "-q", "-m", "add hanging test");
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "sleep 999 & wait" } }));
    git(worktreePath, "add", "package.json");
    git(worktreePath, "commit", "-q", "-m", "hang");
    seedOpenTaskAndClaim(rootOrigin, 1);

    const result = await runTaskTests(1, RUN_ID, worktreePath, "step-1", rootOrigin, 200);

    assert.equal(result.passed, false);
    assert.match(result.output, /timed out/);
});
```

(Adjust the two-commit setup to whatever this file's existing `makeTempRepoWithCommit`/`createLinkedWorktree` helpers already provide for adding a package.json inside the worktree branch — follow the pattern already used by the file's other `writeFileSync(... "package.json" ...)` cases, if any exist; otherwise this exact two-`git add`/`git commit` shape is sufficient since `runTaskTests` diffs the worktree branch against `"staging"`, so both the test file and the hanging `package.json` must be committed on the worktree's own branch to be picked up as "runnable" test files.)

Production code, `scripts/tackle-tasks/shared/runTaskTestsImpl.ts`:

- Change `export function runTaskTests(` (line 84) to `export async function runTaskTests(`, and add a `timeoutMs: number = SUITE_TIMEOUT_MS` parameter after `projectRoot` (import `SUITE_TIMEOUT_MS` alongside this file's existing `taskTestsRunner.ts` import).
- Change line 135, `const suite = runSuite(worktreePath);`, to `const suite = await runSuite(worktreePath, timeoutMs);`.
- Change line 139, `passed = judgeSuite(suite.allPassing, failing, newFailures);`, to a nested guard rather than folding `suite.timedOut` into `judgeSuite`'s own inputs:
  ```ts
  if (suite.timedOut) {
      passed = false;
  } else {
      passed = judgeSuite(suite.allPassing, failing, newFailures);
  }
  ```
  **Issue: a timed-out suite could be reclassified as passing.** Before this change, `passed` was always `judgeSuite(suite.allPassing, failing, newFailures)`, which returns `true` whenever every parsed failure is already known — including when the suite printed a known failure and then hung. The guard above means a timed-out run is red regardless of what `judgeSuite` would have said.
- Add, immediately after the existing `outputParts.push(...taskKnownFailingTests...)` line inside the same `else` branch: `if (suite.timedOut) outputParts.push(`the branch's test suite timed out after ${timeoutMs}ms and was killed`);` — so `output` names the timeout the same way `runFullSuite`'s does.

Every call site in `runTaskTestsImpl.test.ts` (lines 80, 100, 120, 144, 163, 200, 219, 246, 267, 286, 311, 335, 367) needs `await` added and its enclosing `test(...)` callback marked `async`. Line 354's `assert.throws(() => runTaskTests(1, RUN_ID, worktreePath, "step-1", rootOrigin), /run-2/);` becomes:
```ts
    await assert.rejects(runTaskTests(1, RUN_ID, worktreePath, "step-1", rootOrigin), /run-2/);
```
for the same synchronous-throw-vs-rejected-promise reason as Step 2.

`scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.ts`:
```ts
export async function main(input: string): Promise<CommitImplementationIfNeededPacket> {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    await runTaskTests(packet.taskNumber, packet.runId, packet.worktree, "RUN_TASK_TESTS", packet.projectRoot);
    return { ...packet, box: "RUN_TASK_TESTS", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(await main(process.argv[2] ?? "")));
```

`scripts/tackle-tasks/commitImplementationIfNeeded/RUN_TASK_TESTS.test.ts`: 3 call sites (lines 57, 69, 86, 88 — 88 is a second call in the same test as 86) each need `await`, and their `test(...)` callbacks need `async`.

### Step 4 — `taskTestsHook.ts` awaits the now-async `runSuite`

Production code, `scripts/taskTestsHook.ts`, line 36:
```ts
const suite = await runSuite(cwd);
```
(top-level `await`, valid ESM — this file has no wrapping function around its script body). No test change: `tests/taskTestsHook.test.ts` only spawns this file as a child process and reads its stdout, so it is unaffected by the internal `async`/`await` change (confirmed in Scope confirmation above).

### Step 5 — stage the untracked runner file

`scripts/taskTestsRunner.ts` and `tests/taskTestsRunner.test.ts` are both untracked today (`git status` shows `?? scripts/taskTestsRunner.ts` and `?? tests/taskTestsRunner.test.ts`) but already imported live by `runFullSuite.ts`, `runTaskTestsImpl.ts`, and `taskTestsHook.ts`. Stage both alongside every file this plan edits:
```sh
git add scripts/taskTestsRunner.ts tests/taskTestsRunner.test.ts
```
before running the full suite in Verification, so the "git grep hygiene" style tests (any test that only sees tracked files) exercise the real, staged content.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```sh
git add scripts/taskTestsRunner.ts tests/taskTestsRunner.test.ts
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

If it does not print `all passing`, run `npm test 2>&1 | tail -50` and fix the failure before moving on; repeat until `all passing` prints, then stop — do not re-run to confirm.

As a targeted sanity check before the full run, confirm no orphaned `sleep` processes survive the new timeout tests:
```sh
node --test scripts/taskTestsRunner.test.ts scripts/tackle-tasks/shared/runFullSuite.test.ts scripts/tackle-tasks/shared/runTaskTestsImpl.test.ts
ps -eo pid,command | grep '[s]leep 999'
```
The `ps` line must print nothing.
