# tackle-tasks-v2 — design

Rebuild taskTools as a composable library with thin skills. Built on its own
worktree, branch `tackle-tasks-v2`.

## 1. Why

`tasks.json` is the backlog for a project. taskTools' skills and scripts are the
mechanism that manages that backlog. Today that mechanism is carried mostly by
prose inside `SKILL.md` bodies: an agent reads paragraphs describing a
deterministic procedure, then performs it by hand. Prose is slow, costs tokens
every invocation, and produces a different result each time.

Everything deterministic becomes a script. Skills keep only the judgment that
genuinely needs a model.

A second problem compounds it: the ~190 functions across 49 scripts are named
inconsistently, several are duplicated up to eight times, and many names are
nouns that state no behavior — `declaredFiles`, `openBlockersOf`, `classify`.
Code that does not say what it does cannot be composed with confidence, because
the composer has to read the body first.

## 2. Method

Behaviors are defined first, working backwards from a goal to the primitives it
needs. Then:

- **Behaviors decide the topics.** A topic is a set of behaviors over one subject.
- **Topics decide the names.** A name states the behavior, in the topic's language.
- **Names decide the readability.** A reader intuits the flow without opening bodies.
- **Readability decides debuggability.** When it breaks, the failing line names itself.

Nothing is named before its behavior is stated. No file is written before its
behavior is in the catalog.

### 2.1 Worked example

The method, applied to "run `tackle-tasks` against every unblocked task."

Work backwards. To invoke `tackle-tasks [N..] valid` I need `[N..]`, the
unblocked task numbers. To get those I need the unblocked tasks. To get those I
need all tasks. To get those I need the parsed registry. To parse it I need the
file. To find the file I need the `.taskTools/` folder. To find that I need the
repo root. To find that I need the working directory.

Forwards, that is the script:

```ts
const cwd             = getCurrentWorkingDirectory();
const repoRoot        = findGitRepoRootAbove(cwd);
if (!checkIsGitRepo(repoRoot)) throw new Error("no git repository above " + cwd);
const taskToolsFolder = getTaskToolsFolderPath(repoRoot);
const tasksJsonPath   = getTasksJsonPath(taskToolsFolder);
const parsedTasks     = parseTasksJson(readFileText(tasksJsonPath));
const allTasks        = getAllTasks(parsedTasks);
const unblockedTasks  = filterUnblockedTasks(allTasks);
const taskNumbers     = getTaskNumbers(unblockedTasks);
printLines(taskNumbers);
```

Every variable states what it holds. Every function states what it does. No
comment is needed, and no body has to be opened to follow it.

## 3. Conventions

These are rules, not preferences. A reviewer rejects code that breaks them.

### 3.1 One behavior per file

`scripts/library/<topic>/<behaviorName>.ts` exports exactly one behavior, named
the same as the file. Helper functions private to that behavior may live in the
same file and are not exported.

If two behaviors want the same helper, the helper is itself a behavior and gets
its own file.

### 3.2 Naming

`get` is the default verb for reading a value — from memory, from disk, from a
process. It is the general reader and needs no justification.

Other verbs are used when `get` cannot express the action:

| Verb | Means |
|---|---|
| `get` | returns a value (default reader) |
| `find` | searches; may not find it; returns `null` when absent |
| `filter` | narrows a collection, returns a collection of the same kind |
| `build` | constructs a new value from parts, touching nothing external |
| `parse` | text in, structure out |
| `write` | persists to disk |
| `run` | executes a subprocess |
| `check` | returns a boolean, nothing else |
| `assert` | throws when the condition is violated, returns `void` |
| `print` | writes to stdout — CLI layer only |
| `exit` | terminates the process — CLI layer only |

Rules:

- Every exported name begins with one of these verbs.
- A name states the subject in full. `getTaskNumbers`, not `getNumbers`.
- No abbreviations. `getRepositoryRoot`, not `getRepoRoot`.
- Boolean-returning behaviors begin with `check` and read as a question:
  `checkIsGitRepo`, `checkTaskIsUnblocked`.
- A behavior that can fail to find something uses `find` and returns `null`.
  A behavior that always produces a value uses `get`.

### 3.3 Failure

Library behaviors return or throw. They never call `process.exit`, and they
never write to stdout or stderr.

| Situation | Behavior does |
|---|---|
| Expected absence | returns `null` (single) or `[]` (collection) |
| Caller passed something invalid | throws `Error` |
| Broken invariant | throws, via an `assert*` behavior |
| Environment unusable | throws |

Only `scripts/cli/*` catches, prints, and exits. Every CLI entry point has the
same shape:

```ts
try {
  // compose library behaviors
  printLines(result);
} catch (error) {
  exitWithError(error);
}
```

**Behavior change this introduces:** `readTaskFile` today swallows every error
and returns `[]`, so a corrupt `tasks.json` reads as an empty backlog. Under
this rule it throws. A corrupt backlog must fail loudly — silently reporting
zero tasks is how a backlog gets skipped instead of repaired.

### 3.4 Layout

```
scripts/
  library/<topic>/<behaviorName>.ts   pure behaviors, no I/O to the terminal
  cli/<commandName>.ts                arg parsing, printing, exit codes
```

CLI entry points move into `scripts/cli/`. Every caller is updated: the `!`
commands in each `SKILL.md`, and every `command` in `hooks/hooks.json`. No
script stays at `scripts/` root.

### 3.5 Composition over prose

A `SKILL.md` body carries only what a model must decide. Anything deterministic
is a CLI command the skill invokes. When a skill's prose describes a procedure —
"read tasks.json, find the ones where X, then do Y" — that procedure is a
missing script.

## 4. Goals

Twelve goals. Eight are the task lifecycle; four are auxiliary.

### Lifecycle

| Goal | The user wants |
|---|---|
| `create-task` | add one task to the backlog, fields filled in |
| `goal-tasks` | turn a stated goal into requirements, a spec, and ordered tasks |
| `update-tasks` | harvest open questions and incomplete items from pipeline output into new tasks |
| `update-task-files` | backfill missing fields across every task in the backlog |
| `tackle-tasks [N..]` | implement the named tasks, scheduling them safely |
| `tackle-pipeline N` | carry one task from spec to merged |
| `tackle-unblocked-tasks` | implement every unblocked task |
| `run-task-loop` | keep going until the backlog is empty |
| `close-tasks` | archive finished tasks and release what they blocked |

### Auxiliary

| Goal | The user wants |
|---|---|
| `pick-a-task` | choose the N easiest open tasks (see task 43) |
| `task-stats` | counts, coverage, velocity over the backlog |
| `view-task` | one task, human-readable — answered by hook, zero tokens |

### Hooks

| Event | Purpose |
|---|---|
| `UserPromptSubmit` | intercept `/view-task` and answer it directly |
| `PostToolUse` | flag the turn as modified; reflow comments; run related tests |
| `Stop` / `SubagentStop` | stage changes and summarize |
| `SessionEnd` | prune stale session files |

## 5. tackle-tasks and tackle-pipeline

The two are separate concerns and must not be merged.

**`tackle-pipeline N` is the unit of work.** For one task, in one working tree,
it runs: task spec → plan → verify plan → implement → run tests → fix tests →
present for approval → merge.

It **receives** its worktree; it does not create one. That keeps it runnable
standalone — `tackle-pipeline 43` in the current tree, no worktree at all — and
keeps worktree lifecycle in exactly one place.

**`tackle-tasks [N..]` is the scheduler.** It partitions the requested tasks by
declared-file overlap, provisions a worktree per partition, and invokes
`tackle-pipeline` once per task:

- Tasks that share no declared file run **in parallel, each in its own worktree**.
- Tasks that share a declared file run **serially in one shared worktree**.

### 5.1 Why overlap is never written to tasks.json

An earlier proposal recorded file collisions as `blockedBy` entries at creation
time. That is wrong and is explicitly rejected.

**Scheduling state is ephemeral; backlog data is durable.** Whether two tasks
collide is true of one moment in one working tree. Whether one task must precede
another is true of the project. `tasks.json` is the backlog — shared across
projects, read by humans, consumed by other tooling. It records only durable
facts.

Recording collisions there would also serialize the backlog permanently: in a
normal project a dozen tasks legitimately touch one large file, and a
collision-derived block only clears when the other task closes.

Overlap is computed at run time, used, and discarded.

### 5.2 Partial failure

`tackle-pipeline` commits at the end of its task. `tackle-tasks` merges
per-task, not per-worktree. When task 2 of 5 fails in a shared worktree, task 1
is already committed and mergeable, and task 2's debris does not block it.

## 6. difficulty

A new integer field on each `tasks.json` entry, 1–5. Small tasks are the goal:
quick for a subagent to implement, quick to review.

**Derived, then overridable.** `create-task` computes a rating from countable
facts — how many files the task declares, how many already exist versus are new,
the size of the existing ones, whether it spans multiple directories, whether it
has blockers. The agent may override the computed value when it knows better; a
one-file change to a 2000-line parser is harder than eight file renames.

**≥4 must be split.** `create-task` enforces this on write, because it is the
only writer. When a task rates 4 or 5, the agent proposes a decomposition into
smaller tasks and creates those instead, chaining `blockedBy` where order
matters.

**Existing tasks are backfilled by `update-task-files`**, which already walks
every task to fill missing fields. Filling `difficulty` is the same behavior
applied to a different field.

**Shared mechanism.** `create-task` and `update-task-files` both use one
behavior — fill in a task's missing fields, given `taskNumber`, `title`, and
`description`. `create-task` applies it to the one task it created;
`update-task-files` applies it to every task in the registry. The cardinality
lives in the skill; the behavior does not.

## 7. Topics

Derived from the behaviors the twelve goals need. Each is a directory under
`scripts/library/`.

| Topic | Subject |
|---|---|
| `paths` | working directory, repo root, `.taskTools/` folder, registry file paths |
| `files` | reading and writing text and JSON on disk |
| `registry` | parsing `tasks.json` / `completedTasks.json`, getting all tasks, writing back |
| `task` | one task's fields — number, title, description, files, handoffs, blockedBy, difficulty |
| `tasks` | collections — find by number, get numbers, sort, filter |
| `blockers` | open blockers, unblocked filtering, releasing blocked tasks on close |
| `difficulty` | computing a rating, checking the split threshold |
| `creation` | next number, building a record, validating, appending |
| `closure` | building a completed record, moving between registries |
| `grouping` | declared-file overlap, union-find, partitions |
| `worktrees` | paths, branch names, creating, removing, merging back |
| `pipeline` | briefs, phases, per-task run state |
| `git` | running git, branches, submodules, path snapshots |
| `stats` | counts, velocity, contention, formatting |
| `hooks` | reading the hook payload, emitting a decision |
| `reflow` | comment reflow and its session quota |
| `tests` | locating related tests, running them, test policy |

Phase-4 recursive-repository topics (`repository`, `occurrences`, `ownership`,
`refs`, `finalization`, `consolidation`, `recovery`, `receipts`, `resolutions`)
are **out of scope** — see §10.

## 8. Behavior catalog

The catalog is the deliverable that precedes any code. For each of the twelve
goals it states, working backwards, the behaviors that goal needs. Each entry
records:

- **behavior** — what it does, in one sentence, in terms a reader understands
  without the codebase
- **topic** — which directory it lives in
- **name** — verb-first, per §3.2
- **signature** — inputs and output, including what it returns when absent
- **failure** — what it throws and when
- **status** — `exists` (present, correctly named), `rename` (present, poorly
  named), `extract` (present but buried inside a larger function), `duplicate`
  (present N times), or `missing`

The catalog is reviewed and the names corrected **before** library code is
written. Renaming 200 files after the fact is the outcome this ordering exists
to avoid.

### 8.1 Mapping existing code

`plans/rename-map.csv` already inventories all ~190 existing functions with
`topic`, `currentName`, `proposedName`, `foundInFile`, `foundAtLine`,
`isDuplicate`, `duplicateOfFileAndLine`. A `behavior` column is added, stating
what each function does.

Mapping each existing function to a catalog behavior surfaces the two questions
that matter:

- **Behaviors that exist but are poorly named** — rename.
- **Behaviors the goals need that nothing implements** — write.

Functions that map to no goal are dead and are deleted rather than moved.

### 8.2 Known duplicates

Established by inventory. Each collapses to one behavior.

| Behavior | Copies | Sites |
|---|---|---|
| run a git command | 8 | `repositoryBranches:10`, `repositoryIntegration:23`, `operationBranches:8`, `occurrenceTreeDelta:53`, `runFinalizer:48`, `runConsolidation:55`, `recoveryRefs:11`, `mergeTaskWorktrees:29` |
| read the hook payload from stdin | 5 | `session-end-cleanup:22`, `stage-and-summarize-stop:7`, `turn-modified-flag:7`, `reflow-comments-post:5`, `relatedTests:152` |
| get a task's still-open blockers | 5 | `taskStats:24`, `checkBlockers:15`, `prepareTasks:35`, `runStartup:12`, plus the inline filter in `getUnblockedTaskNumbers` |
| load both registry files for a cwd | 4 | `getTaskDetails:15`, `viewTaskHook:42`, `taskStats:105`, `nextTaskNumber:6` |
| get a task's declared files | 3 | `taskGroups:13`, `prepareTasks:78`, and the reimplementation in `canonicalTaskGroups` |
| union-find root / merge | 2 each | `taskGroups:17,23` and `canonicalTaskGroups:24,30` — byte-identical |
| find a task by number, open then completed | 2 | `getTaskDetails:7`, `viewTaskHook:24` |

One collapse needs a decision rather than a mechanical merge: **build a path
snapshot** exists twice with *different hash algorithms* — sha256 in
`occurrenceTreeDelta:91-131`, sha1 in `ownershipSnapshots:17-45`. Unifying them
changes at least one module's digest values. Both sites are Phase-4 and
therefore out of scope; the decision is deferred with them.

### 8.3 Known dead code

- `scripts/hookOverride.ts` — 45 lines, 5 functions, no production importer.
  Only `tests/hookOverride.test.ts` references it.
- `scripts/getUnblockedTaskNumbers.ts` — reads the registry, never prints,
  imports two symbols it does not use.
- `validateRunAuthorization` (`runConsolidation:172`) — same-signature wrapper
  around `runFinalization` with a no-op mutate.

Dead code is deleted, not ported.

## 9. Build sequence

1. **Worktree.** Branch `tackle-tasks-v2`.
2. **Behavior catalog.** All twelve goals decomposed to primitives. No code.
3. **Naming pass.** Catalog and the `behavior`-column CSV reviewed; names
   corrected. Gate: names are settled before code.
4. **Library.** One behavior per file under `scripts/library/<topic>/`, with a
   test per behavior. Topics in dependency order: `paths` → `files` →
   `registry` → `task` → `tasks` → `blockers` → the rest.
5. **CLI.** Entry points under `scripts/cli/`, each a `try`/`catch` composing
   library behaviors.
6. **Callers.** Every `!` command in every `SKILL.md`, every `command` in
   `hooks/hooks.json`, updated to the new paths.
7. **Skills.** Bodies reduced to the judgment that remains, with the
   deterministic parts replaced by CLI invocations.
8. **Verification.** Full suite green, typecheck clean, every skill invoked
   once end to end.

Steps 2 and 3 are where the value is decided. They come first and are not
compressed.

## 10. Out of scope

**The Phase-4 recursive-repository machinery.** `repositoryDiscovery`,
`repositoryGraph`, `repositoryManifest`, `occurrenceSync`, `occurrenceTreeDelta`,
`ownershipKeys`, `ownershipSnapshots`, `runFinalizer`, `runConsolidation`,
`runAuthorization`, `recoveryRefs`, `syncReceipts`, `syncVerification`,
`resolutionRequests`, `operationBranches`, `baseReconciliation`,
`baseBranchResolution`, `logicalRepository`, `submoduleUrlIdentity`,
`gitlinkReader`, `legacyManifest`, `repositoryIntegration`.

None of it is reachable from any skill or hook today; those modules only
reference each other. It serves task 35, the production cutover, which has not
happened.

**Open tasks are not touched.** Tasks 25–36 and 42 (Phase 4) and tasks 37, 38,
39, 41 stay exactly as they are — entries, `files` arrays, and descriptions
unchanged. Another agent is implementing them in the background.

### 10.1 Known collision

v2 relocates six scripts that open tasks declare: `taskFiles.ts`,
`taskGroups.ts`, `checkBlockers.ts`, `prepareTasks.ts`, `mergeTaskWorktrees.ts`,
`repositoryBranches.ts`. Task 35 declares four of the six.

This conflict arrives whether or not v2 edits those task entries, because v2
moves the files. It is recorded here, not solved here. Resolution happens when
v2 and the Phase-4 work meet at merge, with v2's layout as the target.

Four tasks describe v1 implementations of behaviors v2 defines differently:

| Task | v2 equivalent |
|---|---|
| 37 | `tackle-unblocked-tasks` |
| 38 | `run-task-loop` |
| 39 | worktree-merge recovery |
| 41 | the verify and test phases inside `tackle-pipeline` |

They are left open. Whether they close as superseded is decided after v2 lands,
not now.

## 11. Repository state at time of writing

Recorded so a later reader knows what the ground looked like.

- Branch `new-usage-graph` at `117073b`.
- Eight live worktrees: `task-group-1` through `task-group-6`,
  `pipeline-rebuild`, `resilient-jumping-meadow`.
- Another agent active; commits for tasks 25 and 26 landed within the hour.
- 15 open tasks: 25, 26, 29–39, 41, 42, 43.
- 49 scripts, ~190 functions, 4044 lines under `scripts/`.
