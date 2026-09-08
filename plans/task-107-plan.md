# Task 107 plan — inject the staged diff into the commit-message subagent's own prompt

Supersedes: the brief's original "Fix shape" paragraph is superseded by the
2026-08-08 amendment. This plan implements the amendment only: a new
`commitMessage.workflow.js` file runs `stagedDiffs.ts` in JavaScript and
pastes the diff text directly into the subagent's prompt body, and
`SKILL.md` shrinks to an instruction that launches that workflow.

## Investigation that shapes this plan

`skills/tackle-tasks/plan.workflow.js` fails `node --check` verbatim
(`SyntaxError: Illegal return statement` at its closing `return {` on line
126) — confirmed by running it. `.workflow.js` files are therefore not
executed as plain Node ES modules by the "Workflow" tool; they run inside
some wrapper the harness supplies (its exact code lives outside this repo —
no `scripts/` file implements it, confirmed by listing `scripts/` and
`skills/tackle-tasks/`, neither contains a workflow-running script). Stripping
the leading `export ` from `export const meta = {...}` and wrapping the rest
of the file body in `async function(args, agent, parallel, log, Workflow) {
...}` makes `plan.workflow.js` pass `node --check` cleanly (verified) — the
closest reconstructable model of the real wrapper.

Under that reconstruction, a static `import` declaration placed inside the
file is invalid (import/export declarations are Module-top-level-only;
placed inside a function body they throw `SyntaxError: Unexpected token '{'`
at load time — verified by running, not just `--check`ing, an equivalent
snippet). A dynamic `import()` **expression**, by contrast, is legal in
Script/function code and was verified to execute correctly under the same
reconstructed wrapper (`await import('node:child_process')` successfully
returned `execFileSync` and ran a subprocess). `commitMessage.workflow.js`
therefore obtains `execFileSync` via dynamic `import()`, never a static
`import` statement.

`scripts/tackleTasksBrief.ts` documents (in its own comment above
`checkBlockersPath`) that "the reading agent's shell has no
`CLAUDE_PLUGIN_ROOT` to expand" — i.e. that env var is only reliably
available inside a skill body's own `!`-prefixed command execution, not in
any process spawned afterward. The same applies to whatever process executes
a `.workflow.js` file: there is no confirmed way for `commitMessage.workflow.js`
to resolve `${CLAUDE_PLUGIN_ROOT}` itself. So the absolute path to
`stagedDiffs.ts` is resolved once, in `SKILL.md`'s own `!` command (where
`${CLAUDE_PLUGIN_ROOT}` is confirmed to expand — that's how the original
`SKILL.md:8` already used it), and threaded into the workflow through `args`,
mirroring `plan.workflow.js:7`'s own `args`-parsing convention
(`const ARGS = typeof args === 'string' ? JSON.parse(args) : args`).

The full flow was simulated end-to-end (wrapper reconstruction + a stub
`agent` function standing in for the real one) and confirmed: `args` carries
`stagedDiffsPath`, `execFileSync('node', [ARGS.stagedDiffsPath], ...)`
produces the diff text, and that text lands inside the prompt string passed
to `agent(...)`.

## Edits

### 1. `skills/commit-message/SKILL.md` — replace the whole body

Current content (all 18 lines, including frontmatter):

```
---
name: commit-message
description: generate a short commit-message summary for each git repo with staged changes, from the diff injected fresh at invocation
---

Staged diff, one section per affected repo (the current repo plus any submodule whose pointer moved):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): pass it the diffs above and have it generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
```

Replace the entire file with:

```
---
name: commit-message
description: generate a short commit-message summary for each git repo with staged changes, from the diff injected fresh at invocation
---

!`printf 'workflowPath=%s\nstagedDiffsPath=%s\n' "${CLAUDE_PLUGIN_ROOT}/skills/commit-message/commitMessage.workflow.js" "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`

Call Workflow with scriptPath the `workflowPath` value above, args `{"stagedDiffsPath": "<the stagedDiffsPath value above>"}`. The workflow runs that script itself and pastes the resulting staged diff straight into its subagent's prompt, so the diff never enters your context. It returns `{summaries}`, one `{repo, message}` per affected repo — the current repo plus any submodule whose pointer moved.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
```

Effect: the frontmatter is untouched. The `!` command no longer runs
`stagedDiffs.ts` — it only echoes two absolute paths via `printf`, satisfying
"the skill body no longer runs `stagedDiffs.ts` with a `!` command". The body
shrinks to a single instruction to launch the workflow, plus the unchanged
`Repo:`/`Message:` reporting format block (byte-identical to the original
lines, including the trailing space after `<repo name>`).

### 2. `skills/commit-message/commitMessage.workflow.js` — new file

File does not exist yet (owned-files list marks it "missing: file not found
on disk"). Create it with this exact content:

```js
export const meta = {
  name: 'commit-message-summarize',
  description: 'Summarize the staged diff into one commit message per affected repo',
  phases: [{ title: 'Commit message', detail: 'one subagent summarizes the staged diff per repo' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['repo', 'message'],
      },
    },
  },
  required: ['summaries'],
}

const { execFileSync } = await import('node:child_process')
const diffs = execFileSync('node', [ARGS.stagedDiffsPath], { encoding: 'utf8' })

const prompt = `Staged diff, one section per affected repo (the current repo plus any submodule whose pointer moved):

${diffs}
Generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Return {summaries}: one {repo, message} per affected repo.`

// ponytail: one fallback attempt (Sonnet then Opus), not plan.workflow.js's 3x retry-on-null loop
const runAgent = (model) => agent(prompt, { label: 'commit-message', phase: 'Commit message', schema: SUMMARY_SCHEMA, model })

let result
try {
  result = await runAgent('Sonnet 5')
} catch {
  result = undefined
}
if (result == null) result = await runAgent('Opus 5')

return result ?? { summaries: [] }
```

Design notes tying this back to the brief's constraints:

- `stagedDiffs.ts` runs unmodified (`scripts/stagedDiffs.ts` line-for-line as
  already read); it already walks the root repo plus every submodule with a
  moved pointer (its lines 27-49) and labels each section `=== label ===`
  (line 41), so "the subagent still covers the root repo plus every
  submodule whose pointer moved" holds without this workflow re-implementing
  that walk.
- The diff text is spliced into the prompt string handed to `agent(...)`
  inside this workflow's own process — the orchestrating agent that called
  `Workflow` never receives it, since `Workflow` (per
  `scripts/tackleTasksBrief.ts`'s own usage, e.g. its Step 1 description)
  returns only the workflow's final return value (`{summaries}` here), not
  its intermediate variables.
- The `Sonnet 5` / `Opus 5` fallback text is carried over verbatim from the
  replaced `SKILL.md` line ("Use a single subagent running `Sonnet 5` (fall
  back to `Opus 5` if Sonnet is unavailable or errors)"), reusing
  `plan.workflow.js`'s own null/undefined-means-no-result convention (its
  line 77 comment: "null/undefined means the harness returned no result;
  re-spawn") as the trigger for trying the second model.
- `ARGS` parsing (`typeof args === 'string' ? JSON.parse(args) : args`) is
  copied verbatim from `plan.workflow.js:7`.

### 3. `skills/tackle-tasks/plan.workflow.js` — no edit

Read for precedent only, per the brief's instruction to mirror how it builds
its planner prompt (its `plannerBrief` function, lines 40-72, and its
`ARGS`-parsing line 7). Nothing in task 107's goal touches tackle-tasks'
planning pipeline.

### 4. `skills/tackle-tasks/SKILL.md` — no edit

Read for precedent only: its `!` command block (lines 8-12) is the
established pattern for invoking a script whose output feeds the
orchestrating agent, and its `args = the pipeline args JSON exactly as
printed` phrasing (mirrored in `tackleTasksBrief.ts`'s generated brief, e.g.
line 77) is the precedent for the "Call Workflow with scriptPath ..., args
..." phrasing reused in this plan's new `SKILL.md` body. Task 107 does not
touch tackle-tasks.

### 5. `scripts/stagedDiffs.ts` — no edit

Unchanged: it is still the script that produces the per-repo diff sections,
now invoked from inside `commitMessage.workflow.js` via `execFileSync`
instead of from the skill body's `!` command. Its behavior (root repo +
every submodule with a moved pointer, `=== label ===` sections, lines 1-49
as already read) fully satisfies the coverage requirement without
modification.

### 6. `scripts/tackleTasksBrief.ts` — no edit

Read for precedent only: its comment above `checkBlockersPath` ("the reading
agent's shell has no `CLAUDE_PLUGIN_ROOT` to expand") is the reason this plan
resolves `stagedDiffs.ts`'s absolute path once in `SKILL.md`'s `!` command
and threads it through `args`, rather than having
`commitMessage.workflow.js` try to resolve `CLAUDE_PLUGIN_ROOT` itself. Its
`execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" })`
call (line 199) is the precedent for `commitMessage.workflow.js`'s own
`execFileSync('node', [ARGS.stagedDiffsPath], { encoding: 'utf8' })` call.
Task 107 does not touch the tackle-tasks brief generator.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `printf 'workflowPath=%s\nstagedDiffsPath=%s\n' "${CLAUDE_PLUGIN_ROOT}/skills/commit-message/commitMessage.workflow.js" "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"` with `CLAUDE_PLUGIN_ROOT` set to the repo root — expect two lines, `workflowPath=<repo>/skills/commit-message/commitMessage.workflow.js` and `stagedDiffsPath=<repo>/scripts/stagedDiffs.ts`. (Already run against the real repo root during planning; produced exactly that output.)

2. Reconstruct the harness wrapper and syntax-check the new workflow file, since plain `node --check` on a raw `.workflow.js` file is not a valid test (it fails the same way on the pre-existing, working `plan.workflow.js`, confirmed during planning):
   ```
   node -e '
   const fs = require("fs");
   const src = fs.readFileSync("skills/commit-message/commitMessage.workflow.js", "utf8");
   const stripped = src.replace(/^export const meta/, "const meta");
   const wrapped = "async function __workflow(args, agent, parallel, log, Workflow) {\n" + stripped + "\n}\n";
   fs.writeFileSync("/tmp/wrapped-commitMessage.js", wrapped);
   '
   node --check /tmp/wrapped-commitMessage.js
   ```
   Expect exit code 0, no output.

3. Functionally simulate the workflow with a stub `agent`, to confirm the diff text actually reaches the prompt string end to end:
   ```
   node -e '
   const fs = require("fs");
   const src = fs.readFileSync("skills/commit-message/commitMessage.workflow.js", "utf8");
   const stripped = src.replace(/^export const meta/, "const meta");
   const body = "async function __workflow(args, agent, parallel, log, Workflow) {\n" + stripped + "\n}\nreturn __workflow;";
   const workflow = new Function(body)();
   const stubAgent = async (prompt, options) => {
     console.log("model:", options.model, "schemaKeys:", Object.keys(options.schema.properties));
     console.log("prompt includes stagedDiffs header:", prompt.includes("Staged diff, one section per affected repo"));
     return { summaries: [{ repo: "taskTools", message: "stub summary" }] };
   };
   const args = JSON.stringify({ stagedDiffsPath: process.cwd() + "/scripts/stagedDiffs.ts" });
   workflow(args, stubAgent, null, console.log, null).then(r => console.log("RESULT:", JSON.stringify(r)));
   '
   ```
   Expect: `model: Sonnet 5`, `schemaKeys: [ 'summaries' ]`, `prompt includes stagedDiffs header: true`, and `RESULT: {"summaries":[{"repo":"taskTools","message":"stub summary"}]}`.

4. Confirm the skill body no longer runs `stagedDiffs.ts` directly:
   `grep -n "node \"\${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts\"" skills/commit-message/SKILL.md` — expect no output (no match).

5. Confirm the `Repo:`/`Message:` format block is byte-identical to the original:
   `git show HEAD:skills/commit-message/SKILL.md | tail -4` compared against the new file's last 4 lines (`` ```\nRepo: <repo name> \nMessage: <summary>\n``` ``) — expect an exact match.

6. `git status --short --untracked-files=all` — expect exactly two entries: ` M skills/commit-message/SKILL.md` (modified) and `?? skills/commit-message/commitMessage.workflow.js` (untracked new file). No other owned file changed.
