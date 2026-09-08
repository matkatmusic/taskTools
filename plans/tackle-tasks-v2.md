# tackle-tasks-v2 — design

Rebuild taskTools as a composable, tested library with thin skills. Built on its
own worktree, branch `tackle-tasks-v2`.

This document was verified against the codebase by five independent audits. What
they found is recorded here rather than smoothed over — §13 lists every claim
the first draft got wrong.

**Preservation baseline:** updated 2026-08-06 against committed
`new-usage-graph` at `dc1ec9e`, including every production and skill change
since the previous `e55302d` audit. The recursive repository-discovery Phases
1–4 are now part of v2's foundation, not a parallel effort to ignore or replace.
Section 15 maps the newly landed v1 features to explicit v2 requirements.

The rule for later drift is simple: before implementation begins, recompute the
live entry points and the commits since `dc1ec9e`. A feature added to v1 after
this date is a preservation requirement unless a deliberate replacement is
recorded in §13. A stale scope inventory never authorizes deleting live behavior.

## 1. Why

`tasks.json` is the backlog for a project, used across several repos. taskTools'
skills and scripts are the mechanism that manages that backlog.

Three problems, ranked by the strength of the evidence behind them.

### 1.1 Unbounded retries (measured)

From committed `plans/tackle-metrics.jsonl` at `dc1ec9e`. The file now has
**43 records but only 39 distinct runIds** — see §1.1.1 — so both readings are
given:

| Reading | Runs | Tasks | Total | Mean |
|---|---|---|---|---|
| every record | 43 | 73 task mentions | 28.56 h | 23.5 min/task mention |
| first record per runId | 39 | 67 task mentions | 24.80 h | 22.2 min/task mention |

| Run | What happened | Duration |
|---|---|---|
| task 57 | recorded complete | **358.0 min (6.0 h)** |
| tasks 50+51 | one recorded done | **339.4 min (5.7 h)** |
| task 16 retry | duplicated with conflicting conflict counts | ~202 min (3.4 h) |
| task 48 | same runId recorded at 3.1 and 58.5 min | 58.5 min maximum |

The expanded data no longer supports the old statement that the longest run
"produced nothing": the two new longest records claim successful work. It does
show that whole-run wall time is both unbounded and poorly attributed. Nothing
in v1 enforces its prompt-level time budget, distinguishes active agent time
from queue/user-wait time, or places one task under a scheduler-controlled
deadline. A retry can therefore consume hours with no enforceable ceiling.

#### 1.1.1 The metrics file is itself unreliable

Four run IDs appear more than once. The two original duplicates remain:
`mse7zdrm-afo8cz07h0j` has different durations, and its `-r2` retry disagrees
on `conflictCount`. Two newer duplicates are more divergent:
`msfe7152-0efmewmrgoea` records task 48 first blocked at 8.9 minutes and then
done at 17.8; `msfjyz7e-ga870imnv3k` records it at both 3.1 and 58.5 minutes.

`appendRunMetricsRecord` appends without checking whether the runId is already
present and the schema does not say whether a later record replaces, updates,
or retries an earlier record. v2 fixes both (§5.7). Until then, aggregate means
are descriptive only and cannot justify a kill threshold.

### 1.2 Merge and worktree fragility (three recorded incidents)

- `4ef2ad7` — a `TypeError` in `mergeCliInput` aborted the merge step before any
  group merged.
- `482f1c5` — worktree merge/rebase failures with no error reason reported.
- `3a92ec6` — `ENOENT` race in `stage-and-summarize-stop`'s turn-flag cleanup.
- Task 1 (closed): worktree teardown **destroyed committed work** by deleting
  submodule commits on `git worktree remove --force`. The fix made teardown
  non-destructive and accepted, in its own words, that "worktrees now accumulate
  indefinitely since no cleanup path remains."

The committed log now contains 4 conflict counts across 4 records and 11 blocked
outcomes across 9 records, before deduplicating ambiguous run IDs.

### 1.3 Code that cannot be composed (no incident evidence)

The old exact inventory had 255 functions across 51 scripts. At `dc1ec9e` there
are 57 scripts and a rough declaration scan finds about 290 functions; the CSV
must be regenerated for an exact count. Duplicates remain up to eight deep and
names such as `declaredFiles`, `openBlockersOf`, and `classify` still require
reading bodies to understand composition.

**This is real but has no measured cost.** No incident in the repo traces to a
bad name. It is worth fixing because it is the substrate the other two fixes are
built on — a bounded-retry rule and a safe worktree lifecycle each need a
testable home — but it is not, on its own, the justification for v2.

### 1.4 What v2 is therefore for

1. **Bound the active cost of failure.** No task or repair loop can run without
   a scheduler-enforced deadline, while user/approval wait time remains pausable.
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

The inputs to that judgment are deterministic. In particular, commit-message
generation reads freshly staged diffs at invocation time through a script/skill
boundary; the main agent never supplies a previously captured diff snapshot.

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
| `merge-worktree-tasks` | discover leftover task worktrees and merge only the ones the user explicitly approves |

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
spec → plan → verify plan → implement → run tests → fix tests → approval
evidence. It **receives** its working tree; it does not create one and does not
publish repositories by itself.

**`tackle-tasks [N..]`** is the scheduler and whole-run coordinator. It completes
repository discovery before grouping, partitions by canonical logical effects,
provisions worktrees, invokes `tackle-pipeline` per task, presents one approval
gate, then drives one serialized recursive finalizer/publication pass:

- Tasks whose canonical logical effects do not overlap: **parallel, each group
  in its own worktree**.
- Tasks whose effects overlap through an alias occurrence or ancestor gitlink:
  **serial, in one shared group worktree**.
- Publication is never parallel per task. Every approved group is consolidated
  into one operation and one prepared integration OID per logical repository.

Current v1 proved an execution constraint that v2 must preserve: the workflow
sandbox cannot import shared JavaScript modules or run shell commands directly.
The five phase adapters (`plan`, `verify`, `implement`, `test`, and merge-unblock)
therefore remain self-contained workflow files. Deterministic state belongs in
the TypeScript library/CLI and each workflow calls agents only for judgment.

### 5.2 Phase mapping from v1

The earlier draft described an obsolete four-phase v1. Current v1 already has
the following split pipeline; v2 preserves it while moving validation and state
transitions into tested library behaviors:

| Current v1 phase | v2 contract | Preserved behavior |
|---|---|---|
| Plan | spec, plan | one plan per task; read permitted context; name the exact modifiable fence; no unresolved or conditional implementation steps |
| Verify | verify plan | read-only Codex review; fallback reviewer when unavailable; at most one repair and two reviews total; record the actual reviewer |
| Implement | implement | groups parallel, tasks serial inside a group; edit only owned files; run related tests; one partial requeue |
| Test/Fix | test, fix tests | report-only test pass followed by fixes routed to the original task and plan; default three rounds; emit machine-readable receipts |
| Approval | whole-run approval | present clarification, rejection, partial, blocked, tests, and review handoffs once; no finalization before approval |
| Merge unblock | diagnose after a failed merge run | distinguish tool blockers from user decisions; never decide destructive or semantic conflicts for the user |
| Finalize/publish | recursive finalizer CLI | children first; consolidate every occurrence/group; push allowed operation branches; CAS-publish bases; archive only published tasks |

The workflow adapters return explicit schemas and treat a missing agent result
as a named blocked/rejected outcome. The verifier records `reviewer`,
`revised`, and notes; test receipts and review handoffs flow unchanged into the
approval digest. A fallback verdict is never labelled as Codex.

`npx tsc --noEmit` remains the fallback typecheck command. v2 adds deterministic
discovery from repository configuration through the `tests` topic and records
the resolved command in the run manifest.

### 5.3 Task outcomes

Every task ends in exactly one state. v2 preserves current outcomes and adds
publication-qualified terminal results that the first draft omitted.

| Outcome | Meaning | Scheduler does |
|---|---|---|
| `complete` | implemented, tests green, published in every affected logical repository | archive after publication |
| `partial` | progress made, not finished | requeue **once**, then `blocked` |
| `blocked` | cannot proceed | report, do not merge |
| `needsClarification` | planner has a question for the user | skip implement, surface question |
| `notRelevant` | task no longer applies | report, propose closing |
| `rejected` | plan failed the bounded review/repair gate | report reviewer and final problems; do not implement |
| `conflict` | merge failed | report with git's reason |
| `publicationFailed` | finalization, push, CAS publication, or rollback did not complete | keep task open and report recovery refs/commands |

### 5.4 Bounded retry — the §1.1 fix

Retries and repairs are bounded independently:

- **Attempts**: one requeue, as v1 (`requeueCount`).
- **Wall-clock**: a per-task ceiling. On exceeding it the task is terminated and
  reported `blocked` with the elapsed time, whatever partial work exists is
  committed, and the run continues.
- **Local repair loops**: implementation and Test/Fix each default to three
  repair rounds. Exhaustion returns a red receipt or blocked result; it never
  silently converts failure to `done`.
- **Plan review**: at most two verdicts total, including Codex and any fallback.
  Only one reviewer-requested plan rewrite is allowed.

Initial safety target: **30 minutes of active agent execution per task attempt**,
configurable per run and shadow-measured before enforcement.

The old draft incorrectly justified 30 minutes from a 20.8-minute maximum. The
expanded log contains successful whole-run records of 58, 339, and 358 minutes,
but cannot separate agent execution from queue time, user/approval waits,
multiple phases, or finalization. Those records neither validate nor disprove a
30-minute *active-execution* ceiling.

Before the ceiling can block production work, §5.7 must record per-attempt active
duration, paused duration, phase, and termination reason. Run the proposed
ceiling in shadow mode against representative tasks, report which successful
attempts it would have killed, and either retain 30 minutes or change it with the
measured rationale recorded here. The shipped system must have a finite default;
the exact number is a measured cutover decision, not an assumption in a prompt.

The ceiling is enforced by the scheduler, not merely written in a worker prompt
— a stuck worker cannot be trusted to time itself. v2 must first prove that the
supported workflow timeout actually cancels the agent. If it only abandons the
result, use a cancellable subprocess/SDK boundary instead of `Promise.race`.

### 5.5 Merge and conflicts

The earlier v2 draft's "merge per task" design is superseded by the recursive
repository work that landed in v1. v2 uses one whole-run finalization path:

1. Preflight every group/occurrence with a ref-pure merge-tree check.
2. Refuse approval unless test receipts are green and review handoffs exist.
3. After approval, finalize logical children before parents and install the
   prepared child OIDs through explicit occurrence edges.
4. Consolidate every participating group and occurrence into one canonical
   operation OID and one prepared integration OID per logical repository.
5. Push only allowed canonical operation branches, never force-push.
6. Revalidate approval inputs and every recorded base OID.
7. Publish local base refs with compare-and-swap; roll back the whole run on a
   partial publication failure and retain exact recovery refs/commands.
8. Archive only explicit tasks whose every affected repository was published.

Content conflicts abort with repository-qualified paths and Git's reason. A
submodule pointer is not resolved by choosing an arbitrary side: normal
publication uses the prepared child integration OID. Legacy
`resolveGitlinkConflicts` remains only as a compatibility behavior for the
explicit leftover-worktree recovery interface until that interface is migrated.

`runMergePhase` remains the deterministic wrapper between orchestration and the
finalizer CLI. It reads step outputs from files, derives counts/receipts without
model transcription, treats non-zero exit, non-JSON stdout, and nonempty
conflicts as blocked, and supplies the exact failed command to the merge-unblock
workflow.

### 5.6 Worktree lifecycle

Four behaviors, each with a test encoding a past incident:

1. **Create** — use a run-scoped path containing repository identity, `runId`,
   and group ID; `git worktree add`, then initialize submodules because
   `worktree add` leaves their directories empty.
2. **Resume, never implicit reuse** — a fresh run never resets an existing
   worktree or branch. Explicit resume may reuse only the path recorded in the
   run manifest after validating repository, branch, OID, and cleanliness.
3. **Remove — non-destructive only.** Never `git worktree remove --force`. Task 1
   records that force-removal destroyed committed submodule work. Removal
   proceeds only when the worktree is clean and its branch is merged; otherwise
   it is left in place and reported.
4. **Prune** — the accumulation problem task 1 accepted and never solved. A
   worktree whose branch is fully merged and whose tree is clean is removable
   safely. Anything else is listed for the user, never auto-deleted.

Behavior 3's test is the one that matters: **it must fail if `--force` returns.**

Current v1 also has a `merge-worktree-tasks` recovery surface. v2 preserves its
user contract:

- Discover leftover taskTools worktrees with unmerged commits or uncommitted
  edits and match them to open tasks by owned-file overlap.
- Report unmatched worktrees instead of hiding them.
- Require explicit approval for each selected worktree.
- Merge only approved worktrees; preserve every conflicted or unapproved
  worktree for manual recovery.
- Report the limitation when nested repository content is not integrated.

The v2 implementation must bring this surface under the occurrence graph and
non-destructive cleanup rules; preserving the feature does not preserve v1's
remaining forced removal.

### 5.7 Run identity and metrics

`runId`, `startTimestamp`, and `argumentsHash` are stamped once per run by the
scheduler and consumed once at the end (`tackleMetrics.ts` →
`plans/tackle-metrics.jsonl`). v2 keeps the format so historical runs stay
comparable, and **adds per-task duration and outcome**, without which §5.4's
ceiling cannot be tuned and §1.1's evidence could not have been gathered.

Finalization records metrics exactly once on every terminal path. The metrics
writer rejects or replaces a duplicate `runId`; it never append-records the
same run twice as current v1 did. Run state also records phase, attempt, reviewer,
repair round, test receipts, approval digest, occurrence digests, publication,
rollback, and archival results.

### 5.8 Return contract

`tackle-tasks` returns, persists, and `SKILL.md` presents:

```
{ runId, tasks: [{ taskNumber, outcome, durationMs, worktree,
                   planFile?, reviewer?, testReceipts[], commitHashes,
                   publicationResults[], recoveryRefs[],
                   conflictReason?, question? }],
  reviewHandoffs[], occurrenceDigests[], approval,
  publicationTargets[], rollback[],
  merged[], conflicts[], blocked[], needsClarification[],
  rejected[], notRelevant[], publicationFailed[] }
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

### 5.10 Plan, test, and approval evidence

Current v1 added evidence that v2 must retain:

- `create-task` asks for an example test and stores it in `tests`; the literal
  `"skip"` is an explicit opt-out.
- Planning incorporates that example into concrete verification and expands it
  with relevant lower-level cases. Plans must name exact owned files and leave
  no discovery or design decision to the implementer.
- Implementation writes the user example first when present, runs typecheck and
  related tests, stages only the task's owned files, and cannot report `done`
  while a relevant test fails.
- The Test/Fix phase is report-only until a failure is assigned back to the task
  and plan that produced it. A fixer may correct a test only when it asserts
  behavior the approved plan did not require; it may not weaken or delete it.
- Codex is the primary plan reviewer. If unavailable rather than rejecting, the
  configured Claude fallback chain may review the identical prompt. The actual
  reviewer is recorded and included in `reviewHandoffs`.
- Approval digests include the repository manifest, owned paths, operation/base
  refs, occurrence tree digests, real test receipts, and review handoffs. Drift
  invalidates authorization.
- Missing agent results, red or missing receipts, missing review handoffs,
  clarification, rejection, partial work, and blocked work all prevent
  finalization.

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

`skills/create-task/template/taskTemplate.json` carries both `difficulty` and
`tests`. `create-task` asks the user for one example test before writing the
task, stores the answer verbatim, and stores `"skip"` when the user explicitly
opts out. Existing tasks without either field remain valid.

`pick-a-task` reads the stored `difficulty`, sorts ascending, breaks ties by
task number, and uses code inspection only to filter tasks that are no longer
relevant. It does not silently replace the recorded rating with fresh prose
judgment.

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
| `repository-graph` | occurrence manifest, recursive discovery, explicit parent/child edges, legacy routing | paths, git |
| `logical-repositories` | normalized upstream identity, repeated occurrences, reconciliation | repository-graph |
| `ownership` | canonical logical path effects, read/edit fences, recursive snapshots | tasks, logical-repositories |
| `grouping` | overlap of canonical ownership and ancestor-gitlink effects | ownership |
| `git` | running git, branches, submodules, snapshots | — |
| `worktrees` | run-scoped paths, branch names, create, resume, remove, prune, recovery discovery | git, repository-graph |
| `session` | hook payload, session flag files, staging, pruning | files |
| `reflow` | comment reflow and its session quota | files, session |
| `tests` | user examples, related tests, complete suites, test policy and receipts | paths, git, repository-graph |
| `review` | plan-review adapters, fallback attribution, repair limit, handoffs | files |
| `approval` | readiness, state digest, drift detection, authorization | tests, review, ownership |
| `consolidation` | child-first finalization and one operation/integration OID per logical repository | approval, logical-repositories |
| `publication` | operation push, CAS base updates, rollback, archival eligibility | consolidation, registry |
| `recovery` | durable refs, recovery commands, legacy refusal, leftover worktrees | worktrees, publication |
| `pipeline` | briefs, split phase adapters, outcomes, retry ceiling, run state | grouping, worktrees, tests, review, approval, publication, recovery |
| `stats` | counts, velocity, contention, formatting | tasks |

Build order is a topological sort of this table: `paths`, `files`, `task`, `git`
→ `registry`, `tasks`, `repository-graph` → `blockers`, `difficulty`,
`logical-repositories`, `ownership`, `session` → `creation`, `closure`,
`grouping`, `worktrees`, `reflow`, `tests`, `review`, `stats` → `approval` →
`consolidation` → `publication`, `recovery` → `pipeline`.

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

`plans/rename-map.csv` inventories the 255 functions that existed at the old
`e55302d` snapshot. It is an input, not a complete deletion list. Regenerate it
at the implementation baseline and add every function/module/workflow added by
§15 before mapping behavior. Mapping each to a catalog behavior surfaces the two
questions: behaviors that exist but are poorly named (rename), and behaviors the
goals need that nothing implements (write).

A function maps to no goal only after live skill commands, hook commands,
runtime-spawned scripts, workflow adapters, Phase 4 finalization, compatibility
entry points, and recovery paths have all been included as roots. Only then may
it be proposed for deletion, with a parity test proving that no preserved entry
point uses it.

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
declared files is 2 not 3 — `declaredFiles` is exported once at
`taskGroups.ts:13`, and `canonicalTaskGroups.ts:4` *imports* it rather than
reimplementing it.

**Digest compatibility:** path/tree snapshot implementations currently use
different algorithms in different contracts. Unification is allowed only with
an explicit manifest/receipt version migration; approval and recovery digests
must never change silently during the refactor.

### 8.3 Dead-code candidates

The old audit identified `hookOverride.ts`, `getUnblockedTaskNumbers.ts`, and
`validateRunAuthorization` as candidates. They are **not pre-authorized
deletions**: the Phase 4 hook override, `tackle-unblocked-tasks`, and finalizer
authorization are now preservation roots. Re-evaluate their actual call paths
after the current cutover and add parity tests before deleting or folding them.

## 9. Tests

The mechanism that makes §1.2's failures regression-proof. The first draft gave
this one line; it is the load-bearing part of the plan.

### 9.1 There is no way to run the suite today

`package.json` has no `scripts` block. There is no CI, no Makefile. `README.md`
documents running one file at a time. "Full suite green" was ungateable.

**First commit of v2**: add `"test": "node --test tests/*.test.ts"` and a
local-binary `"typecheck": "tsc --noEmit"` to `package.json`, with TypeScript
declared in `devDependencies`. The explicit glob avoids the Node 26 directory
runner failure already observed in this repository. Nothing else can be
verified until these commands work from a fresh install.

### 9.2 Migrating 56 existing test files

At `dc1ec9e`, `tests/` holds 56 tracked top-level `*.test.ts` files. When a script splits into
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
| workflow sandbox rejected imports | every phase adapter runs in an injected workflow harness without static/dynamic imports or shell globals |
| reviewer unavailable | the identical prompt falls back, records the actual reviewer, and never exceeds two total reviews |
| task 54 example tests | a stored example is planned and written first; `"skip"` takes the non-TDD path |
| bounded Test/Fix | a red group stops after the configured rounds and emits a red receipt |
| approval evidence drift | changing a receipt, handoff, tree digest, base OID, or operation ref invalidates authorization |
| absolute occurrence paths / empty root ID | the real bootstrap manifest passes end to end without path duplication or falsy-ID loss |
| publication failure | earlier CAS updates roll back and failed/rolled-back tasks remain open |
| legacy manifest | the active finalizer entry point refuses it without changing worktrees or refs and names recovery actions |
| leftover worktrees | discovery reports matched and unmatched worktrees; only individually approved clean merges are removed |
| local-path submodule fixture | tests enable the Git file protocol only through test environment configuration |

### 9.5 Coverage rule

One test file per behavior file. A behavior with no test does not merge.

## 10. Build sequence

1. **Finish and freeze the v1 baseline.** Complete the recursive Phase 4
   acceptance/cutover and either land or explicitly absorb every open task that
   overlaps v2. Record the baseline commit and regenerate the entry-point/import
   closure; do not rely on the `dc1ec9e` snapshot.
2. **Worktree** `tackle-tasks-v2`; **`package.json` test and typecheck scripts** (§9.1).
3. **Preservation matrix and behavior catalog** — every goal and every §15
   feature decomposed. No production code.
4. **Naming pass** — catalog and regenerated CSV reviewed, names corrected. Gate: names settled.
5. **Library, topic by topic** in §7's order. Each topic: behaviors, their tests,
   and the migration of that topic's existing tests, in one commit. Suite green
   at every boundary.
6. **CLI** under `scripts/cli/`, each a `try`/`catch` composing behaviors.
   Preserve compatibility shims for public v1 script paths during the migration.
7. **Workflow adapters** — keep the five phase files self-contained and backed
   by injected-harness tests; call the new CLI/library contracts without copying
   deterministic logic back into prompts.
8. **Callers** — every `!` command in every `SKILL.md`, every `command` in
   `hooks/hooks.json`, `.claude-plugin/plugin.json`, `marketplace.json.devblock`,
   `README.md`.
9. **Skills** reduced to surviving judgment while retaining reviewer fallback,
   approval, recovery, and example-test decisions.
10. **Verification** — §12.

## 11. Scope

Scope is **computed, not asserted**: the transitive closure of imports from every
script invoked by a `SKILL.md` `!` command or a `hooks/hooks.json` command, plus
scripts spawned at runtime by the workflow.

The old “14 roots / 25 modules” result is obsolete. Current v1 added workflow
adapters, an explicit merge-phase runner, an auxiliary worktree-merge mode, and
a `mergePipeline` import chain that reaches the recursive finalizer and
publication modules. Recompute counts at the frozen baseline.

Required roots include:

- Every script injected or invoked by a `SKILL.md` or hook.
- All five `tackle-tasks/*.workflow.js` adapters, even though they are not
  TypeScript imports.
- `prepareTasks`, the runtime path it returns for `runMergePhase`, and the
  `mergeTaskWorktrees` modes selected by `--run`, `--discover`, and `--merge`.
- Every compatibility path exposed by README/plugin metadata or used by another
  repository through `--plugin-dir`.
- Phase 1–4 startup, manifest, graph, identity, synchronization, ownership,
  approval, consolidation, operation-push, base-publication, archival, recovery,
  and legacy-refusal paths.

At minimum, the newly reachable preservation set includes `manifestBootstrap`,
`repositoryDiscovery`, `canonicalTaskGroups`, `ownershipKeys`,
`ownershipSnapshots`, `logicalRepository`, `submoduleUrlIdentity`,
`runMergePhase`, `mergePipeline`, `approvalReadiness`, `approvalGate`,
`runAuthorization`, `runFinalizer`, `runConsolidation`,
`repositoryIntegration`, `operationPush`, `basePublication`, `taskArchival`,
`recoveryRefs`, `legacyManifest`, `tackleMetrics`, and their dependencies.

The general rule remains: **the closure finds imports, not runtime dispatch.**
Add path-spawned scripts, CLI modes, workflow files, hook commands, and skill
injections as roots before following static imports.

### 11.1 Correcting the first draft

The first draft declared `repositoryGraph`, `repositoryManifest`, and
`resolutionRequests` out of scope and unreachable. **They are reachable.**
`relatedTests.ts` — a live, enabled `PostToolUse` hook — calls
`getOwningOccurrence` (line 92), `discoverTestPolicy` (line 116), and
`createEmptyResolutionManifest` (line 159). `testPolicy.ts` imports
`resolutionRequests.ts` too.

They are in scope. The boundary moved to follow the evidence.

### 11.2 Out of scope

No Phase 1–4 module is out of scope merely because a version flag has not yet
made it the default. The cutover architecture is mandatory v2 foundation.

A module may be excluded only when the regenerated closure cannot reach it, no
open task or compatibility entry point names it, its preserved behavior maps to
another tested implementation, and deletion has a parity test. Generated plans,
briefs, metrics, and disposable fixtures are data rather than library behaviors,
but their file formats remain compatibility inputs where live tooling reads them.

### 11.3 In-flight work is not overwritten

At committed baseline `dc1ec9e`, open tasks are 35, 36, and 58–61. They stay
owned by their current work until they land or are explicitly absorbed into the
v2 preservation matrix:

- 35/36 finish the recursive workflow cutover and RevEng acceptance fixture.
- 58 separates modifiable and readable file fences and removes source-body
  duplication from briefs.
- 59 gives origin-less repositories a clean early refusal.
- 60 separates the user's raw request from the agent-derived task description.
- 61 makes commit-message generation collect current staged state itself.

This list is a snapshot, not a gate. Re-read `tasks.json` at build-sequence step
1 so later tasks are not silently excluded.

### 11.4 Known collision

v2 relocates files named by the cutover and task-schema work, including
`taskFiles.ts`, `taskGroups.ts`, `prepareTasks.ts`, `mergeTaskWorktrees.ts`,
`approvalGate.ts`, `mergePipeline.ts`, and the five workflow adapters. Starting
before those tasks land would create two competing implementations.

Mitigation: freeze v1 first, regenerate the preservation matrix, then build v2
on its own branch. Public old paths receive forwarding shims for one release.
The final v2 layout is merged as one verified change only after the end-to-end
matrix proves both current-v1 parity and the deliberate §13 changes.

### 11.5 Cross-project migration

Other repos load taskTools via `--plugin-dir` and get whatever is on disk. There
is no version pin, so a half-migrated branch breaks every consuming project at
once.

- v2 lands as one squashed commit. There is no half-migrated state on the branch
  other repos track.
- `.claude-plugin/plugin.json` and marketplace versions move together; the
  default `skills/` directory remains the source of truth rather than a manually
  duplicated skill inventory.
- Existing `tasks.json` files in other repos are valid unchanged. `difficulty`
  and `tests` are optional; legacy file-fence and description fields remain
  readable through an explicit migration window.

## 12. Done

v2 is done when all hold:

1. `npm test` green; `npm run typecheck` clean.
2. Every behavior file has a test file (§9.5).
3. Every incident test in §9.4 exists and passes.
4. Parity (§9.3) holds, or each divergence is recorded in §13.
5. Every goal in §4 is invoked once end to end against a disposable real backlog.
6. A run against ≥3 tasks recorded in `plans/tackle-metrics.jsonl` with per-task
   durations, and no task exceeding the §5.4 ceiling.
7. `grep -r "scripts/" skills/ hooks/ README.md .claude-plugin/` returns no path
   that does not exist.
8. The RevEng-shaped fixture proves repeated occurrences converge, child OIDs
   propagate through explicit edges, one approval precedes semantic
   finalization, CAS publication rolls back safely, and only published tasks are
   archived.
9. Codex success, Codex rejection/repair, each configured fallback, missing
   agent result, red receipt, approval drift, merge conflict, push failure,
   publication failure, and rollback failure each have an exercised terminal
   result and recovery handoff.
10. Leftover-worktree discovery/approval/merge works for matched, unmatched,
    uncommitted, conflicted, approved, and unapproved worktrees without forced
    deletion.
11. A legacy manifest reaches the active finalizer entry point and is refused
    non-destructively with concrete recovery actions.

**Rollback**: v2 is one squashed commit on its own branch. Reverting it restores
v1 wholesale. The branch is not merged until 1–11 hold.

## 13. Deliberate behavior changes

Every place v2 behaves differently from v1, recorded so a parity failure can be
distinguished from a regression.

| Change | From | To | Why |
|---|---|---|---|
| corrupt registry | returns `[]` | throws | a corrupt backlog must not read as empty (§3.3) |
| missing registry | returns `[]` | returns `[]` | unchanged — 8 callers depend on it |
| grouping identity | raw declared paths | canonical logical paths plus synchronized occurrences and ancestor gitlinks | aliases must not race (§5.1) |
| merge granularity | competing group/task merges | one operation and integration OID per logical repository per approved run | recursive/repeated repositories require one publication history (§5.5) |
| approval | implicit/per-step merge permission | one whole-run digest-bound approval before semantic finalization | current Phase 4 safety contract (§5.5) |
| production gitlinks | choose a conflict side | install the prepared child integration OID | preserves the finalized child (§5.5) |
| retry bound | attempts only | attempts **and** wall-clock | task 16 burned 3.4h (§5.4) |
| repair loops | prose/unbounded | three rounds by default; explicit red/blocked terminal result | current v1 added bounded implementation and Test/Fix loops (§5.4) |
| worktree removal | `--force` available | never forced; refuses unclean | task 1 destroyed committed work (§5.6) |
| metrics | per run | per run **and** per task | the ceiling cannot be tuned without it (§5.7) |
| typecheck command | hardcoded | discovered, same default | §5.2 |
| workflow layout | one importable workflow assumed | five self-contained phase adapters plus deterministic CLI state | supported sandbox forbids imports and direct shell execution (§5.1) |
| test intent | inferred by agents | optional user-authored `tests` example propagated plan → implementation → receipt | preserves task 54 (§5.10) |
| reviewer outage | failed review run | identical-prompt fallback with actual reviewer attribution | outage is not rejection (§5.10) |

## 14. Repository state

Measured at committed `dc1ec9e` on `new-usage-graph`, 2026-08-06. Uncommitted
workspace changes are deliberately excluded. These drift fast; recompute before
implementation rather than trusting this snapshot.

(The first draft cited `117073b`, which was already stale when written: that
commit has 48 scripts, 4041 lines, and 48 test files, and `approvalGate.ts` /
`approvalReadiness.ts` did not yet exist there.)

- 57 tracked top-level TypeScript scripts, 5103 total lines, 56 tracked
  top-level test files.
- `plans/rename-map.csv` still has the old 255-function snapshot; a rough current
  declaration scan finds about 290 and is not a substitute for regeneration.
- 6 committed open tasks: 35, 36, and 58–61.
- 9 live worktrees at audit time.
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

### 14.2 Second-draft claims corrected here

The second draft was audited too. It got these wrong:

| Claim | Was | Is |
|---|---|---|
| metrics totals | 21 runs, 45 tasks, 10.57 h | 22 records / 20 runIds at the `e55302d` audit; superseded by §14.3 |
| metrics reliability | treated as sound | duplicate runIds, one pair disagreeing (§1.1.1) |
| `declaredFiles` import site | `taskGroups.ts:4` | exported `taskGroups.ts:13`, imported `canonicalTaskGroups.ts:4` |
| `tackleMetrics` | "spawned by path" | ordinary import from `mergeTaskWorktrees.ts:6` |
| repo-state commit | `117073b` | `e55302d` — the numbers were never `117073b`'s |

### 14.3 Preservation-audit corrections

| Claim at `e55302d` | Current committed state at `dc1ec9e` |
|---|---|
| 22 metric records / 20 run IDs | 43 records / 39 run IDs; four duplicated IDs (§1.1) |
| 30-minute ceiling justified by a 20.8-minute legitimate maximum | not justified by whole-run metrics; calibrate active-execution time in shadow mode (§5.4) |
| 51 scripts / 50 tests | 57 scripts / 56 tests |
| recursive finalizer/publication modules out of scope | reachable production foundation through `mergePipeline` (§11) |
| monolithic workflow assumed | five self-contained phase adapters required by the workflow sandbox (§5.1) |
| per-task merge selected for v2 | superseded by one logical-repository consolidation/publication history (§5.5) |

## 15. Current-v1 additions that v2 must preserve

This is the preservation delta from the previous `e55302d` source audit through
`dc1ec9e`. Commit subjects are evidence pointers; the contract is the behavior
in the final column, verified against the resulting tree rather than inferred
from the subject alone.

| Commit(s) | Current-v1 addition | v2 preservation requirement |
|---|---|---|
| `1c1aa8e` | canonical-only operation branch push | push only repeated logical repositories' canonical operation branches, after authorization, without force, and verify all occurrences converge |
| `0940f8d` | local base publication | require the root integration ref, revalidate digest/base OIDs, CAS-update canonical refs, fast-forward other occurrences, and roll back the whole partial publication |
| `4921646` | publication-qualified task archival | accept an explicit task list and archive only tasks published in every affected repository, retaining commit hashes |
| `e4984d9`, `e568219` | read-only repository discovery and manifest bootstrap | discovery performs no checkout/branch mutation; bootstrap returns a resolved occurrence graph or named resolution requests |
| `5bc1e55` | unblocked-task helper and bounded-loop direction | retain `tackle-unblocked-tasks` and `run-task-loop` as explicit goals; re-evaluate the helper's live call path rather than deleting it from the stale inventory |
| `fd39862`, `9488346`, `06f616e` | graph-aware branches and canonical grouping wired into preparation | detached repositories refuse before mutation; task effects use the real manifest and canonical logical ownership rather than a flat stub |
| `9c45964` | task statistics decoupled from repository-manifest discovery | `task-stats` remains usable for registry reporting even when no recursive execution manifest is being prepared |
| `69d555e` | `merge-worktree-tasks` and `--discover`/`--merge` modes | retain leftover-worktree discovery, task matching, per-worktree approval, conflict reporting, and recovery preservation; migrate cleanup to the v2 non-force rule |
| `ea0b190`, `f2ccc8a` | origin fallback, difficulty template, real submodule integration fixture, and empty root occurrence ID | preserve empty-string root IDs as valid identities, test local-path submodules with test-only Git configuration, and absorb task 59's final origin-less-repository policy before freezing v1 |
| `ee0bd6b` | five self-contained phase workflows | retain sandbox-compatible Plan, Verify, Implement, Test/Fix, and merge-unblock adapters; never reintroduce unsupported imports or direct shell assumptions |
| `b450675`, `05c5673`, `875870a` | bounded plan repair and reviewer fallback | identical review prompt, one repair, two verdicts total, configured fallback chain, and honest reviewer attribution in the handoff |
| `388c524`, `dd387ac`, `6943749`, `a5fb3d7` | structured implementation/test/merge diagnosis | explicit schemas and pseudocode-like branches, failures routed to the original plan/task, accumulated conflict diagnosis, user decisions separated from tool blockers, no hollow success |
| `73084f2` | bounded worker repair | configurable repair rounds and a blocked result with remaining failures after exhaustion |
| `f462cfc` | difficulty-based task picking | sort by stored difficulty then task number, using inspection only for relevance filtering |
| `5b9abda` | exact planner ownership and no deferred discovery | planner reads allowed context, accounts for every owned file, and returns clarification instead of conditional implementation steps |
| `f7eb2ad` | publication type separated from logical-repository identity | keep publication-target and logical-repository domain types distinct in the composed library |
| `8d2669e` | user-provided example tests | store `tests`, plan and write the example, expand coverage, and honor explicit `"skip"` |
| `6b66b48`, `ebbc081` | real approval inputs | carry actual test receipts/review handoffs, compute occurrence digests from Git trees, and mint authorization only from a complete drift-sensitive run state |
| `14facac` | deterministic merge-phase runner | persist step outputs, derive counts and arguments in code, classify exit/JSON/conflict failures, and return the exact retry context |
| `d5580e1`, `2d6eaa8` | `mergePipeline` finalization/publication path | normalize absolute/relative occurrence coordinates, accept the empty root ID, preflight without semantic commits, finalize and consolidate child-first, push, publish, archive, retain recovery data on failure, and delete transient inputs only after success |

### 15.1 History/tree discrepancy to resolve before freezing v1

`efcc0e7` added active legacy-manifest routing with worktree-specific recovery
instructions, but the later integration commit `1d68d7b` leaves the committed
`dc1ec9e` tree without that gate even though its subject says the opposite.
Phase 4 still requires non-destructive legacy refusal. The v1 freeze must either
restore it or record it as an explicit v2 prerequisite; the preservation audit
must test the active CLI path, not count the earlier commit as sufficient.

### 15.2 Open schema/features at the preservation baseline

Tasks 58–61 are committed backlog, not yet landed behavior. They nevertheless
overlap v2 and cannot be dismissed by the refactor. At freeze time, either let
them land first or incorporate their accepted contracts into the catalog:

- distinct modifiable/readable file fences with legacy `files` compatibility and
  pointer-only briefs;
- clean early refusal for repositories without `origin`;
- separate verbatim `userDescription` and derived `description` fields;
- commit-message generation that reads the current staged state at execution
  time rather than accepting a stale diff snapshot.

The audit workspace also contains an uncommitted task 62 that turns the
commit-message instructions into a real skill backed by a `stagedDiffs` helper,
so invocation-time injection is structural rather than prompt discipline. It is
excluded from committed-state counts but included in the preservation rule: if
it lands before the v1 freeze, preserve the skill/helper entry points and migrate
all Stop-hook, `tackle-tasks`, and `update-tasks` callers to the single source of
truth.

Any tasks added after `dc1ec9e` receive the same treatment during build-sequence
step 1.
