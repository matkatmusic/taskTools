# Task 182 plan: restore the two retired instruction paragraphs as comments

## Scope

One edit, one file: `scripts/tackleTasksBrief.ts`. `tests/tackleTasksBrief.test.ts` needs no edit — it asserts only on the string returned by `tackleTasksBrief(...)` (built and returned above line 185, before the `};` that closes it), and the RETIRED block being edited sits entirely below that closing `};`, outside the template literal, so it changes no test-observable output.

## Recovered text (verbatim, from `git show 6948357^:scripts/tackleTasksBrief.ts`, lines 120 and 124)

Confirmed byte-identical against `git show 6948357 -- scripts/tackleTasksBrief.ts`'s `-` diff lines for the same two paragraphs.

Paragraph 1 (source line 120 of the pre-6948357 file):
```
Close every task that is not problematic and was completed successfully, rendering its \`tasks.json\` entry stale, with **one** invocation of the \`close-tasks\` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — \`[268,270,281]\` — followed by your reasoning for the \`closureNote\`s, naming each task (\`#268 …, #270 …\`) when the reasons differ.
```

Paragraph 2 (source line 124 of the pre-6948357 file):
```
During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside \`close-tasks\`, after the user approves closing.
```

Both paragraphs are copied with their original backslash-escaped backticks (`\``) intact, exactly as they appeared inside the old template literal — this is a byte-for-byte recovery, not a re-render, matching how `scripts/runMergePhase.ts`'s `// RETIRED (task 147): ...` blocks preserve the exact original source text of what they retired (e.g. lines 3–9, 18–23 of that file).

## Edit 1 — `scripts/tackleTasksBrief.ts`

Current text, lines 185–190:
```
  return brief;
};

// RETIRED (task 163): old close-tasks-skill text superseded by task 152's closeTasks.ts call; see git history.

function readStdin(): string {
```

Becomes: the same six lines, with four new lines inserted between the `RETIRED (task 163)` line and the following blank line, in this exact order:
1. a bare `//` line
2. one line consisting of `// ` immediately followed by Paragraph 1 (quoted verbatim in "Recovered text" above), all on that single line
3. a bare `//` line
4. one line consisting of `// ` immediately followed by Paragraph 2 (quoted verbatim in "Recovered text" above), all on that single line

So the file reads, immediately after line 188 (`// RETIRED (task 163): ...`): a bare `//`, then `// ` + Paragraph 1 as one line, then a bare `//`, then `// ` + Paragraph 2 as one line, then the existing blank line, then the existing `function readStdin(): string {`.

Use the `Edit` tool with `old_string` set to the "Current text, lines 185–190" block above, and `new_string` set to that same block with the four lines just described inserted after the `RETIRED (task 163)` line and before the blank line that precedes `function readStdin`. The `old_string` block is unique in the file — it is the only occurrence of the `RETIRED (task 163)` line, which sits right after the `tackleTasksBrief` function's closing `};` and right before `function readStdin`.

This is a pure comment addition: the existing tombstone line and blank-line-then-`function readStdin` structure are preserved; two commented paragraphs, each prefixed with `//`, and separated from the tombstone and from each other by bare `//` lines, are inserted between them. Nothing inside the `tackleTasksBrief` template literal (lines 32–184) changes, so the function's return value is byte-identical to before.

## Files accounted for

- `scripts/tackleTasksBrief.ts` — Edit 1 above.
- `tests/tackleTasksBrief.test.ts` — no edit. Every assertion in this file operates on the string returned by `tackleTasksBrief(...)` or on `execFileSync` output of running the script, both of which come only from the return statement at line 185 and everything above it. The RETIRED block starts at line 188, after the function body has already closed and returned, and comments contribute nothing to `execFileSync` stdout either (comments are not `console.log`/`process.stdout.write` calls). No test regex or fixture inspects source-file bytes below line 185.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

1. `npx tsc --noEmit` — expect no output and exit code 0 (comments cannot introduce a type error).
2. `npm test` — expect all tests in `tests/tackleTasksBrief.test.ts` (and the rest of the suite) to pass, in particular the byte-comparison-style tests `"brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or \$ARGUMENTS placeholder"` and `"script reads arguments from stdin and embeds the live checkBlockers.ts output"`, confirming the emitted brief text is unchanged.
3. `git diff scripts/tackleTasksBrief.ts` — expect the diff to show only the insertion of four new lines (two bare `//` separator lines plus the two `//`-prefixed paragraph lines) immediately after line 188, with no change to any line above it.
