# Handoff: convert remaining tackle-tasks agent briefs from prose to executable pseudocode
Conversation name: Fix failing tests, then rebuild the tackle-tasks pipeline
JSONL: /Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools/8cb31399-131a-4e66-a1a7-d07bc086c743.jsonl
Plan file: none — this work was driven directly by user instruction, not a plan file

## Branch
`new-usage-graph` based on `master`

## Goal
The `tackle-tasks` skill drives five workflow files, each of which builds a text
brief that is handed to a subagent. Those briefs were written as English prose,
which leaves too much room for interpretation — a subagent can read a paragraph
several ways. The work converts every brief into deterministic pseudocode:
explicit assignments, `if`/`else if`/`else` branches, `run(...)` calls, and
literal `return {...}` statements naming every field. Four of five briefs are
converted. One remains.

## Current State
Converted to pseudocode and committed:
- `skills/tackle-tasks/merge.workflow.js` — `runBrief` and `diagnoseBrief`
- `skills/tackle-tasks/implement.workflow.js` — `workerBrief`
- `skills/tackle-tasks/test.workflow.js` — `testerBrief` and `fixerBrief`

Each converted brief now opens with this exact preamble:
```
Carry out every step below, in order, from top to bottom.
A line reading `name = value` means record that value and use it later.
A line reading `run(...)` means actually execute that command now.
A line reading `return {...}` means stop and report exactly those fields.
```
and closes with a sentence beginning `You are forbidden to ...` (never a bare
`forbidden:` label — the user rejected that form explicitly).

Every executable line in those four briefs is wrapped in `run(...)`, including
`run(cd <path>)`. No angle-bracket placeholders such as `<exit code>` remain
anywhere; values are named as the concrete output they come from.

NOT converted: `skills/tackle-tasks/plan.workflow.js` — `plannerBrief` at line 22
is still prose.

Verification state: `npx tsc --noEmit` clean, `bun test` 1032 pass / 0 fail.

Working tree: `.taskTools/tasks.json`, `.taskTools/completedTasks.json`,
`skills/tackle-tasks/implement.workflow.js`, `skills/tackle-tasks/test.workflow.js`
are staged and uncommitted (task 41 closure plus the `run(cd ...)` change).
`skills/tackle-tasks/.gitignore` is untracked and predates this work.

## What Remains
1. Decide whether to convert `plannerBrief` in `skills/tackle-tasks/plan.workflow.js`.
   The user was asked and has not answered. It is the weakest candidate: the brief
   is essentially "read this brief file, write a plan to that path, set status to
   one of planned / needs-clarification / not-relevant". There are three outcomes
   but almost no branching, so pseudocode may be ceremony around three lines.
   Do not convert it without asking.
2. Add a round ceiling to the fix loop in `implement.workflow.js` `workerBrief`.
   It currently reads "if any test failed: fix the cause, then run typecheck and
   results again" with no limit, so it can loop indefinitely. `test.workflow.js`
   bounds its equivalent loop at `MAX_ROUNDS` (default 3, from `ARGS.maxRounds`).
   Match that.
3. Exercise the merge failure path against a real conflict. Everything in
   `merge.workflow.js` past the first successful run — `diagnoseBrief`, the
   `decisions` escalation, the retry — has never executed. The only merge this
   session (task 48) succeeded with zero conflicts. This is the largest untested
   surface in the pipeline.

## Key Files
- `skills/tackle-tasks/plan.workflow.js` — the one brief still in prose (`plannerBrief`, line 22)
- `skills/tackle-tasks/verify.workflow.js` — `verifierBrief`; runs `codex exec -s read-only`, applies codex fixes to the plan, re-runs codex once; second rejection is final
- `skills/tackle-tasks/implement.workflow.js` — `workerBrief`; needs the round ceiling from item 2
- `skills/tackle-tasks/test.workflow.js` — `testerBrief` (report-only) and `fixerBrief` (routes a failure back to the implementing agent with its plan file)
- `skills/tackle-tasks/merge.workflow.js` — `runBrief` and `diagnoseBrief`; the untested failure path
- `skills/tackle-tasks/SKILL.md` — documents the six orchestration steps and the exact args each workflow takes
- `.env.test` — sets `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` so git allows local-path submodules during tests only

## Context the Next Agent Won't Have
**Workflow scripts cannot run shell commands.** Proven by probe this session: the
sandbox's only globals are `log, phase, console, budget, setTimeout,
clearTimeout, Date, agent, parallel, pipeline, workflow, args`. `require` is not
defined, `Bun` is not defined, `process` is undefined. Static `import` is rejected
at parse ("must be the FIRST statement"), and dynamic `import()` throws
"import() is not available in workflow scripts". Therefore every workflow file
must be fully self-contained, and the ONLY way to run a command from a workflow
is to spawn an agent that runs it. Do not attempt a shared module — a prior
commit (`d33b9c8`) did, and it left `/tackle-tasks` completely unrunnable.

**Bash substitution does not work in agent briefs.** Probed this session: a brief
containing `` !`touch <marker>` `` never created the marker. `` !`cmd` `` is a
skill-loading feature (SKILL.md uses it four times); a brief is a plain JS string
with nothing between it and the subagent.

**User preferences expressed forcefully, do not regress these:**
- Write code, not prose, wherever logic can be expressed as code. This was said
  several times before it landed; treat prose in a brief as a defect.
- Never write `forbidden: <list>`. Use "You are forbidden to ..." with each item
  as a verb.
- Never ask a subagent to merely run a command and echo its output — that was
  called wasteful. A subagent must do work requiring judgment. Measured: a
  trivial subagent spawn costs ~27-30k tokens.
- The main agent is expensive; conflict resolution belongs in subagents.
- No angle-bracket placeholders in briefs; they can be copied literally.

**Approaches that failed:** deleting the import instead of moving it (broke
`plannerBrief is not defined`, produced a hollow run that still reported
`merged: true` on an empty branch); moving the import below `meta` (parse error);
dynamic `import()` (unavailable).

**bun quirk:** `execFileSync` does NOT inherit mutations to `process.env`, but it
does inherit real launch-time environment variables. This is why the git protocol
override lives in `.env.test` rather than a preload script.

**A hook in this session auto-commits staged work.** Several times work was
committed without an explicit commit command. Do not rely on "staged but not
committed" holding.

## How to Verify
```
cd /Users/matkatmusicllc/Programming/taskTools
npx tsc --noEmit          # expect: no errors
bun test                  # expect: 1032 pass, 0 fail
```
To confirm no brief has regressed to prose:
```
rg -n 'forbidden:' skills/tackle-tasks/*.workflow.js          # expect: no matches
rg -n 'Follow this exactly' skills/tackle-tasks/*.workflow.js # expect: no matches
rg -c 'Carry out every step below' skills/tackle-tasks/*.workflow.js  # expect: merge 2, test 2, implement 1
rg -n '<[a-z][a-z ]*>' skills/tackle-tasks/*.workflow.js      # expect: no placeholder matches
```
