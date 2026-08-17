# tackle-tasks v1.5 — the pipeline as one prompt

The whole pipeline written as a single governing prompt, in the voice of the v1 skill body
(`skills/tackle-tasks/SKILL.md` at `55c8140~1`): bare imperatives, impersonal, a heading per phase,
conditions as "When X, Y", a why-clause welded onto each rule, bold only for hard constraints.

Paragraphs are numbered so ranges can be assigned an execution site. Numbers are stable; line
numbers are not. Each paragraph names the diagram boxes it covers.

The three execution sites:

- **E** — the SkillBodyEmitter runs it before the body is emitted, and the result is baked in
- **W** — `tackle-tasks.workflow.js` runs it as code, no agent
- **S** — a subagent runs it, so its output never reaches the main agent
- **M** — only the main agent can do it, so it stays as prose

---

## Run

**1.** `Run start: Task Num [N]`
Tackle exactly one task per run. The task number arrives as `$ARGUMENTS`; **never batch two task
numbers into one run**, because each run takes the source-repository lock around its own merge and
that lock is what makes concurrent runs safe.

**2.** *(whole pipeline)*
Every git interaction goes through a script, never prose. Every read and write of `tasks.json` is
atomic. A script that fails operationally, as opposed to returning a verdict, ends the run as
`run-failed`.

---

## Preamble

**3.** `is task number valid?`
Report whether the task number appears in `tasks.json` or `completedTasks.json`. When it appears in
neither, stop with exit type `invalid-number`: there is no run record to write to, so report the
exit type and note and nothing else.

**4.** `is task blocked?`
Report whether the task has an open blocker remaining. When a blocker remains, stop with exit type
`blocked` — the same report-only stop, because nothing has been claimed yet.

**5.** `is the task active?` `Try: mark the task active in tasks.json`
Check the active status and, when the task is free, mark it active for this run in one atomic
read-modify-write. These are drawn as two boxes but are one operation, because nothing may make the
task active between the question and the write. When a previous run left it active, stop with exit
type `already-active`.

**6.** `does a worktree exist?`
Report whether a worktree already exists for this task. The answer decides whether this is a first
attempt or a resumption, and nothing after this point re-asks it.

**7.** `create a worktree` `auto generate docs` `init submodules recursively`
When no worktree exists, create one, generate the task's brief into it, and initialize its
submodules recursively. The brief is the sole input the planning agent reads, so it is generated
before any agent is launched.

**8.** `is the worktree safe?`
When a worktree exists, report whether it is structurally safe to use: it opens, it is on the task's
branch, and its submodules are intact.

**9.** `is the previous run resumable?`
When the worktree is unsafe, report whether the previous run recorded where in the plan it stopped.
When it did, keep the worktree and refresh the brief with that state so the next plan does not
repeat the last one's mistakes. When it did not, tear the worktree down and recreate it.

**10.** `update docs` `init submodules recursively`
When the worktree is safe, refresh the brief in place and initialize its submodules. A stale brief
would plan against work that no longer exists.

**11.** `Output` `Receipt: { }` `is the active task receipt structure valid?`
Emit a receipt for the prepared workspace and check its structure before going further. When the
receipt is malformed, stop with exit type `run-failed`: a malformed receipt is a broken step, not a
bad task, and **no agent is launched on erroneous input**.

---

## Planning

**12.** `plan the task`
Launch one agent to write a plan file from the brief: its task number, its revision, and its
sections, each holding an id, a title and a body.

**13.** `did the agent return a result?` `retry the box`
When the agent returns nothing, launch the box again. Nothing was returned, so nothing can be
judged; this is the harness losing the agent, not a verdict.

**14.** `Output` `Receipt: { }` `is the plan file structure valid?`
Check the plan's structure only, never its content: it parses, its task number matches, its revision
is a positive integer, and its sections are a non-empty array of objects each holding a unique
kebab-case id, a string title and a string body. When it is malformed, stop with exit type
`run-failed` and the note `the plan file is malformed` — a structure failure is a broken agent, so it
is not retried and **does not burn a scrap attempt**.

**15.** `codex reviews the plan`
Launch one agent to review the plan with codex in non-interactive mode, returning a verdict of
accept, amend or scrap, with notes and any amendments.

**16.** `Output` `Receipt: { }` `is the review file structure valid?`
Check the review's structure only: it parses, it carries one of the three verdicts, and it carries
the fields that verdict requires. When it is malformed, stop with exit type `run-failed` and the note
`the codex review is malformed`.

**17.** `what is the review verdict?`
Route on the verdict. Codex gets two rounds of each kind, and the counters below are what stop a
perpetual review-fix-review-fix cycle.

**18.** `SCRAP` `First Time Scrap?` `script adds the codex scrap notes to the task brief`
On the first scrap, write the scrap notes into the brief and plan again. The replan is not a bare
retry: the planner reads the brief, so notes that stay outside it would produce the same plan twice.

**19.** `Second Time Scrap`
On the second scrap, stop with exit type `plan-scrapped` and the note `codex scrapped the plan
twice`. This tells the user the task cannot be planned as written and needs dividing into smaller
tasks.

**20.** `AMEND` `Try: script applies codex amendments to the plan`
On amend, apply the amendments to the plan file. **The amendments are applied either way**; the
counter below only decides whether codex sees the amended plan again.

**21.** `2 amend rounds done?`
When fewer than two amend rounds are done, send the amended plan back for re-review. After two, take
the plan as it stands and go on, because a third round buys revision, not correctness.

**22.** `ACCEPT` `Output` `Receipt: { }` `is the finished plan receipt structure valid?`
On accept, emit the finished plan receipt and check its structure. When it is malformed, stop with
exit type `run-failed` and the note `the finished plan receipt is malformed`.

---

## Implement and test

**23.** `implement task`
Launch one agent to implement the accepted plan in the worktree, using the `jot:implement` skill and
treating the worktree as the project root.

**24.** `did the agent return a result?` `retry the box`
When the agent returns nothing, launch the box again.

**25.** `record implementation notes file to tasks.json`
Record the implementation-notes file on the task's run record. That file is what makes a failed run
resumable, so it is recorded before anything can fail.

**26.** `commit if needed`
Commit the worktree's work. Every later step rebases or reruns, and uncommitted work would be lost.

**27.** `Try: run task tests`
Run **only the tests written for this task**, not the full suite. The full suite belongs to the
rebase phase, after the work is known to be internally correct.

**28.** `do the tests fail?` `First fail?` `fix the codebase`
On the first failure, launch an agent to fix **the codebase, not the tests**, then commit and run the
task tests again. The tests encode the task's requirements, so changing them to pass is changing the
task.

**29.** `Output` `Receipt: { }` `is the fix receipt structure valid?`
Check the fix receipt's structure. When it is malformed, stop with exit type `run-failed` and the
note `the fix receipt is malformed`.

**30.** `2nd fail`
On the second failure, stop with exit type `tests-red` and the note `task tests failed after 2
codebase fixes`.

**31.** `codex reviews tests against task details and plan file`
When the task tests pass, launch an agent to review **the tests, not the codebase**, against the task
details and the plan file. The test run alone decides whether the work passes; codex judges whether
the tests were worth passing.

**32.** `Output` `Receipt: { }` `is the test review receipt structure valid?`
Check the test review receipt's structure. When it is malformed, stop with exit type `run-failed` and
the note `the test review receipt is malformed`.

**33.** `are the tests flagged?` `First flagging?` `amend the tests`
On the first flagging, launch an agent to amend the tests from codex's notes, then commit and run the
task tests again, which re-enters the fix loop above.

**34.** `Output` `Receipt: { }` `is the amendment receipt structure valid?`
Check the amendment receipt's structure. When it is malformed, stop with exit type `run-failed` and
the note `the amendment receipt is malformed`.

**35.** `2nd flagging`
On the second flagging, stop with exit type `tests-flagged` and the note `codex flagged the tests
twice`. **The worktree is left in place** so the work is not lost and the task can be reattempted
once its instructions are corrected.

**36.** `can the source repo be locked?` `First time held?` `Try: wait`
When the tests are not flagged, read whether the source repository lock is free. When another owner
holds it, wait once and read again. On the second time held, stop with exit type `run-failed` and the
note `the source repo lock is held by another owner`.

**37.** `Try: lock the source repo` `did locking the source repo succeed?` `First lock failure?` `Try: wait`
Take the lock, then prove it was taken. A read that said free can still lose the race, so on the
first failure wait once and try again; on the second, stop with exit type `run-failed` and the note
`the source repo lock could not be acquired`.

**38.** `Output` `Receipt: { }` `is the finished implementation receipt structure valid?`
Emit the finished implementation receipt, carrying the implementation-notes file and the lock owner,
and check its structure. When it is malformed, stop with exit type `run-failed` and the note `the
finished implementation receipt is malformed`.

---

## Rebase and merge

**39.** `Try: rebase onto the target branch if needed`
Rebase the worktree onto the head of the branch it was created from. Everything in this phase happens
under the source-repository lock taken above.

**40.** `did the rebase report conflicts?` `First conflict?` `fix conflicts`
On the first conflict, leave the conflict markers in the files and launch an agent to resolve them,
passing it the stopped layer and its conflicted files.

**41.** `Output` `Receipt: { }` `is the conflict fix receipt structure valid?`
Check the conflict fix receipt's structure. When it is malformed, stop with exit type `run-failed`
and the note `the conflict fix receipt is malformed`.

**42.** `2nd conflict?`
On the second conflict, stop with exit type `rebase-stuck` and the note `the rebase did not advance
after 2 conflict fixes`, and hand the worktree back so the user can decide what to do with it.

**43.** `commit if needed` `Try: continue replaying commits on top of the target branch` `is the rebase finished?`
Commit the resolution and continue replaying commits. When replaying stops on new conflicts, re-enter
the conflict loop above; a rebase can stop more than once.

**44.** `Try: run the full suite` `do all tests pass?`
When the rebase is finished, run the **full** suite. The task's own tests passed before the rebase;
this is what proves the task did not break anything else.

**45.** `First suite failure?` `fix the codebase so the full suite passes`
On the first suite failure, launch an agent to fix the codebase, then commit and rerun.

**46.** `Output` `Receipt: { }` `is the suite fix receipt structure valid?`
Check the suite fix receipt's structure. When it is malformed, stop with exit type `run-failed` and
the note `the suite fix receipt is malformed`.

**47.** `2nd suite failure?`
On the second suite failure, stop with exit type `suite-red` and the note `full suite still failing
after 2 codebase fixes`, and hand the worktree back.

**48.** `did every change stay inside the task's owned files?`
Check that every change stayed inside the files the task owns. When a change escaped, stop with exit
type `fence-violation` and the note `a step changed a file the task does not own` — the fence is
derived from the task, **never accepted from a caller**, because a caller-supplied fence is a fence a
caller can widen.

**49.** `Try: merge worktrees and submodules, no fast-forward` `did the merge land?`
Merge the worktree and its submodules with **no fast-forward**, then prove the merge landed. A
fast-forward leaves no merge commit to revert.

**50.** `First merge failure?`
On the first merge failure, rebase and retry from the top of this phase, because a failed merge means
the target branch moved.

**51.** `2nd merge failure?`
On the second merge failure, stop with exit type `merge-failed` and the note `the merge did not land
twice`.

**52.** `Output` `Receipt: { }` `is the merge receipt structure valid?`
Emit the merge receipt, carrying the commits and the modified files, and check its structure. When it
is malformed, stop with exit type `run-failed` and the note `the merge receipt is malformed`.

---

## Exit workflow — success

**53.** `record merge commit hashes to tasks.json` `write exit type completed to tasks.json` `record modified files to tasks.json`
Record the merge commits, the exit type `completed`, and the modified files on the task's run record,
before releasing anything.

**54.** `clean up worktrees, leases, persistence refs and source lock`
Clean up the worktree, its lease, its persistence refs and the source lock. Ownership is released
last, and only after it has been re-proved inside the lock.

**55.** `build the closure note from the recorded run` `mark task inactive in tasks.json`
Build the closure note from what the run actually recorded, then mark the task inactive.

**56.** `move task to completedTasks.json and update tasks blocked by it` `report the closure note` `stop`
Move the task to `completedTasks.json`, update the tasks it was blocking, and report the closure note.

---

## Exit workflow — failure

**57.** `write exit type and exit notes to tasks.json` `record modified files to tasks.json` `mark task inactive in tasks.json`
On any exit that is not `completed`, write the exit type and note, record the modified files, and mark
the task inactive. The task stays in `tasks.json`, because it was not completed.

**58.** `was a worktree created?` `nothing to release`
When no worktree was created, there is nothing to release.

**59.** `was the source repo locked?` `release the worktree lease` `release the worktree lease and the source lock`
Release the worktree lease, and the source lock too when this run held it. Release only what this run
proved it owns.

**60.** `report the run's exit type and note` `stop`
Report the exit type and note. Report nothing else about the run.

---

## Exit workflow — no run record

**61.** `report the exit type and note` `stop`
`invalid-number`, `blocked` and `already-active` happen before any run record exists, so there is
nothing to write and nothing to release. Report the exit type and note, and stop.

---

## Exit types

| exit type | meaning |
|---|---|
| `completed` | archived to `completedTasks.json` |
| `invalid-number` | not in `tasks.json` or `completedTasks.json` |
| `already-active` | a previous run left the task active |
| `blocked` | an open blocker remains |
| `plan-scrapped` | codex scrapped the plan twice |
| `tests-red` | task tests still failing after 2 fix attempts |
| `tests-flagged` | codex flagged the tests twice |
| `suite-red` | full suite still failing after 2 fix attempts |
| `rebase-stuck` | the rebase did not advance after 2 conflict fixes |
| `merge-failed` | the merge did not land twice |
| `fence-violation` | a step changed a file the task does not own |
| `run-failed` | a script failed operationally |

---

## Where this document differs from the sketch

Written to the diagrams, which are the source of truth. Three points in the spoken sketch do not
match them, and need a decision before they are written in.

**A. The amend loop does not re-plan.** The sketch says codex's feedback is added to the brief and the
planning agent is re-invoked. Paragraph 20 follows the diagram: a script applies the amendments to
the plan file, and the loop returns straight to `codex reviews the plan`. Only the **scrap** path
re-invokes the planner (paragraph 18).

**B. The planner has two return types, not four.** The sketch lists a plan file, a clarification
request, nothing at all, and a request for files not named in the brief. The diagram has a plan file
or nothing (paragraph 13). Clarification requests and file requests do not exist, and adding them
adds a main-agent turn in the middle of the run.

**C. Nothing deletes the brief.** The sketch's close phase deletes the planning brief. Paragraph 54
cleans up worktrees, leases, persistence refs and the source lock; the brief lives inside the
worktree and goes with it.
