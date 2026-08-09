# Workflow-only context injection

Here is how to get shell command output to not land in the main agent's context window and stay exclusively in a workflow agent's prompt.

## Why it has to be done this way

A `.workflow.js` script cannot run a command. `require` and `process` are `undefined`, and an `import` statement is rejected because `meta` must be the first statement. `` !`cmd` `` expands only in a SKILL.md body, never in an `agent()` prompt. Re-verify both with `probes/sandboxProbe.workflow.js`.

So the command has exactly two places to run: the main agent's shell, or the workflow agent's Bash. Only the second keeps the output out of the main agent.

## Steps

Names below use the commit-message skill as the worked example. Substitute your own.

1. **Make the data script return instead of print.** Wrap the top-level body of the data script (`stagedDiffs.ts`) in `export function stagedDiffs(): string`, returning the text it used to write. Keep it runnable alone with a main guard: `if (process.argv[1]?.endsWith("stagedDiffs.ts")) process.stdout.write(stagedDiffs())`.

2. **Move the workflow agent's prompt into a brief script.** Create `<name>DiffBrief.ts` next to it: `export const commitDiffBrief = (diffs: string) => \`<prompt text>\n\n${diffs}\`` with the data interpolated **last**, long content at the end. Same main guard: `if (process.argv[1]?.endsWith("commitDiffBrief.ts")) process.stdout.write(commitDiffBrief(stagedDiffs()))`.

3. **Reduce the workflow's prompt to one instruction.** In `<name>.workflow.js`, the whole prompt becomes `Run \`node ${ARGS.commitDiffBriefPath}\` with Bash and follow the instructions it prints.` Keep the schema on the `agent()` call so the return shape is enforced. Never import anything here.

4. **Move the SKILL.md body into an emitter script.** Create `<name>MessageBrief.ts` that resolves absolute paths from `import.meta.url` — `fileURLToPath(new URL("../skills/<name>/<name>.workflow.js", import.meta.url))` — and prints the ready-to-run call: `WORKFLOW: {"scriptPath": "<path>", "args": {"commitDiffBriefPath": "<path>"}}` followed by `execute \`Workflow(WORKFLOW)\``, the return shape, and the report format. Paths must be absolute; the reading agent's shell has no `CLAUDE_PLUGIN_ROOT`.

5. **Empty the SKILL.md body.** After the frontmatter, the only content is the emitter call:
   ````
   ```!
   node "${CLAUDE_PLUGIN_ROOT}/scripts/commitMessageBrief.ts"
   ```
   ````
   Add `allowed-tools: Bash(node *)` to the frontmatter.

6. **Execute the data script in the brief script, not in the SKILL.md.** This is the whole point. The emitter (step 4) prints paths only — it must never import the data script or run a subprocess. Guard it: `rg -n 'execFileSync|spawn|<dataScript>' scripts/<name>MessageBrief.ts` must return no hits.

## Verify

- `node scripts/<name>MessageBrief.ts` — prints paths and instructions, no data.
- `node scripts/<name>DiffBrief.ts` — prints the prompt with the data appended.
- `node scripts/<dataScript>.ts` — output byte-identical to before the refactor; diff it against `git show HEAD:scripts/<dataScript>.ts`.
- Invoke the skill for real. The workflow agent should reach the answer in about two tool calls, and the data must not appear anywhere in the main agent's transcript.
