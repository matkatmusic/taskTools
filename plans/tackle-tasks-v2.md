# tackle-tasks-v2 — design

Rebuild taskTools as a composable, tested library with thin skills. Built on its
own worktree, branch `tackle-tasks-v2`.

This document was verified against the codebase by five independent audits. What
they found is recorded here rather than smoothed over — §13 lists every claim
the first draft got wrong.

## 1. Why

`tasks.json` is the backlog for a project, used across several repos. taskTools'
skills and scripts are the mechanism that manages that backlog.

Three problems, ranked by the strength of the evidence behind them.

### 1.1 Unbounded retries (measured)

From `plans/tackle-metrics.jsonl` — 21 runs, 45 tasks, 10.57 hours:

| Run | What happened | Duration |
|---|---|---|
| average | — | 14.1 min/task |
| task 16 | retried, ended in conflict | **201.7 min (3.4 h)** |
| task 17 | retried, still blocked | 26.4 min |
| task 9 | blocked at 316s, retried, ended in conflict | 21.0 min |

One task consumed 14× the average and produced nothing. Nothing in v1 bounds a
retry: `requeueCount` permits one more pass with no time limit and no attempt
ceiling. This is the single largest cost in the system and it is unaddressed.

### 1.2 Merge and worktree fragility (three recorded incidents)

- `4ef2ad7` — a `TypeError` in `mergeCliInput` aborted the merge step before any
  group merged.
- `482f1c5` — worktree merge/rebase failures with no error reason reported.
- `3a92ec6` — `ENOENT` race in `stage-and-summarize-stop`'s turn-flag cleanup.
- Task 1 (closed): worktree teardown **destroyed committed work** by deleting
  submodule commits on `git worktree remove --force`. The fix made teardown
  non-destructive and accepted, in its own words, that "worktrees now accumulate
  indefinitely since no cleanup path remains."

Conflicts occurred in 2 of 21 runs; 7 blocked outcomes across 5 of 21 runs.

### 1.3 Code that cannot be composed (no incident evidence)

255 functions across 51 scripts, with duplicates up to eight deep and names that
state no behavior — `declaredFiles`, `openBlockersOf`, `classify`. Composition
requires reading bodies.

**This is real but has no measured cost.** No incident in the repo traces to a
bad name. It is worth fixing because it is the substrate the other two fixes are
built on — a bounded-retry rule and a safe worktree lifecycle each need a
testable home — but it is not, on its own, the justification for v2.

### 1.4 What v2 is therefore for

1. **Bound the cost of failure.** No task can burn 3.4 hours.
2. **Make the failure modes regression-proof.** Every incident above becomes a
   test that fails if the bug returns.
3. **Make the code composable** so 1 and 2 have somewhere to live.

Skill-body token reduction is **not** a headline. Measured: all skill bodies
total ~4,850 tokens and reduce to ~2,580 — a 47% cut of a small number. The two
flagship skills barely move because their content is irreducible judgment.

## 2. Method

Behaviors are defined first, working backwards from a goal to the primitives it
needs. Then:

- **Behaviors decide the topics.** A topic is a set of behaviors over one subject.
- **Topics decide the names.** A name states the behavior in the topic's language.
- **Names decide the readability.** A reader follows the flow without opening bodies.
- **Readability decides debuggability.** When it breaks, the failing line names itself.

Nothing is named before its behavior is stated. No file is written before its
behavior is in the catalog and its test is written.

### 2.1 Worked example

To invoke `tackle-tasks [N..] valid` I need `[N..]`, the unblocked task numbers.
To get those I need the unblocked tasks; for those, all tasks; for those, the
parsed registry; to parse it, the file; to find the file, the `.taskTools/`
folder; for that, the repo root; for that, the working directory.

Forwards, that is the script:

```ts
const cwd             = getCurrentWorkingDirectory();
const repoRoot        = findGitRepositoryRootAbove(cwd);
if (!checkIsGitRepository(repoRoot)) throw new Error(`no git repository above ${cwd}`);
const taskToolsFolder = getTaskToolsFolderPath(repoRoot);
const tasksJsonPath   = getTasksJsonPath(taskToolsFolder);
const parsedTasks     = parseTasksJson(getFileText(tasksJsonPath));
const allTasks        = getAllTasks(parsedTasks);
const unblockedTasks  = filterUnblockedTasks(allTasks);
const taskNumbers     = getTaskNumbers(unblockedTasks);
printLines(taskNumbers);
```

Every variable states what it holds; every function states what it does.

## 3. Conventions

Rules, not preferences. A reviewer rejects code that breaks them.

### 3.1 One behavior per file

`scripts/library/<topic>/<behaviorName>.ts` exports exactly one behavior, named
the same as the file. Helpers private to that behavior live in the same file and
are not exported. If two behaviors need the same helper, that helper is itself a
behavior and gets its own file.

### 3.2 Naming

`get` is the default verb for reading a value. Other verbs are used when `get`
cannot express the action:

| Verb | Means |
|---|---|
| `get` | returns a value (default reader) |
| `find` | searches; may not find it; returns `null` when absent |
| `filter` | narrows a collection, returns the same kind |
| `build` | constructs a value from parts, touching nothing external |
| `parse` | text in, structure out |
| `write` | persists to disk |
| `run` | executes a subprocess |
| `check` | returns a boolean, nothing else |
| `assert` | throws when violated, returns `void` |
| `print` | writes to stdout — CLI layer only |
| `exit` | terminates the process — CLI layer only |

- Every exported name begins with one of these verbs.
- Names state the subject in full: `getTaskNumbers`, not `getNumbers`.
- No abbreviations: `getRepositoryRoot`, not `getRepoRoot`.
- `check*` reads as a question: `checkIsGitRepository`, `checkTaskIsUnblocked`.
- `find*` may return `null`; `get*` always produces a value.

### 3.3 Failure

Library behaviors return or throw. They never call `process.exit`, and never
write to stdout or stderr.

| Situation | Behavior does |
|---|---|
| Expected absence — file not present, task not found | returns `null` / `[]` |
| Present but malformed — corrupt JSON, bad schema | **throws** |
| Caller passed something invalid | throws |
| Broken invariant | throws, via an `assert*` behavior |
| Environment unusable — no git repository | throws |

**Missing and corrupt are different cases.** The first draft conflated them and
was self-contradictory: it declared a missing file "expected absence → `[]`" in
this table while requiring a throw in the prose. Since 8 of 10 callers of
`readTaskFile` never seed the registry first, throwing on a missing file would
break every one of them on a fresh project — including the zero-token
`view-task` hook.

So, precisely:

- `tasks.json` absent → `[]`. A project with no backlog yet is normal.
- `tasks.json` present but unparseable → throw. A corrupt backlog silently
  reading as empty is how a backlog gets skipped instead of repaired.
- `tasks.json` present, parses, but is not an array → throw.

Only `scripts/cli/*` catches, prints, and exits:

```ts
try {
  printLines(/* composed library behaviors */);
} catch (error) {
  exitWithError(error);
}
```

### 3.4 Layout

```
scripts/
  library/<topic>/<behaviorName>.ts   behaviors; no terminal I/O, no process.exit
  cli/<commandName>.ts                arg parsing, printing, exit codes
tests/
  library/<topic>/<behaviorName>.test.ts
  cli/<commandName>.test.ts
```

No script stays at `scripts/` root.

### 3.5 Composition over prose

A `SKILL.md` body carries only what a model must decide. Anything deterministic
is a CLI command. Where a skill's prose describes a procedure — "read tasks.json,
find the ones where X, then do Y" — that procedure is a missing script.

**What this cannot remove**, and the plan does not pretend otherwise: commit
message authoring, task-relevance verification against git history, the
interview in `goal-tasks`, semantic dedup in `update-tasks`, and
orchestrator-vs-worker role instructions. These are model judgment and stay as
prose. §7 includes topics for the data those judgments consume, not for the
judgments themselves.

## 4. Goals

### Lifecycle

| Goal | The user wants |
|---|---|
| `create-task` | add one task, fields filled in |
| `goal-tasks` | goal → requirements → spec → ordered tasks |
| `update-tasks` | harvest open items from pipeline output into new tasks |
| `update-task-files` | backfill missing fields across every task |
| `tackle-tasks [N..]` | implement the named tasks, scheduled safely |
| `tackle-pipeline N` | carry one task from spec to merged |
| `tackle-unblocked-tasks` | implement every unblocked task |
| `run-task-loop` | keep going until the backlog is empty |
| `close-tasks` | archive finished tasks, release what they blocked |

### Auxiliary

| Goal | The user wants |
|---|---|
| `pick-a-task` | choose the N easiest open tasks (task 43 revisits) |
| `task-stats` | counts, coverage, velocity |
| `view-task` | one task, human-readable — hook-answered, zero tokens |

### Hooks

| Event | Purpose |
|---|---|
| `UserPromptSubmit` | intercept `/view-task` and answer directly |
| `PostToolUse` | flag turn modified; reflow comments; run related tests |
| `Stop` / `SubagentStop` | stage changes and summarize |
| `SessionEnd` | prune stale session files |

## 5. tackle-tasks and tackle-pipeline

### 5.1 The split

**`tackle-pipeline N`** is the unit of work for one task in one working tree:
spec → plan → verify plan → implement → run tests → fix tests → approve → merge.
It **receives** its working tree; it does not create one.

**`tackle-tasks [N..]`** is the scheduler. It partitions by declared-file
overlap, provisions worktrees, and invokes `tackle-pipeline` per task:

- Tasks sharing no declared file: **parallel, each in its own worktree**.
- Tasks sharing a declared file: **serial, in one shared worktree**.

### 5.2 Phase mapping from v1

v1 has four phases; v2 has eight. The mapping is explicit so nothing is lost:

| v1 phase | v2 phase(s) | Note |
|---|---|---|
| Plan | spec, plan | spec is new: brief written per task |
| — | **verify plan** | new (task 41) |
| Implement | implement | |
| — | **run tests, fix tests** | new (task 41); v1 left this to worker prose |
| Typecheck | folded into run tests | v1's report-only typecheck agent per worktree |
| — | **present for approval** | new; v1 approved implicitly at merge |
| Merge | merge | |

`npx tsc --noEmit` is v1's hardcoded default (`prepareTasks.ts:33`) with no
discovery and no flag that sets it. v2 keeps the default and adds discovery from
`package.json` scripts, via the `tests` topic.

### 5.3 Task outcomes

Every task ends in exactly one state. v1 has these and the first draft omitted
them entirely.

| Outcome | Meaning | Scheduler does |
|---|---|---|
| `complete` | implemented, tests green | merge |
| `partial` | progress made, not finished | requeue **once**, then `blocked` |
| `blocked` | cannot proceed | report, do not merge |
| `needsClarification` | planner has a question for the user | skip implement, surface question |
| `notRelevant` | task no longer applies | report, propose closing |
| `conflict` | merge failed | report with git's reason |

### 5.4 Bounded retry — the §1.1 fix

Requeue is capped on **both** axes:

- **Attempts**: one requeue, as v1 (`requeueCount`).
- **Wall-clock**: a per-task ceiling. On exceeding it the task is terminated and
  reported `blocked` with the elapsed time, whatever partial work exists is
  committed, and the run continues.

Default ceiling: **20 minutes per task attempt**, ~1.4× the measured 14.1 min
average. Configurable per run. Task 16 would have been cut at 20 minutes instead
of 201.7, returning 3 hours to the run.

The ceiling is enforced by the scheduler, not the worker — a stuck worker cannot
be trusted to time itself.

### 5.5 Merge and conflicts

v1 merges once **per group** after every task in that group finishes.
**v2 merges per task.** This is a deliberate change, not a description of
current behavior:

- A task whose work is committed merges even if a later task in its worktree fails.
- A conflict is attributed to the task that caused it.

`mergeTaskWorktrees.ts`'s `resolveGitlinkConflicts` auto-resolves **submodule
gitlink conflicts only** and aborts on anything else. v2 keeps that contract
exactly: gitlink conflicts resolve, content conflicts abort and report git's
error text (the `482f1c5` fix).

### 5.6 Worktree lifecycle

Four behaviors, each with a test encoding a past incident:

1. **Create** — `git worktree add`, then initialize submodules, because
   `worktree add` leaves submodule directories empty (`prepareTasks.ts:102-109`).
2. **Reuse** — when a worktree exists from an earlier run it holds that run's
   commits; reset it onto the current source-branch tip rather than deleting it
   (`prepareTasks.ts:114-120`).
3. **Remove — non-destructive only.** Never `git worktree remove --force`. Task 1
   records that force-removal destroyed committed submodule work. Removal
   proceeds only when the worktree is clean and its branch is merged; otherwise
   it is left in place and reported.
4. **Prune** — the accumulation problem task 1 accepted and never solved. A
   worktree whose branch is fully merged and whose tree is clean is removable
   safely. Anything else is listed for the user, never auto-deleted.

Behavior 3's test is the one that matters: **it must fail if `--force` returns.**

### 5.7 Run identity and metrics

`runId`, `startTimestamp`, and `argumentsHash` are stamped once per run by the
scheduler and consumed once at the end (`tackleMetrics.ts` →
`plans/tackle-metrics.jsonl`). v2 keeps the format so historical runs stay
comparable, and **adds per-task duration and outcome**, without which §5.4's
ceiling cannot be tuned and §1.1's evidence could not have been gathered.

### 5.8 Return contract

`tackle-tasks` returns, and `SKILL.md` presents:

```
{ runId, tasks: [{ taskNumber, outcome, durationMs, worktree,
                   commitHashes, conflictReason?, question? }],
  merged[], conflicts[], blocked[], needsClarification[], notRelevant[] }
```

`tackle-pipeline` returns one element of `tasks`.

### 5.9 Standalone tackle-pipeline

`tackle-pipeline N` in the current tree, with no worktree, is supported with
**stated limits**. The audit found four things the scheduler supplies that a
standalone run does not have:

| Need | Standalone behavior |
|---|---|
| task brief | pipeline writes its own via the same behavior |
| merge target | no group branch exists; commits to the current branch, no merge step |
| runId / metrics | generates its own runId; records a single-task run |
| typecheck command | resolves via the same discovery behavior |

Standalone mode therefore skips the merge phase. That is a documented
difference, not an accident.

## 6. difficulty

An integer 1–5 on each `tasks.json` entry.

### 6.1 The formula

Derived at creation from countable facts. Points sum, then clamp to 1–5:

| Fact | Points |
|---|---|
| each declared file beyond the first | +1 (max +3) |
| declared files span more than one directory | +1 |
| any declared file already exists and exceeds 200 lines | +1 |
| task has one or more blockers | +1 |
| description mentions a schema, protocol, or migration | +1 |
| every declared file is new | −1 |

Floor 1, ceiling 5. The agent may override with a stated reason; the override is
recorded so a later backfill does not recompute it away.

This formula is a starting point, deliberately crude, and expected to be tuned
once per-task durations from §5.7 give it something to correlate against.

### 6.2 The split rule

A task rating 4 or 5 is not written. `create-task` requires the agent to propose
a decomposition into smaller tasks, chaining `blockedBy` where order matters,
and writes those instead.

### 6.3 Absence

Tasks without `difficulty` — every existing task, and every task in other repos
— are valid. Readers treat absent as unrated. `pick-a-task` sorts unrated last.
`update-task-files` backfills them.

### 6.4 Shared mechanism

One behavior fills a task's missing fields given `taskNumber`, `title`, and
`description`. `create-task` applies it to one task; `update-task-files` applies
it to all. Cardinality lives in the skill.

### 6.5 Schema

`skills/create-task/template/taskTemplate.json` gains the field. A task is
created to add it, and task 43's `blockedBy` is wired to that task.

## 7. Topics

| Topic | Subject | Depends on |
|---|---|---|
| `paths` | working directory, repo root, `.taskTools/`, registry paths | — |
| `files` | reading and writing text and JSON | — |
| `registry` | parsing both registries, getting all tasks, writing back | paths, files |
| `task` | one task's fields, including difficulty | — |
| `tasks` | collections — find by number, get numbers, sort, filter | task |
| `blockers` | open blockers, unblocked filtering, releasing on close | tasks |
| `difficulty` | computing a rating, the split threshold | task |
| `creation` | next number, building, validating, appending | registry, task, difficulty |
| `closure` | building a completed record, moving between registries | registry, blockers |
| `grouping` | declared-file overlap, union-find, partitions | tasks |
| `git` | running git, branches, submodules, snapshots | — |
| `worktrees` | paths, branch names, create, reuse, remove, prune, merge | git |
| `session` | hook payload, session flag files, staging, pruning | files |
| `reflow` | comment reflow and its session quota | files, session |
| `tests` | locating related tests, running them, test policy | paths, git |
| `pipeline` | briefs, phases, outcomes, retry ceiling, run state | worktrees, tests |
| `stats` | counts, velocity, contention, formatting | tasks |

Build order is a topological sort of this table: `paths`, `files`, `task`, `git`
→ `registry`, `tasks` → `blockers`, `difficulty`, `grouping`, `session` →
`creation`, `closure`, `worktrees`, `reflow`, `tests`, `stats` → `pipeline`.

`session` is new in this revision. `turn-modified-flag`, `stage-and-summarize-stop`,
and `session-end-cleanup` read hook stdin and read/write flag files under
`~/.claude/turn-flags/`; the first draft had no topic that owned them.

## 8. Behavior catalog

Written before any code. Per behavior: what it does in one sentence; its topic;
its verb-first name; its signature including the absent case; what it throws and
when; and its status — `exists`, `rename`, `extract`, `duplicate`, or `missing`.

Stored at `plans/behavior-catalog.csv`, same shape as `plans/rename-map.csv` so
the two join on name.

The catalog is reviewed and names corrected **before** library code is written.

### 8.1 Mapping existing code

`plans/rename-map.csv` inventories all 255 functions. A `behavior` column is
added stating what each does. Mapping each to a catalog behavior surfaces the
two questions: behaviors that exist but are poorly named (rename), and behaviors
the goals need that nothing implements (write). Functions mapping to no goal are
deleted, not moved.

### 8.2 Duplicates

Verified by audit. The first draft's counts were wrong in three rows; these are
the corrected figures.

| Behavior | Copies | Sites |
|---|---|---|
| run a git command | 8 | `repositoryBranches:10`, `repositoryIntegration:23`, `operationBranches:8`, `occurrenceTreeDelta:53`, `runFinalizer:48`, `runConsolidation:55`, `recoveryRefs:11`, `mergeTaskWorktrees:29` |
| read the hook payload from stdin | **6** | `session-end-cleanup:22`, `stage-and-summarize-stop:7`, `turn-modified-flag:7`, `reflow-comments-post:5`, `relatedTests:152`, `viewTaskHook:34` |
| get a task's still-open blockers | **4** | `taskStats:24`, `checkBlockers:15`, `prepareTasks:35`, `runStartup:12` |
| load both registries for a cwd | 4 | `getTaskDetails:15`, `viewTaskHook:42`, `taskStats:105`, `nextTaskNumber:6` |
| get a task's declared files | **2** | `taskGroups:13`, `prepareTasks:78` |
| union-find root / merge | 2 each | `taskGroups:17,23`, `canonicalTaskGroups:24,30` — byte-identical |
| find a task by number | 2 | `getTaskDetails:7`, `viewTaskHook:24` |

Corrections from the first draft: hook payload was 6 not 5 (`viewTaskHook:34`
missed); open blockers is 4 not 5 (the claimed fifth site does not exist);
declared files is 2 not 3 (`canonicalTaskGroups` *imports* it from
`taskGroups.ts:4`, it does not reimplement it).

**Deferred:** build a path snapshot exists twice with different hash algorithms —
sha256 at `occurrenceTreeDelta:91-131`, sha1 at `ownershipSnapshots:17-45`.
Unifying changes at least one module's digests. Both are out of scope (§11).

### 8.3 Dead code

- `scripts/hookOverride.ts` — 45 lines, 5 functions, imported only by its test.
- `scripts/getUnblockedTaskNumbers.ts` — 4 lines, reads the registry, never
  prints, imports two symbols unused.
- `validateRunAuthorization` (`runConsolidation:172`) — a wrapper calling
  `runFinalization(token, digest, () => undefined)`. (The first draft called it
  "same-signature"; it is not — 2 params vs 3.)

Deleted, not ported.

## 9. Tests

The mechanism that makes §1.2's failures regression-proof. The first draft gave
this one line; it is the load-bearing part of the plan.

### 9.1 There is no way to run the suite today

`package.json` has no `scripts` block. There is no CI, no Makefile. `README.md`
documents running one file at a time. "Full suite green" was ungateable.

**First commit of v2**: add `"test": "node --test tests/"` and
`"typecheck": "npx tsc --noEmit"` to `package.json`. Nothing else can be
verified until this exists.

### 9.2 Migrating 50 existing test files

`tests/` holds 50 `*.test.ts`, one per script subject. When a script splits into
several behaviors, its test splits with it.

Rule: **a topic's tests move in the same commit as the topic's code.** The suite
is green at every commit boundary — never a window where `node --test` is red.

For each migrated topic: existing assertions are preserved verbatim where the
behavior is unchanged, and rewritten only where §3.3's missing-vs-corrupt
distinction changes them.

### 9.3 Parity

Renaming and moving 255 functions can silently change behavior. Before a topic
migrates, its existing tests must pass against the new implementation
**unmodified except for the import path**. A test that needs its assertions
changed marks a behavior change, which must be deliberate and recorded in §13.

### 9.4 Incident tests

Each recorded failure becomes a test that fails if the bug returns:

| Incident | Test |
|---|---|
| Task 1 — teardown destroyed submodule commits | removing a worktree with unmerged commits refuses; `--force` never used |
| `4ef2ad7` — TypeError aborted every merge | merge input builder is exercised with a realistic payload |
| `482f1c5` — merge failed with no reason | a failed merge's reported outcome contains git's error text |
| `3a92ec6` — ENOENT race in flag cleanup | cleanup of an already-deleted flag file succeeds |
| Task 40 — workers reported done untested | a task with failing tests cannot reach outcome `complete` |
| §1.1 — unbounded retry | a task exceeding the ceiling is terminated and reported `blocked` |

### 9.5 Coverage rule

One test file per behavior file. A behavior with no test does not merge.

## 10. Build sequence

1. **Worktree** `tackle-tasks-v2`; **`package.json` test and typecheck scripts** (§9.1).
2. **Behavior catalog** — all twelve goals decomposed. No code.
3. **Naming pass** — catalog and CSV reviewed, names corrected. Gate: names settled.
4. **Library, topic by topic** in §7's order. Each topic: behaviors, their tests,
   and the migration of that topic's existing tests, in one commit. Suite green
   at every boundary.
5. **CLI** under `scripts/cli/`, each a `try`/`catch` composing behaviors.
6. **Callers** — every `!` command in every `SKILL.md`, every `command` in
   `hooks/hooks.json`, `.claude-plugin/plugin.json`, `marketplace.json.devblock`,
   `README.md`.
7. **Skills** reduced to surviving judgment.
8. **Verification** — §12.

## 11. Scope

Scope is **computed, not asserted**: the transitive closure of imports from every
script invoked by a `SKILL.md` `!` command or a `hooks/hooks.json` command, plus
scripts spawned at runtime by the workflow.

14 roots. **25 modules in scope**, 26 unreachable.

In scope: `archiveProcessed`, `checkBlockers`, `extractOpenSections`,
`getTaskDetails`, `nextTaskNumber`, `prepareTasks`, `reflow-comments-post`,
`reflowComments`, `reflowQuota`, `relatedTests`, `repositoryBranches`,
`repositoryGraph`, `repositoryManifest`, `resolutionRequests`,
`session-end-cleanup`, `stage-and-summarize-stop`, `taskFiles`, `taskGroups`,
`taskStats`, `testPolicy`, `turn-modified-flag`, `unblockDependents`,
`viewTaskHook`, plus `mergeTaskWorktrees` and `tackleMetrics`.

The last two appear in no static import graph — the workflow spawns them by path
(`prepareTasks.ts:70`, `mergeScriptPath()`). Any future runtime-spawned script
must be added to this list by hand; the closure will not find it.

### 11.1 Correcting the first draft

The first draft declared `repositoryGraph`, `repositoryManifest`, and
`resolutionRequests` out of scope and unreachable. **They are reachable.**
`relatedTests.ts` — a live, enabled `PostToolUse` hook — calls
`getOwningOccurrence` (line 92), `discoverTestPolicy` (line 116), and
`createEmptyResolutionManifest` (line 159). `testPolicy.ts` imports
`resolutionRequests.ts` too.

They are in scope. The boundary moved to follow the evidence.

### 11.2 Out of scope

The 26 unreachable modules — `runFinalizer`, `runConsolidation`, `recoveryRefs`,
`syncReceipts`, `syncVerification`, `occurrenceSync`, `occurrenceTreeDelta`,
`repositoryDiscovery`, `repositoryIntegration`, `ownershipKeys`,
`ownershipSnapshots`, `operationBranches`, `occurrenceBranchNames`,
`baseReconciliation`, `baseBranchResolution`, `logicalRepository`,
`submoduleUrlIdentity`, `gitlinkReader`, `legacyManifest`, `canonicalTaskGroups`,
`runAuthorization`, `runStartup`, `hookOverride`, `getUnblockedTaskNumbers`,
`approvalGate`, `approvalReadiness` — serve task 35's cutover, which has not
happened. They stay at `scripts/` root until then.

### 11.3 Open tasks are not touched

Tasks 32–39, 41, and 43 stay exactly as they are. Another agent is implementing
them concurrently.

### 11.4 Known collision

v2 relocates six scripts that open tasks declare: `taskFiles.ts`,
`taskGroups.ts`, `checkBlockers.ts`, `prepareTasks.ts`, `mergeTaskWorktrees.ts`,
`repositoryBranches.ts`. Task 35 declares four of the six.

This arrives whether or not v2 edits those entries, because v2 moves the files.
Mitigation: v2 merges to the base branch **as a single squashed change after the
other agent's in-flight tasks land**, with v2's layout as the target. Tasks
37/38/39/41 describe v1 implementations of behaviors v2 defines differently;
whether they close as superseded is decided after v2 lands.

### 11.5 Cross-project migration

Other repos load taskTools via `--plugin-dir` and get whatever is on disk. There
is no version pin, so a half-migrated branch breaks every consuming project at
once.

- v2 lands as one squashed commit. There is no half-migrated state on the branch
  other repos track.
- `.claude-plugin/plugin.json` version goes **0.1.0 → 0.2.0**; its description
  and `skills` list are updated to all twelve goals.
- Existing `tasks.json` files in other repos are valid unchanged. `difficulty` is
  optional (§6.3); no backfill is required for a project to keep working.

## 12. Done

v2 is done when all hold:

1. `npm test` green; `npm run typecheck` clean.
2. Every behavior file has a test file (§9.5).
3. Every incident test in §9.4 exists and passes.
4. Parity (§9.3) holds, or each divergence is recorded in §13.
5. Every one of the twelve goals invoked once end to end against a real backlog.
6. A run against ≥3 tasks recorded in `plans/tackle-metrics.jsonl` with per-task
   durations, and no task exceeding the §5.4 ceiling.
7. `grep -r "scripts/" skills/ hooks/ README.md .claude-plugin/` returns no path
   that does not exist.

**Rollback**: v2 is one squashed commit on its own branch. Reverting it restores
v1 wholesale. The branch is not merged until 1–7 hold.

## 13. Deliberate behavior changes

Every place v2 behaves differently from v1, recorded so a parity failure can be
distinguished from a regression.

| Change | From | To | Why |
|---|---|---|---|
| corrupt registry | returns `[]` | throws | a corrupt backlog must not read as empty (§3.3) |
| missing registry | returns `[]` | returns `[]` | unchanged — 8 callers depend on it |
| merge granularity | per group | per task | a finished task should not be held by a failing sibling (§5.5) |
| retry bound | attempts only | attempts **and** wall-clock | task 16 burned 3.4h (§5.4) |
| worktree removal | `--force` available | never forced; refuses unclean | task 1 destroyed committed work (§5.6) |
| metrics | per run | per run **and** per task | the ceiling cannot be tuned without it (§5.7) |
| typecheck command | hardcoded | discovered, same default | §5.2 |

## 14. Repository state

At `117073b` on `new-usage-graph`, 2026-08-04. These drift — another agent is
landing work concurrently. Recompute rather than trust.

- 51 scripts, 4253 lines, 50 test files.
- `plans/rename-map.csv`: 255 function rows.
- 10 open tasks: 32–39, 41, 43.
- 8 live worktrees: `task-group-1`…`task-group-6`, `pipeline-rebuild`,
  `resilient-jumping-meadow`.
- `package.json`: no `scripts` block.

### 14.1 First-draft claims corrected here

| Claim | Was | Is |
|---|---|---|
| script count | 49 | 51 |
| line count | 4044 | 4253 |
| function count | ~190 | 255 |
| open tasks | "15": listed 16 | 10 |
| hook-payload duplicates | 5 | 6 |
| open-blocker duplicates | 5 | 4 |
| declared-files duplicates | 3 | 2 |
| `repositoryGraph`/`repositoryManifest`/`resolutionRequests` | out of scope | **in scope** |
| §3.3 missing file | throws (contradicting its own table) | returns `[]` |
| `validateRunAuthorization` | "same-signature wrapper" | wrapper, different signature |
