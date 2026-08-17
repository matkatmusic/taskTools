# tackle-tasks v1.5 — the pipeline as one prompt

The whole pipeline written as a single governing prompt, in the voice of the v1 skill body
(`skills/tackle-tasks/SKILL.md` at `55c8140~1`): bare imperatives, impersonal, a heading per
pipeline, conditions as "When X, Y", a why-clause welded onto each rule, bold only for hard
constraints.

Regenerated from `plans/diagram/*.mmd`, which are the source of truth. There is one heading per
diagram file, in run order. Paragraphs are numbered so ranges can be assigned an execution site.
Numbers are stable; line numbers are not. Each paragraph names the diagram boxes it covers.

The three execution sites:

- **C** — either SkillBodyEmitter, AgentPromptEmitter, or `tackle-tasks.workflow.js` runs it as code, no agent
- **S** — a subagent runs it, so its output never reaches the main agent
- **M** — only the main agent can do it, so it stays as prose

---

## Run

**1.** `Run start: Task Num [N]` [M]
Tackle exactly one task per run. The task number arrives as `$ARGUMENTS`; **never batch two task
numbers into one run**, because each run takes the source-repository lock around its own merge and
that lock is what makes concurrent runs safe.

**2.** *(whole pipeline)* [C]
Every git interaction goes through a script, never prose. Every read and write of `tasks.json` is
atomic. Every box that touches the working tree operates on every repository layer, deepest
submodule first and root last; boxes that only read or write `tasks.json` do not.

**3.** *(whole pipeline)* [C]
A script that fails operationally, as opposed to returning a verdict, ends the run as `run-failed`.
This is not drawn as an edge in any diagram, because it can leave **any** green box and drawing it
would add one edge per box and hide the flow.

**4.** *(whole pipeline)* [C]
A mutating box whose result is lost is never blindly retried and never assumed to have failed.
Reconcile first: read the world and decide whether the box already happened. Rerun only after
reconciliation proves it did not complete. **Only an ambiguous read is `run-failed`.** See
`reconcileStep.ts`.

**5.** *(whole pipeline)* [C]
Every counter in this pipeline counts **fix attempts, not failing runs**: two attempts means up to
three runs. No counter is written to `tasks.json`, so each invocation starts at zero. A
merge-triggered rebase does not reset a counter, because the fixes it already spent still count.

---

## Preamble status check

`pipeline-preambleStatusCheck.mmd`

**6.** *(whole pipeline)* [C]
Every box here runs **before the task is marked active**, so a failure holds nothing and has no run
record to write to. Every exit here takes the report-only exit, never the failures exit.

**7.** `is task number valid?` [C]
Report whether the task number appears in `tasks.json`. `completedTasks.json` is **not consulted**:
finished work is not a task this skill can run. When it does not appear, stop with exit type
`invalid-number` and the note `task number is not in tasks.json`.

**8.** `is task blocked?` [C]
Report whether the task has an open blocker remaining. When a blocker remains, stop with exit type
`blocked` and the note `an open blocker remains`.

**9.** `is the task active?` `is the task closing?` `Try: mark the task active in tasks.json` [C]
Check active status, check closing status, and when the task is free mark it active for this run, in
**one atomic read-modify-write**. These are drawn as three boxes but are one operation, because
nothing may change the task between the questions and the write. See `claimTask` in
`taskRunState.ts`, which returns `claimed`, `active` or `closing`.

**10.** `is the task active?` = YES [C]
When a previous run left the task active, stop with exit type `already-active`. **Do not touch the
run that was found**: it belongs to another invocation, and writing to it would corrupt a live run.

**11.** `is the task closing?` = YES [C]
A task is closing when it is inactive, its newest ended run exited `completed`, and it is still in
`tasks.json`. That task merged already and is waiting to be archived. Stop with exit type `closing`.
Running it again would redo work that is already published.

**12.** `Try: mark the task active in tasks.json` — ambiguous result [C]
When marking the task active fails ambiguously, re-read `tasks.json` and see whether the claim
landed. When it is still unknown after that re-read, stop with exit type `run-failed`, which takes
the report-only exit because nothing was proved to be held.

---

## Worktree check

`pipeline-worktreeCheck.mmd`

**13.** `does a worktree exist?` [C]
Report whether a worktree already exists for this task. The answer decides whether this is a first
attempt or a resumption, and nothing after this point re-asks it.

**14.** `create a worktree` `take the worktree lease for this run` [C]
When no worktree exists, create one and take its lease for this run, then emit docs mode `AUTOGEN`.
A new worktree has no docs yet, so they must be generated rather than updated.

**15.** `is the worktree safe to use?` [C]
When a worktree exists, report whether it is **structurally** safe: it opens, it is on the task's
branch, and its submodules are intact. This question says nothing about the work inside it.

**16.** `is the previous run's work resumable?` `adopt the lease for this run` [C]
Ask this **only of a structurally safe worktree**, and ask it second: it is a semantic question, not
a structural one. Report whether the previous run recorded where in the plan it stopped, and adopt
that run's lease for this run. The run that recorded the stopping point held the lease, so adopting
it is a journalled swap, not a silent reuse. When resumable, emit docs mode `UPDATE`.

**17.** `take the worktree lease for this run` `reset the worktree` [C]
When the worktree is unsafe, **take the lease before resetting**, then reset, then emit docs mode
`AUTOGEN`. An unsafe worktree is reset and never resumed, because "unsafe" includes being on the
wrong branch and resuming there would commit the task's work onto that branch. Mutating a worktree
whose lease may still belong to another run is what taking the lease first prevents. See
`resetTaskWorktree.ts`, where `transitionWorktreeLease` runs before `removeWorktreeAndBranch`.

**18.** `is the previous run's work resumable?` = NO `reset the worktree` [C]
When a safe worktree is not resumable, reset it and emit docs mode `AUTOGEN`. The lease was already
adopted by the question above, so nothing is mutated unowned.

**19.** *(whole pipeline)* [C]
**Resumption is worktree-level, not phase-level.** A resumed worktree keeps its committed work, but
the workflow still restarts at document generation and planning. There is no durable resume phase
and no dispatch back to the phase that failed.

**20.** `init submodules recursively` [C]
Initialize the worktree's submodules recursively on every path, and carry the docs mode forward. The
caller decides the mode; document generation does not work it out.

---

## Document generation

`pipeline-documentGeneration.mmd`

**21.** `what is the docs mode?` `auto generate docs` `update auto generated docs` [C]
Route on the docs mode. On `AUTOGEN` generate the docs; on `UPDATE` refresh them in place. The
planner reads these docs, so they are built **before** planning, not after.

**22.** `Input: { worktree, docs mode, clarify request? }` [C]
In `UPDATE` mode, read the clarify request and the `tasks.json` entry, and grow the docs to cover
what the request names. Without the request this pipeline cannot know what was missing, so it would
rebuild identical docs and the planner would ask the same question forever.

**23.** *(whole pipeline)* [C]
The generated docs are **never committed**. Their paths live in `GENERATED_ARTIFACT_PATTERNS` and in
`.gitignore`, and `configureGeneratedArtifactIsolation` marks any tracked copy `skip-worktree`. That
is what makes a later `git add -A` safe — by design, not by accident. See `writeTaskBrief.ts`.

---

## Plan

`pipeline-plan.mmd`

**24.** `plan the task` [S]
Launch one agent to turn the `tasks.json` entry into a plan file, reading the entry and the docs and
nothing else.

**25.** `what did the planner return?` [C]
Route on three outcomes: `PLAN`, `CLARIFY`, `ERROR`.

**26.** `PLAN` [C]
On a plan, hand it to the review plan pipeline.

**27.** `ERROR` `agent() errored` [C]
When the agent returns nothing usable, stop with exit type `agent-failed` and the note `the agent
returned nothing usable`. The task is already active and a worktree already exists, so the failures
exit runs in full.

**28.** `CLARIFY` `2 clarify rounds done?` [C]
A subagent cannot ask the user anything, so `CLARIFY` is how the planner says it needs something it
was not given. Cap the loop at **2 rounds**, counted within this run only: there is no user to
answer, so a third round cannot learn what a second did not.

**29.** `write the clarify request into the tasks.json entry` [C]
Before the loop turns, write the clarify request into the `tasks.json` entry and carry it on the edge
into document generation, in docs mode `UPDATE`. The planner reads the entry and the docs and nothing
else, so a request left outside them is a request nobody can act on.

**30.** `2 clarify rounds done?` = YES [C]
On the third ask, stop with exit type `clarify-stuck` and the note `the planner asked twice for
something the docs cannot supply. worktree preserved.`

---

## Review plan

`pipeline-reviewPlan.mmd`

**31.** `codex reviews the plan` [S]
Launch one agent to review the plan with codex, returning a verdict of `ACCEPT`, `AMEND` or `SCRAP`.

**32.** `codex reviews the plan` `agent() errored` [C]
When the agent returns nothing usable, stop with exit type `agent-failed`.

**33.** `what is the review verdict?` `ACCEPT` [C]
On accept, hand the plan to the implement pipeline.

**34.** `AMEND` `SCRAP` `update tasks.json entry` [C]
On amend or on scrap, write codex's notes into the `tasks.json` entry and raise the review counter by
one. The planner reads that entry, so a replan with the notes left outside it would repeat the first
plan's mistakes.

**35.** `2 codex reviews done?` = NO [C]
When fewer than two reviews are done, replan against the amended entry.

**36.** `2 codex reviews done?` = YES [C]
On the second review that did not accept, stop with exit type `plan-scrapped` and the note `codex did
not accept the plan in two reviews`. This tells the user the task cannot be planned as written and
needs dividing into smaller tasks.

---

## Implement

`pipeline-implement.mmd`

**37.** `implement task` [S]
Launch one agent to implement the accepted plan in the worktree, treating the worktree as the project
root. **Never update a test that was not created in this task's worktree**, unless that test is
broken or asserts nothing.

**38.** `implement task` `agent() errored` [C]
When the agent returns nothing usable, stop with exit type `agent-failed`.

**39.** `commit if needed` [C]
Commit the worktree's work, and commit nothing when the worktree is clean. Every later step rebases
or reruns, and uncommitted work would be lost. Generated doc artifacts are excluded from the commit
by the mechanism in paragraph 23.

**40.** *(whole pipeline)* [C]
The source-repository lock is **not** taken here. The rebase preamble pipeline takes it, much later,
because holding it across implementation would serialize every run for no benefit.

**41.** *(re-entry)* [C]
Two pipelines re-enter here after amending the `tasks.json` entry: the task tests pipeline and the
review task tests pipeline. The implementor reads the entry, so a pipeline that sends the run back
here writes what went wrong into the entry first.

---

## Task tests

`pipeline-taskTests.mmd`

**42.** `Try: run task tests` `do the task tests pass?` [C]
Run **only the tests written for this task**, not the full suite. The full suite belongs to the
rebase phase, after the work is known to be internally correct. Never progress past a test run until
every task test passes.

**43.** `have 2 fixes already been attempted?` [C]
Ask the counter **before** amending, not after. Asking after would spend the counter on the first
failure and allow only one repair, while the pipeline promises two.

**44.** `amend tasks.json entry with the failing tests` [C]
When fewer than two fixes have been attempted, write the failing tests into the `tasks.json` entry,
raise the fix counter by one, and re-enter the implement pipeline. A repair is never tested until it
is committed, which is why the failure re-enters implement and not this pipeline.

**45.** `have 2 fixes already been attempted?` = YES [C]
On the third failing run, stop with exit type `tests-red` and the note `task tests still failing after
2 fix attempts`.

---

## Review task tests

`pipeline-reviewTests.mmd`

**46.** `codex reviews the tests` [S]
Launch one agent to review **the tests, not the codebase**. The test run alone decides whether the
work is correct; this pipeline decides whether the tests prove it.

**47.** `Input: { plan, tasks.json entry, task test files, implementation diff, test command, test results, pre-existing test files }` [C]
Pass all seven inputs. Reading tests alone misses two failures that matter: tests that pass against
the wrong implementation, and pre-existing tests presented as this task's coverage. The
implementation diff and the pre-existing test files are **derived here**, from the task branch's
merge-base with the target branch — no earlier pipeline captures them. The test command and its
results come from the task tests pipeline that just ran.

**48.** `codex reviews the tests` `agent() errored` [C]
When the agent returns nothing usable, stop with exit type `agent-failed`.

**49.** `are the tests flagged?` = NO [C]
When the tests are not flagged, hand the finished implementation to the rebase preamble pipeline.

**50.** `2 codex test reviews done?` `amend tasks.json entry with codex's notes and fixes` [C]
On the first flagging, write codex's notes and fixes into the `tasks.json` entry and re-enter the
implement pipeline against the amended entry.

**51.** `2 codex test reviews done?` = YES [C]
On the second flagging, stop with exit type `tests-flagged` and the note `task tests failed codex
review`.

---

## Rebase preamble

`pipeline-rebasePreamble.mmd`

**52.** `Try: lock the source repo` `acquired?` [C]
Take the source-repository lock before anything touches the source repo. The lock is owned by
`runId:taskNumber`, **not by `runId` alone**, because every task workflow in one invocation shares a
`runId` and would otherwise read a sibling's lock as its own. See `acquireSourceRepoLock` in
`sourceRepoLock.ts`.

**53.** `have 15 minutes passed?` `wait 5s` [C]
When the lock is held, wait five seconds and try again, for up to fifteen minutes. The cap is what
stops this pipeline waiting on a stuck lock forever.

**54.** `have 15 minutes passed?` = YES [C]
After fifteen minutes, stop with exit type `run-failed` and the note `the source repo lock did not
come free within 15 minutes`.

**55.** *(whole pipeline)* [C]
The lock file lives under `<projectRoot>/.git`, so it survives the process that took it. A lock left
behind by a dead run is **not** handled here: it is cleared by hand with the operator-run
`recoverSourceRepoLock.ts`.

**56.** *(rebase, suite and merge pipelines)* [C]
The lock is held from here until an exit tail releases it, and every box in the rebase, suite and
merge pipelines refreshes its heartbeat on entry.

---

## Rebase

`pipeline-rebase.mmd`

**57.** `Try: rebase onto the target branch` [C]
Rebase the worktree onto the head of the branch it was created from, walking every repository layer
deepest submodule first.

**58.** `skip every layer the receipt records as already landed` [C]
**Skip any layer the merge receipt records as landed.** A landed layer is public: rebasing it would
rewrite commits already on a target branch, and the merge would then skip that layer using the old
receipt, leaving the rewritten commits unpublished while the parent points at them. The merge
pipeline re-enters here only when nothing landed, so the receipt is normally empty — but check that,
never assume it.

**59.** `did the rebase report conflicts?` `2 conflict fixes done?` `fix conflicts` [S]
On a conflict, and while fewer than two conflict fixes are done, leave the conflict markers in place
and launch an agent to resolve them, passing it the stopped layer and its conflicted files.

**60.** `fix conflicts` `agent() errored` [C]
When the agent returns nothing usable, stop with exit type `agent-failed`.

**61.** `commit if needed` `Try: continue the rebase` `is the rebase finished?` [C]
Commit the resolution, then continue the rebase. A repair is never replayed until it is committed, so
the cycle always runs fix, then commit, then continue — **never fix then continue**. When the rebase
stops on new conflicts, re-enter the conflict cycle; a rebase can stop more than once.

**62.** `2 conflict fixes done?` = YES [C]
After two conflict fixes that did not advance the rebase, stop with exit type `rebase-stuck` and the
note `the rebase did not advance after 2 conflict fixes`.

---

## Full suite

`pipeline-suite.mmd`

**63.** `Try: run the full suite` `do all tests pass?` [C]
Run the **full** suite. The task's own tests passed before the rebase; this is what proves the task
did not break anything else. Never progress past a suite run until every test passes.

**64.** `2 suite fix attempts done?` `fix the codebase so the full suite passes` [S]
While fewer than two fix attempts are done, pass the failing tests to an agent and have it fix **the
codebase, not the tests**.

**65.** `commit if needed` [C]
Commit the repair before rerunning the suite. A repair is never tested until it is committed, so the
cycle always runs fix, then commit, then run.

**66.** `fix the codebase so the full suite passes` `agent() errored` [C]
When the agent returns nothing usable, stop with exit type `agent-failed`.

**67.** `2 suite fix attempts done?` = YES [C]
After two fix attempts, stop with exit type `suite-red` and the note `full suite still red after 2 fix
attempts. merge aborted. worktree preserved.`

**68.** `did every change stay inside the task's file fence?` [C]
When the suite is green, check that every change stayed inside the files the task owns. The suite
fixer edits source, so its edits are subject to the same fence as the implementor's. The gate runs
**once, after the fix loop and before the merge**, so it covers every fix attempt at once. It
re-derives the diff itself and **never trusts what an agent says it changed**; see
`checkTaskFileFence.ts`.

**69.** `did every change stay inside the task's file fence?` = NO [C]
When a change escaped the fence, stop with exit type `fence-violation` and the note `a repair edited
files the task does not own. nothing merged. worktree preserved.` The fence is derived from the task
and **never accepted from a caller**, because a caller-supplied fence is a fence a caller can widen.

**70.** *(whole pipeline)* [C]
**Known ceiling:** the source lock goes stale after fifteen minutes, and the refresh is one call per
box, not a background timer. A single suite run or a single agent repair can itself take longer than
fifteen minutes, and nothing refreshes the lock while it does. See `sourceRepoLock.ts`, which has no
`setInterval`. Keep the boxes short until a periodic heartbeat exists.

---

## Merge

`pipeline-merge.mmd`

**71.** `Try: merge worktrees and submodules, no fast-forward` [C]
Merge the worktree and its submodules with **no fast-forward**, walking every repository layer
deepest submodule first and root last. A fast-forward leaves no merge commit to revert.

**72.** `Each layer that lands writes its merge ref AS it lands` [C]
Every layer that lands writes its own merge ref, `refs/taskTools/merge-commits/<branch>`, **at the
moment it lands**. That ref is the publication marker, and it is written inside the merge itself, not
after it. Nothing later can lose it: not a dead process, not a failed `tasks.json` write, not a lost
stdout. See `recordMergedCommit` in `mergeTaskWorktrees.ts`.

**73.** `read the publication state from the layer merge refs` [C]
Read the publication state as a read-only reconciliation over those refs. This is the answer to what
actually happened, and every later box — the retry, the reset, and the failures exit — asks it rather
than trusting a returned boolean. See `findRecordedMergedCommit` and `reconcileStep.ts`.

**74.** `what is the publication state?` [C]
Map each layer's status to a verdict, then map the verdicts to one state:

| layer status | verdict |
|---|---|
| `merged` | LANDED |
| `no-op` | LANDED |
| `root-merged-but-not-closed` | LANDED |
| `submodule-conflicted` | NOT landed |
| `parent-conflicted` | NOT landed |
| `merge-record-missing` | UNKNOWN — re-read the refs, and when still unknown, `run-failed` |

ALL LANDED means every layer landed. NONE LANDED means no layer landed. **Anything else is SOME
LANDED.** A multi-repo merge is not one yes-or-no event: a submodule can land while the root fails.

**75.** `ALL LANDED` [C]
When every layer landed, hand the merge receipt to the merge succeeded exit.

**76.** `NONE LANDED` `2 merge attempts done?` = NO [C]
When nothing landed and fewer than two attempts are done, re-enter the **rebase** pipeline, not the
rebase preamble: re-acquiring the same owner token is a no-op, and the retry exists because the
target branch tip moved. The receipt travels with the run.

**77.** `2 merge attempts done?` = YES [C]
When nothing landed after two attempts, stop with exit type `merge-failed` and the note `nothing
landed after 2 attempts. worktree preserved.`

**78.** `SOME LANDED` [C]
**Never retry a partial publication.** Stop with exit type `partially-published` and the note `some
layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.` A retry would
rebase and re-land layers around work that is already public. A recovery run resumes from the
receipt, which names exactly which layers still need to land.

**79.** *(whole pipeline)* [C]
A task that legitimately changes nothing still completes. A layer with no commits to land is recorded
as a **no-op layer**, not a failure, and paragraph 71 does not apply to it: there is no branch to
merge, so there is no merge commit to refuse to fast-forward. A task where every layer is no-op lands
ALL LANDED with an empty commit list and archives normally. An already-satisfied task is a real
outcome, not an error. See `commitTaskWork.ts` and `skippedOccurrenceIds` in `mergeTaskWorktrees.ts`.

---

## Merge succeeded exit

`pipeline-mergeSucceededExit.mmd`

**80.** `record merge commit hashes to tasks.json` `write exit type completed to tasks.json` [C]
Record the merge commit hashes, then write exit type `completed`. **`completed` is the point of no
return and it is written first, before anything is released or closed.** Every box after it is
cleanup of work that already landed.

**81.** `record modified files to tasks.json` [C]
Record the modified files on the task's run record.

**82.** `clean up worktrees, leases, persistence refs and source lock` [C]
Clean up the worktree, its lease, its persistence refs and the source lock. This is the **only** box
on this tail that releases the source lock and the worktree lease, and it releases both. Ownership is
re-proved inside the lock before anything is destroyed, and released last.

**83.** `build the closure note from the recorded run` `mark task inactive in tasks.json` [C]
Build the closure note from what the run actually recorded, then mark the task inactive. Marking it
inactive does **not** reopen it: a task whose newest ended run exited `completed` and is still in
`tasks.json` is closing, and paragraph 11 refuses it.

**84.** `move task to completedTasks.json and update tasks blocked by it` `report the closure note` `stop` [C]
Move the task to `completedTasks.json`, update the tasks it was blocking, and report the closure note.

**85.** *(whole tail)* [C]
This tail is **not** what makes a dead run safe. The task stays active until paragraph 83, so a run
that dies before then leaves it active, not closing. What makes it safe is that the merge wrote its
layer refs before this tail ever ran: the failures exit reads those refs, sees that work landed, and
finishes the job this tail started.

---

## Failures exit

`pipeline-failuresExit.mmd`

**86.** `read the publication state from the layer merge refs` `did ANY of this task's work land?` [C]
Ask **git** what landed before writing anything. Do not ask whether the exit type is `completed`:
`completed` is written to `tasks.json` well after the merge changes the target branch, so a failure in
that gap would find no marker, write `run-failed`, and make a task runnable again whose work is
already public.

**87.** `did ANY of this task's work land?` = YES `write the publication outcome` [C]
When any work landed, keep `completed` if it is already there, and otherwise write
`partially-published`. **Never write `run-failed` over landed work.** Discard the incoming exit type,
`run-failed` included, and record `cleanup-incomplete` and the note beside the outcome.

**88.** `write exit type and exit notes to tasks.json` [C]
When nothing landed, write the incoming exit type and note to the task's run record.

**89.** `record modified files to tasks.json` [C]
Record the modified files. When no worktree was ever created, this records an empty list.

**90.** `does this run still hold the worktree lease?` `release the worktree lease, keep the worktree` [C]
Ask whether **this run** still holds the worktree lease, by reading the lease file and comparing its
owner to this run's id. Do not ask whether a worktree was created: a resumed worktree was created by
an earlier run, and a lease can have been lost to another owner since.

**91.** `does this run still hold the source repo lock?` `release the source repo lock` [C]
Ask about the source lock **independently**. Neither holding gates the other's release. A run can
lose its lease to another owner and still hold the source lock, and gating the lock's release on
holding the lease would leak the lock forever. See `releaseTaskRunHolds.ts`.

**92.** `mark task inactive in tasks.json` [C]
Mark the task inactive **last**, after every release and every write. Marking it inactive is what
reopens it to another invocation, and reopening it while this run still holds its lease or lock lets
the next invocation claim the task and walk straight into a worktree somebody else owns.

**93.** `report the run's exit type and note` `stop` [C]
Report the exit type and note. Report nothing else about the run.

**94.** *(whole tail)* [C]
**The worktree is never removed here.** Releasing a lease is not deleting a worktree. The committed
work stays on disk, so the next invocation finds it at `does a worktree exist?` and reuses it. Only
the merge succeeded exit removes a worktree. See `releaseTaskRunHolds.ts` here and
`removeTaskWorktreeAndBranches` there.

**95.** *(whole tail)* [C]
Every mutating box on this tail is reconciled, not retried, which is what makes the tail safe to
re-enter. There is no exit tail behind this one to catch a failure, so an ambiguous read here is
reported to the operator and nothing further is written.

**96.** *(whole tail)* [C]
`cleanup-incomplete` and `partially-published` both mean **recovery only**. A run that reaches either
never goes back into planning or implementation, in this invocation or any later one; the preamble
stops it first.

---

## Report only exit

`pipeline-reportOnlyExit.mmd`

**97.** `report the exit type and note` `stop` [C]
`invalid-number`, `blocked`, `already-active`, `closing`, and a `run-failed` raised before the task was
marked active all happen before any run record exists, so there is nothing to write and nothing to
release. Report the exit type and note, and stop.

**98.** *(whole tail)* [C]
`already-active` and `closing` must **not** touch the run they find. That run belongs to another
invocation, and writing to it would corrupt a live run.

---

## Exit types

| exit type | meaning |
|---|---|
| `completed` | archived to `completedTasks.json`. **FINAL** — no later failure may overwrite it |
| `invalid-number` | not in `tasks.json`; `completedTasks.json` is not consulted |
| `already-active` | a previous run left the task active |
| `blocked` | an open blocker remains |
| `closing` | the task merged already and waits to be archived |
| `plan-scrapped` | codex did not accept the plan in two reviews |
| `clarify-stuck` | the planner asked twice for what the docs cannot supply |
| `tests-red` | task tests still failing after 2 fix attempts |
| `tests-flagged` | codex flagged the tests twice |
| `rebase-stuck` | the rebase did not advance after 2 conflict fixes |
| `suite-red` | full suite still red after 2 fix attempts |
| `fence-violation` | a change edited files the task does not own |
| `merge-failed` | nothing landed after 2 attempts |
| `agent-failed` | an agent returned nothing usable |
| `partially-published` | some layers landed, some did not. **RECOVERY ONLY** |
| `run-failed` | a script failed operationally; can leave **any** green box |

`cleanup-incomplete` is **not** an exit type. It is a repair flag the failures exit writes beside a
`completed` or `partially-published` exit type when the post-merge cleanup dies partway.

---

## Known gaps and accepted decisions

**A. A dead run wedges the task forever.** There is no liveness check, heartbeat, expiry or automatic
recovery for a task left marked active by a process that died. This is deliberate; see the
`ponytail:` note at `prepareTasks.ts:251` — "no automatic liveness probe on the stored pid; explicit
human call only". Recovery is manual: an operator runs `recoverStaleTaskWorktreeLease` in
`prepareTasks.ts`, or `recoverSourceRepoLock.ts`. **Neither clears the active flag in `tasks.json`;
that is done by hand.**

**B. The blocked check sits outside the atomic claim.** Paragraphs 7 and 8 are read before the atomic
claim in paragraph 9, so a human can add a blocker in that window and the run still takes the task.
Accepted: adding a blocker is a manual act, the window is milliseconds, and the worst case is one
extra finished task. Widen the claim predicate only if this is ever observed.

**C. The source lock can go stale inside a long box.** See paragraph 70.

---

## Where the runtime differs from these diagrams

**1. The task-test counter is off by one in code.** `tackle-tasks.workflow.template.js` sets
`MAX_ATTEMPTS = 2` but raises the counter before asking, so only **one** codebase fix runs before
`tests-red`, and its exit note still reads "after 2 codebase fixes". Paragraphs 43 to 45 describe the
intended shape. This is a code task.

**2. The rebase does not read the merge receipt.** Paragraph 58 is a diagram rule with no
counterpart in `rebaseTaskWorktree.ts` or `advanceTaskRebase.ts`; only merge and reset consult
`findRecordedMergedCommit` today. This is a code task.

**3. `CLARIFY` does not exist in the workflow template.** Paragraphs 28 to 30 describe a loop the
runtime has never implemented. This is a code task.

**4. Document generation does not receive the clarify request.** `generateTaskDocs.ts` and
`updateTaskDocs.ts` take only `(taskNumber, worktreePath, projectRoot)`. Paragraph 22 requires the
request be passed. This is a code task, and it blocks item 3.
