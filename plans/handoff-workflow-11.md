# Handoff — migrate the v1.5 prompt into tackle-tasks.workflow.js

Repo `/Users/matkatmusicllc/Programming/taskTools-86`, branch `fix-tackle-tasks-workflow-script-imports`.
My work is **staged, not committed** — 8 files, see "What I staged" below.

## The job

Take `plans/tackle-tasks-v1_5-prompt.md` paragraphs **18 through 97** and migrate them into
`skills/tackle-tasks/tackle-tasks.workflow.js`, then rewrite the workflow's innards so it follows
`plans/workflow-only-context-injection.md`.

Paragraphs 1 through 17 are already done. They live in code, not prose — see below.

## Ground rules that do not bend

**The diagrams are the source of truth.** `plans/diagram/pipeline-*.mmd`, 16 files, one per pipeline,
in run order. The prompt document is derived from them. When the prompt and a diagram disagree, the
diagram wins and the prompt gets fixed.

**The required chain, no shortcuts:**

    SkillBodyEmitter -> WORKFLOW -> agent(...) -> AgentPromptEmitter

Reject `SkillBodyEmitter -> main-agent Bash -> AnotherEmitter`. That extra hop still executes in the
main context and isolates nothing.

**Execution-site tags.** Every paragraph carries one:

- `[C]` — SkillBodyEmitter, AgentPromptEmitter, or the workflow runs it as code, no agent. 90 of 97.
- `[S]` — a subagent runs it, so its output never reaches the main agent. Exactly 6: paragraphs
  **23, 30, 36, 45, 58, 63**. These are the only `agent()` calls the pipeline needs.
- `[M]` — only the main agent can do it. Exactly 1: paragraph 1.

There are 97 paragraphs, not 98. An earlier count of 98 was wrong.

**`.workflow.js` constraints.** Never import anything. `meta` must be the first statement. `require`
and `process` are undefined, and `` !`cmd` `` expands only in a SKILL.md body, never in an `agent()`
prompt. Build the WORKFLOW JSON with `JSON.stringify`, never by interpolating `$ARGUMENTS` into
quotes.

**SkillBodyEmitter imports.** Only `node:url` for paths from `import.meta.url`, and `node:fs` for
reading quoted-heredoc stdin. No subprocesses, no relative imports. Verify with
`rg -n 'execFileSync|spawn|from "\.' scripts/tackle-tasks/SkillBodyEmitter.ts`.

## What is already done — the preamble, paragraphs 1 to 17

`scripts/tackle-tasks/SkillBodyEmitter.ts` calls `runPreamble` in
`scripts/tackle-tasks/PreambleDataEmitter.ts` at skill-invocation time, and a failed check replaces
the whole skill body with one line. That covers three diagrams: preamble status check, worktree
check, document generation.

`runPreamble` now walks those three diagrams exactly. Its contract:

```ts
export type ExitTail = "report-only" | "failures";

export type PreambleResult = {
    code: WorkflowResultCode;              // PROCEED | DO_NOT_PROCEED
    reason: string | null;
    step: string;                          // the diagram node id this came from
    receipt: ActiveTaskWorktreeReceipt | null;
    exitType: string | null;
    tail: ExitTail | null;
};
```

`ActiveTaskWorktreeReceipt` is `{ taskNumber, worktree, branch, briefFile, initialized }`, validated
by `validateActiveTaskReceipt`. On `PROCEED` the receipt is populated and `exitType`/`tail` are null.
**That receipt is your input.** The workflow starts from a task that is already active, with an
initialized worktree and a written brief.

`tail` tells you which exit the workflow owes:

- `report-only` — the exit happened **before** the task was marked active, so nothing is held and
  nothing is written.
- `failures` — the exit happened **after**, so the failures exit must write the run record, release
  the worktree lease and the source lock as two independent ownership checks, and mark the task
  inactive **last**.

### What I changed in the preamble this session

`runPreamble` did not match the diagrams. Four gaps, all fixed:

1. The unsafe-worktree path was a commented-out stub that returned PROCEED anyway.
2. `isTaskRunResumable` was never called.
3. Submodules were initialized **after** the docs. The diagram says before.
4. There was no docs-mode value; each branch picked generate-vs-update inline.

Then a design change the user asked for, and I put it in the diagram first:

- **A safe worktree is never reset.** Only the unsafe path resets. A safe worktree that is not
  resumable now stops with exit type `not-resumable` and takes the **failures** exit, so the user
  decides what to do with the pre-existing work.
- **A new box after the resumable question**: `does the task's file list cover what the worktree
  touched?` Fails with exit type `fence-violation`, also the failures exit.

The user first asked for the report-only exit on both. I raised that the worktree check runs *after*
the task is active, so report-only would leave the task active and the lease held forever — Known
Gap A, on a common path. They agreed and chose the failures exit.

New script `scripts/tackle-tasks/checkResumedWorktreeFence.ts` — committed work plus staged and
unstaged edits, every layer, untracked excluded because generated docs are untracked by design. It
derives the source branch itself and never takes the source repo lock, because the preamble does not
hold one. It reuses `computeExemptGitlinkPaths`, which I exported from `checkTaskFileFence.ts`.

## Start here: the coverage map

`plans/v1_5-C-coverage.md` (already committed by another session) maps **every `[C]` paragraph** to
the source file that implements it, marked COVERED / PARTIAL / MISSING. Read it before you write
anything — it is the difference between wiring existing scripts and rewriting them.

Score: **35 COVERED, 34 PARTIAL, 21 MISSING**. The headline is that the per-box scripts in
`scripts/tackle-tasks/` are largely solid, and the orchestration between them does not exist.

The 21 MISSING cluster into four groups:

1. **Publication state** — ¶72, 73, 74, 77, 85, 86, 95. The per-layer merge refs are *written*
   (¶71 is COVERED) but nothing *reads* them into an ALL / NONE / SOME LANDED verdict, and both exit
   tails still trust the incoming exit type instead of asking git. Largest gap, and the core v1.5
   novelty.
2. **Four missing exit types** — `closing`, `clarify-stuck`, `agent-failed`, `partially-published`
   are absent from `taskRunState.ts:TaskExitType`. `agent-failed` alone accounts for ¶26, 31, 37,
   47, 59, 65. `not-resumable` also still needs adding — see "Open items".
3. **CLARIFY** — ¶21, 24, 27, 28, 29. Zero hits for "clarify" under `scripts/` or `skills/`.
   `updateTaskDocs.ts` takes no clarify input, which blocks the rest.
4. **In-run counters and their tasks.json notes** — ¶33, 40, 42, 43. No fix-attempt counter exists
   in runtime code.

## The current state of tackle-tasks.workflow.js

It is a **trace-only skeleton**. It carries the line `/** Real mode is deliberately not built. */`,
has a `FAKE` mode returning canned receipts, and any real decision throws via `realDecisions()`. It
was built to diff step order against `scripts/tracePipeline.ts`. Do not mistake it for a driver.

`scripts/tackle-tasks/AgentPromptEmitter.ts` (618 lines) dispatches **8 roles** today: `plan`,
`review-plan`, `implement`, `fix-conflicts`, `fix-suite`, `fix-tests`, `review-tests`, `amend-tests`.
It is the only place that imports data scripts to build a prompt, and it appends bulk data last under
a `---- DATA ----` marker. Those 8 roles map closely onto the 6 `[S]` paragraphs — that is your
starting point for the `agent()` calls.

Also note `scripts/tackle-tasks/greenBoxPolicy.ts` — the canonical registry of every dispatched
script, classifying each as read-only, mutating, or maintenance-mutating. `test_greenBoxPolicy_
namesEveryScriptInTheScriptsDirectory` fails if you add a script and forget to register it. That is
how you learn what a lost `agent()` result may safely retry.

## Gotchas that will cost you an hour each

**26 test failures in `tests/tackle-tasks/` are pre-existing and are not your fault.** The diagram
split deleted five merged diagrams (`pipeline-preamble.mmd`, `pipeline-planning.mmd`,
`pipeline-implementTest.mmd`, `pipeline-rebaseMerge.mmd`, `pipeline-exitWorkflow.mmd`), and
`scripts/tracePipeline.ts` plus `scripts/generatePipelinePaths.ts` still read those names. Every
`test_workflow_*` case throws ENOENT at module load.

**4 more fail in `SkillBodyEmitter.test.ts`** for `skills/tackle-tasks/resolve.workflow.js`, archived
in commit `922f7a1`. Those tests are obsolete — they cover the retired multi-task body.

**Get a baseline before blaming yourself.** `git stash push -q <your files>`, run
`npx tsx --test tests/tackle-tasks/*.test.ts`, diff the `✖` lists by name. A whole-file crash shows
as one `✖ <path>` line; fixing an import turns it into many individually-named failures, which looks
like a regression and is the opposite.

**Run `npm test`, not `bun test`.** Bun reports one false failure in `mergeTaskWorktrees`. Do not
gate on `rg '^✖'` either — it reports "all passing" on a red suite. Gate on `fail N`.

**The comment-reflow hook.** `scripts/reflowComments.ts` runs PostToolUse and joins consecutive
same-indent `//` or `%%` lines into one, then blocks the edit if the joined line hits 20 words.
Editing one word in a file makes it reflow **every** comment in that file, and `git checkout --` does
not stick because the hook fires again. Write one-line comments under 20 words and you never see it.
Do **not** put a blank `//` between sentences to defeat the joiner — that is cheating the hook's
intent and the user will call it out.

In `.mmd` files the separator between comment lines is a `%% ---` divider, and every comment line is
a complete sentence under 20 words. **A bare `%%` line is not safe** — mermaid renders it as a
visible node named `%%`.

**Diagrams render clean.** After editing any `.mmd`, run it through
`npx -y @mermaid-js/mermaid-cli@11` and check for stray `%%` nodes.

## Four places the runtime still disagrees with the diagrams

These are open code tasks, listed at the bottom of the prompt document:

1. **Task-test counter is off by one.** `tackle-tasks.workflow.template.js` sets `MAX_ATTEMPTS = 2`
   but raises the counter before asking, so only **one** codebase fix runs before `tests-red`, while
   its exit note claims "after 2 codebase fixes".
2. **The rebase never reads the merge receipt.** ¶57 has no counterpart in `rebaseTaskWorktree.ts` or
   `advanceTaskRebase.ts`; only merge and reset consult `findRecordedMergedCommit`.
3. **CLARIFY does not exist in the workflow template at all.**
4. **Document generation never receives the clarify request.** `generateTaskDocs.ts` and
   `updateTaskDocs.ts` take only `(taskNumber, worktreePath, projectRoot)`. This blocks item 3.

Exit-note text also drifts from the diagrams in ¶50, 66, 68 and 76 — the exit type and trigger are
right, the wording is not.

## Design points the older code and docs do not have

- Publication is durable **in git**, not in tasks.json. Each layer writes
  `refs/taskTools/merge-commits/<branch>` the moment it lands. Both exit tails read those refs rather
  than trusting an exit type.
- New exit types: `closing`, `clarify-stuck`, `fence-violation`, `agent-failed`,
  `partially-published`. `cleanup-incomplete` is a **repair flag**, not an exit type.
- `partially-published` is **recovery only** and is never retried.
- The failures exit releases the worktree lease and the source lock as **two independent ownership
  checks**, and marks the task inactive **last**.
- `completed` is **final**; no later failure may overwrite it.
- Counters count **fix attempts, not failing runs**. Each invocation starts at zero, nothing is
  written to tasks.json, and a merge-triggered rebase does not reset a counter.
- A mutating box whose result is lost is **reconciled, never blindly retried**. Only an ambiguous
  read is `run-failed`. See `scripts/tackle-tasks/reconcileStep.ts`.

## What I staged

    plans/diagram/pipeline-worktreeCheck.mmd          new fence box, two failures-exit stops
    plans/tackle-tasks-v1_5-prompt.md                 ¶15 / ¶16b / ¶17 rewritten, not-resumable added
    scripts/tackle-tasks/PreambleDataEmitter.ts       runPreamble rewritten to match the diagrams
    scripts/tackle-tasks/SkillBodyEmitter.ts          dropped an unused tracePipeline import
    scripts/tackle-tasks/checkResumedWorktreeFence.ts new
    scripts/tackle-tasks/checkTaskFileFence.ts        exported computeExemptGitlinkPaths
    scripts/tackle-tasks/greenBoxPolicy.ts            registered the new script
    scripts/tackle-tasks/taskRunState.ts              comment reflows only, no logic change

Typecheck clean. **Zero new test failures**, verified name-by-name against a stashed baseline.

Note on `taskRunState.ts`: the diff looks large (16 insertions, 69 deletions) but it is entirely
comment reflow. The hook collapsed the wrapped blocks, then 6 were rewritten to one line each. The
user reviewed this and said to leave it as is. **No logic changed in that file.**

## Open items I did not do

1. **`checkResumedWorktreeFence.ts` has no test.** Every sibling script has one. It needs a git
   fixture with a submodule to be worth anything.
2. **`not-resumable` is not in `taskRunState.ts:TaskExitType`.** Nothing needs it until the failures
   exit is wired. `PreambleResult.exitType` is a plain `string` today. Add it when you build that
   tail, and add the other four missing types at the same time.

## Suggested order

The user is explicit that this is **one pass at a time**, and that what can be converted only becomes
visible once the previous layer exists. Do not plan all of it up front.

The next pass is: get paragraphs 18 to 97 into the workflow as prose plus the 6 `agent()` calls, with
`AgentPromptEmitter` carrying the prompts. Only after that does it become clear which `[C]`
paragraphs can be pre-executed into baked text.
