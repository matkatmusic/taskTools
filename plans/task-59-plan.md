# Task 59 plan: refuse tackle-tasks with a clear message when the repo has no origin remote

## Decision

Gate at the sole real CLI entry point, `scripts/prepareTasks.ts` `runAsCli`. It is the
only place in the owned codebase that leads to `buildLogicalRepositories` (via
`loadRepositoryManifest` → `groupTasksByFileOverlap` → `buildCanonicalTaskGroups`), so
refusing there before that call is ever reached fully prevents the crash. Do not touch
`scripts/repositoryDiscovery.ts`: its `readOriginUrl` rootcommit fallback stays exactly
as it is, because `tests/repositoryDiscovery.test.ts` calls `discoverRepositoryTree`
directly against repos that never set an origin remote (see `makeTempRepoWithCommit`,
lines 677-686, which never runs `git remote add origin`) and depends on that fallback
succeeding. With the new guard, no repository lacking an origin ever reaches
`discoverRepositoryTree` through `prepareTasks.ts`, so the fallback's synthetic
`rootcommit:` identity can no longer reach `buildLogicalRepositories` through this
codebase's real entry point — the condition the brief's "if it stays" clause requires
is satisfied without editing that file.

Do not teach `normalizeRepositoryIdentity` (not an owned file, and the brief explicitly
forbids this) the `rootcommit:` scheme — the decision is to refuse, not support.

## Edits

### scripts/prepareTasks.ts

Two edits, both inside the existing 219-line file. Both were read directly from the
live file and match it exactly.

**Edit 1 — add a `hasOriginRemote` helper, right before `runAsCli`.**

Current text (lines 181-184):

```
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function runAsCli(): void {
```

Becomes:

```
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function hasOriginRemote(repoRoot: string): boolean {
    try {
        execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function runAsCli(): void {
```

`execFileSync` is already imported at line 2 of the file — no new import needed.
`stdio: "ignore"` is required, not optional stylistic choice: verified empirically (see
Verification section) that `git remote get-url origin`'s stderr ("error: No such remote
'origin'") leaks straight to the terminal in this runtime even when the call sits
inside a try/catch that swallows the resulting JS exception (this is exactly the extra
"error: No such remote 'origin'" line seen ahead of the stack trace in the brief's
observed-failure transcript). Passing `stdio: "ignore"` suppresses that raw git line so
only the plain one-line message below reaches the user.

**Edit 2 — check the origin before `selectRequestedTasks` runs, inside the same
try/catch that already produces the clean `prepareTasks: <message>` stderr line.**

Current text (lines 189-195):

```
    let tasks: TaskRecord[];
    try {
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
```

Becomes:

```
    let tasks: TaskRecord[];
    try {
        if (!hasOriginRemote(repoRoot)) {
            throw new Error("this repository does not have an origin remote. set one to continue to use 'tackle-tasks'");
        }
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
```

This fires before `writeTaskBriefFile` (current line 196, called in the `for` loop
right after this block) and before `loadRepositoryManifest`/`groupTasksByFileOverlap`
(current lines 197-198) — no brief and no worktree get written for an origin-less
repo. It reuses the exact existing stderr-and-exit-1 path (`prepareTasks:
<message>` then `process.exit(1)`), per the brief's instruction to route through
"the same clean stderr-and-exit-1 path", rather than adding a second, parallel
error-reporting mechanism.

Net effect: the file grows from 219 to 231 lines (9 lines added by Edit 1, 3 lines
added by Edit 2), still under the 250-line cap.

### scripts/repositoryDiscovery.ts

No edit. Reasoning above ("Decision" section): the rootcommit fallback in
`readOriginUrl` (lines 26-37) stays untouched — removing or restricting it would break
`tests/repositoryDiscovery.test.ts`, which exercises `discoverRepositoryTree` directly
against origin-less repos and depends on the fallback succeeding. The new guard in
`prepareTasks.ts` is what keeps that fallback's synthetic identity from ever reaching
`buildLogicalRepositories` through this codebase's real entry point.

### scripts/approvalGate.ts

No edit. Handles post-merge digest/approval/authorization/finalization; has no
involvement in origin-URL discovery or the CLI entry gate.

### scripts/mergePipeline.ts

No edit. Consumes an already-built `RepositoryManifest` passed in as `input.repositoryManifest`
(`CliInput.repositoryManifest`, used at line 92); it never calls `discoverRepositoryTree`
or `readOriginUrl` itself, and — once `prepareTasks.ts` refuses an origin-less repo — it
is never invoked for one, since `mergeTaskWorktrees.ts` (its caller, not owned) only runs
after `prepareTasks.ts`'s CLI phase has already produced a manifest.

### scripts/taskGroups.ts

No edit. `groupTasksByFileOverlap` (line 59) dispatches to `buildCanonicalTaskGroups`
when given a manifest, but performs no origin-URL work itself; the new refusal happens
one step earlier, in `prepareTasks.ts`, before `groupTasksByFileOverlap` is ever called
for an origin-less repo.

### scripts/viewTaskHook.ts

No edit. This is the `/view-task` UserPromptSubmit hook; it only reads `tasks.json`/
`completedTasks.json` and formats a description. No relation to repository discovery or
origin remotes.

### skills/close-tasks/SKILL.md

No edit. Governs manually closing already-decided-done tasks; unrelated to tackle-tasks'
repository-discovery entry point.

### skills/create-task/SKILL.md

No edit. Governs appending new tasks to `tasks.json`; unrelated.

### skills/create-task/template/taskTemplate.json

No edit. Task-object template used by `create-task`; unrelated.

### skills/tackle-tasks/implement.workflow.js

No edit. Runs after `prepareTasks.ts`'s CLI step has already produced `WorkflowArguments`
(consumed via `ARGS.groups`); it does not call `git remote`, `readOriginUrl`, or
`discoverRepositoryTree`, and for an origin-less repo the pipeline never reaches this
step because `prepareTasks.ts` has already exited 1.

### skills/tackle-tasks/plan.workflow.js

No edit. Same reasoning as `implement.workflow.js`: consumes `ARGS.groups` produced
upstream by `prepareTasks.ts`; no origin-URL logic of its own; never reached for an
origin-less repo once the CLI guard exits first.

### skills/tackle-tasks/test.workflow.js

No edit. Same reasoning: consumes `ARGS.groups`/`ARGS.done` produced upstream; no
origin-URL logic of its own; never reached for an origin-less repo.

### skills/tackle-tasks/verify.workflow.js

No edit. Same reasoning: consumes `ARGS.planned`/`ARGS.groups` produced upstream; no
origin-URL logic of its own; never reached for an origin-less repo.

### skills/update-task-files/SKILL.md

No edit. Governs backfilling the `files` array on existing tasks; unrelated to
repository discovery or origin remotes.

### tests/prepareTasks.test.ts

No edit. This task's `tests` field is absent/`"skip"`, so no TDD requirement — ordinary
verification commands are given below instead. Confirmed by reading every existing test
in this file (lines 463-651) that none of them call the private `runAsCli`/
`hasOriginRemote` functions or exercise the new guard; they only call the exported
`writeTaskBriefFile`, `createWorktreeForGroup`, `buildWorkflowArguments`,
`selectRequestedTasks`, `generateRunId`, and `resolveMergeScriptPath` — none of which
contain the new origin check — so none of these 21 existing tests are affected by
either edit (all 21 pass today, confirmed by running the suite; see Verification).

### tests/prepareTasksIntegration.test.ts

No edit. Its root fixture explicitly sets an origin remote (line 35:
`git(rootPath, ["remote", "add", "origin", "https://example.com/root.git"]);`), so the
new guard in `prepareTasks.ts` never rejects it — this file never calls `runAsCli`
directly anyway (it calls `bootstrapRepositoryManifest`, `getOwningOccurrence`,
`groupTasksByFileOverlap`, and spawns `buildWorkflowArguments` via a `bun -e` snippet,
none of which are touched by this change).

### tests/repositoryDiscovery.test.ts

No edit. Exercises `discoverRepositoryTree` directly (bypassing `prepareTasks.ts`'s
CLI entirely), against fixtures built by `makeTempRepoWithCommit` (lines 677-686) that
never set an origin remote. Since `scripts/repositoryDiscovery.ts` is left untouched,
every test in this file keeps passing exactly as before.

### tests/taskGroups.test.ts

No edit. Calls `groupTasksByFileOverlap` directly against hand-built
`RepositoryManifest` fixtures with a `flatManifest.originUrl` already set to a real URL
(`"https://local/flat/flat.git"`, line 23); no origin-remote discovery happens in this
file at all.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools` after making the two edits to
`scripts/prepareTasks.ts`.

1. Typecheck — confirm the edit introduces no type errors (baseline today is clean,
   confirmed by running this exact command before editing):

   ```
   npx tsc --noEmit
   ```

   Expected: `TypeScript: No errors found`, exit code 0.

2. Existing unit tests — confirm no regression (baseline today: all pass, confirmed by
   running this exact command before editing — 21 tests, 21 pass):

   ```
   node --test tests/prepareTasks.test.ts
   ```

   Expected: `ℹ tests 21`, `ℹ pass 21`, `ℹ fail 0`.

3. Existing repository-discovery tests — confirm the untouched fallback still works for
   origin-less repos:

   ```
   node --test tests/repositoryDiscovery.test.ts
   ```

   Expected: all tests pass (no failures), matching current behavior.

4. New behavior — the refusal, on a real origin-less repo, produces a plain one-line
   message and exit code 1, with no raw git stderr and no stack trace:

   ```
   rm -rf /tmp/task59-origin-check && mkdir /tmp/task59-origin-check && cd /tmp/task59-origin-check \
     && git init -q && git config user.email a@b.com && git config user.name t \
     && mkdir .taskTools && echo '[{"taskNumber":1,"title":"t","description":"d","files":["x"]}]' > .taskTools/tasks.json \
     && echo x > x && git add x .taskTools/tasks.json && git commit -q -m seed \
     && node /Users/matkatmusicllc/Programming/taskTools/scripts/prepareTasks.ts '[1]'; echo "EXIT:$?"
   ```

   Expected stderr (and only this, nothing else — no "error: No such remote 'origin'",
   no stack trace):

   ```
   prepareTasks: this repository does not have an origin remote. set one to continue to use 'tackle-tasks'
   ```

   Expected: `EXIT:1`, and no `plans/brief-1.md` file or worktree created under
   `/tmp/task59-origin-check`.

5. Regression check — the same flow on a repo that *does* have an origin still runs
   past the new guard (fails later for an unrelated reason — a `.taskTools/tasks.json`
   this minimal fixture may still be missing pieces for full success — but must NOT
   fail with the origin message):

   ```
   rm -rf /tmp/task59-origin-check-2 && mkdir /tmp/task59-origin-check-2 && cd /tmp/task59-origin-check-2 \
     && git init -q && git config user.email a@b.com && git config user.name t \
     && git remote add origin https://example.com/x.git \
     && mkdir .taskTools && echo '[{"taskNumber":1,"title":"t","description":"d","files":["x"]}]' > .taskTools/tasks.json \
     && echo x > x && git add x .taskTools/tasks.json && git commit -q -m seed \
     && node /Users/matkatmusicllc/Programming/taskTools/scripts/prepareTasks.ts '[1]'; echo "EXIT:$?"
   ```

   Expected: stderr does NOT contain "does not have an origin remote".
