# Task 70 plan: investigate blockedBy reasons with subagents, strip disproven entries

## Design decisions (settled, not conditional)

- `blockers.workflow.js` imports the verdict vocabulary directly from
  `scripts/blockerVerdicts.ts` — `import { BLOCKER_VERDICT_VALUES,
  BLOCKER_VERDICT_SCHEMA_FRAGMENT, buildBlockerInvestigationPrompt } from
  "../../scripts/blockerVerdicts.ts"` — so `blockerVerdicts.ts` is the actual single
  source of truth for the enum, schema fragment, and prompt text, per the brief's
  requirement. This is narrower than the existing `retryAgent` duplication precedent
  in `plan.workflow.js`/`verify.workflow.js`: `retryAgent` has no shared export to
  import from and stays duplicated inline (unchanged from before), but the verdict
  values, schema fragment, and prompt builder are not restated — they are imported.
- The strip mutation (`stripDisprovenBlocker`, via its CLI) runs from the
  **orchestrator**, once per `disproven` entry, sequentially, after
  `blockers.workflow.js` returns — never from inside a subagent. Parallel subagents each
  writing `tasks.json` concurrently would race; a single sequential writer after
  collection avoids that. A `reason` string can contain `"`, `$()`, backticks,
  backslashes, or newlines, so it is never interpolated into the Bash command directly.
  Instead each call passes the entry's `reasonToken` — the exact `reason` string encoded
  by `encodeBlockerReasonToken` into a base64url token, which contains only
  `[A-Za-z0-9_-]` characters — as the third CLI argument, unquoted. The CLI decodes it
  with `decodeBlockerReasonToken` before matching, so it still removes only the one
  `{taskNum, reason}` claim a subagent actually disproved, not every entry sharing that
  blocker task number, and no raw reason text ever reaches the shell.
- `scripts/getTaskDetails.ts` (the "task details" line) and `scripts/prepareTasks.ts`
  (the "pipeline args" line) both move out of the auto-executing `!`` preamble in
  `SKILL.md` and become commands the orchestrator runs itself with Bash, positioned
  after the strip step, so both read `tasks.json` only after any disproven entries are
  already gone — a task unblocked by investigation gets its details fetched and reaches
  `prepareTasks.ts` in the same run. No change to either script's own code, and no new
  "runnable" concept — `selectRequestedTasks`'s existing filter naturally admits the
  task once its `blockedBy` entry is gone.
- `skills/tackle-tasks/plan.workflow.js`, `verify.workflow.js`, `scripts/unblockDependents.ts`,
  `scripts/getTaskDetails.ts` are not files this task edits. They are brief-provided
  references, read only for house style (schema shape, `retryAgent` pattern, CLI argv
  convention, mutation-then-write pattern, existing reason-display code). None of the
  four needs any edit for this task.

## scripts/checkBlockers.ts

Current (lines 13–24, confirmed by reading the live file):

```
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
  return blockedBy.map(b => b.taskNum).filter(b => openNumbers.has(b));
};
if (unblockedOnly) {
  process.stdout.write(requested.filter(n => openBlockersOf(n).length === 0).join(" ") + "\n");
} else {
  const lines = requested.map(n => {
    const blockers = openBlockersOf(n);
    return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${blockers.join(", ")}` : `task ${n}: unblocked`;
  });
  process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
}
```

Replace with:

```
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  return blockedBy.filter(b => openNumbers.has(b.taskNum));
};
if (unblockedOnly) {
  process.stdout.write(requested.filter(n => openBlockersOf(n).length === 0).join(" ") + "\n");
} else {
  const lines = requested.map(n => {
    const blockers = openBlockersOf(n);
    return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${JSON.stringify(blockers)}` : `task ${n}: unblocked`;
  });
  process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
}
```

Why this is safe: `openBlockersOf` now returns the full `{taskNum, reason}` entries
instead of bare numbers. The `unblockedOnly` branch only checks `.length`, unaffected.
The `--unblocked` output format (line-1 usage, feeds `getTaskDetails.ts`) is untouched —
only the non-`--unblocked` branch's rendered string changes: each blocker line now ends
with `JSON.stringify(blockers)`, e.g. `task 2: BLOCKED by open task(s)
[{"taskNum":1,"reason":"needs task 1"}]` — an unambiguous machine-parseable array, so a
reason containing a comma or parenthesis cannot be misread as a second blocker.

## scripts/blockerVerdicts.ts (NEW FILE)

File does not exist yet (owned-files check confirmed `missing: file not found on disk`).
Create with exactly this content:

```ts
// Single source of truth for blocker verdicts: allowed values, investigation prompt, reason tokens, and the strip-entry CLI.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export const BLOCKER_VERDICTS = { DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" } as const;
export const BLOCKER_VERDICT_VALUES = Object.values(BLOCKER_VERDICTS);
export type BlockerVerdict = typeof BLOCKER_VERDICT_VALUES[number];

export const BLOCKER_VERDICT_SCHEMA_FRAGMENT = { type: "string", enum: [...BLOCKER_VERDICT_VALUES] };

export function buildBlockerInvestigationPrompt(blockedTask: number, blockerTask: number, reason: string): string {
  return `Find out if task ${blockedTask} is actually blocked by task ${blockerTask} due to: ${reason}`;
}

export function encodeBlockerReasonToken(reason: string): string {
  return "r" + Buffer.from(reason, "utf8").toString("base64url");
}

export function decodeBlockerReasonToken(token: string): string {
  return Buffer.from(token.slice(1), "base64url").toString("utf8");
}

export function stripDisprovenBlocker(tasks: any[], blockedTaskNumber: number, blockerTaskNumber: number, reason: string): boolean {
  const task = tasks.find(t => t.taskNumber === blockedTaskNumber);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  const index = blockedBy.findIndex(b => b.taskNum === blockerTaskNumber && b.reason === reason);
  if (index === -1) return false;
  const remaining = [...blockedBy.slice(0, index), ...blockedBy.slice(index + 1)];
  if (remaining.length === 0) delete task.blockedBy;
  else task.blockedBy = remaining;
  return true;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [blockedArg, blockerArg, reasonTokenArg] = process.argv.slice(2);
  const blockedTaskNumber = Number(blockedArg);
  const blockerTaskNumber = Number(blockerArg);
  if (!Number.isFinite(blockedTaskNumber) || !Number.isFinite(blockerTaskNumber) || !reasonTokenArg || !/^r[A-Za-z0-9_-]*$/.test(reasonTokenArg)) {
    process.stderr.write("usage: node blockerVerdicts.ts <blockedTaskNumber> <blockerTaskNumber> <reasonToken>\n");
    process.exit(1);
  }
  const reason = decodeBlockerReasonToken(reasonTokenArg);

  const { tasksPath } = resolveTaskFiles(process.cwd());
  const tasks = readTaskFile(tasksPath);
  const removed = stripDisprovenBlocker(tasks, blockedTaskNumber, blockerTaskNumber, reason);
  if (removed) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  process.stdout.write((removed
    ? `removed blockedBy entry from task ${blockedTaskNumber} for blocker task ${blockerTaskNumber}`
    : `no matching blockedBy entry for task ${blockedTaskNumber} blocked by task ${blockerTaskNumber} with that reason`) + "\n");
}
```

Design notes tying this to the brief:
- `resolveTaskFiles`/`readTaskFile` import and CLI guard (`process.argv[1] && import.meta.url === ...`)
  copy the exact convention already used in `scripts/unblockDependents.ts` (lines 3, 29)
  and `scripts/getTaskDetails.ts` (lines 2, 43).
- `stripDisprovenBlocker`'s empty-array handling (`delete task.blockedBy` /
  `task.blockedBy = remaining`) matches `scripts/unblockDependents.ts` lines 23–24
  exactly (`if (remaining.length === 0) delete t.blockedBy; else t.blockedBy = remaining;`).
- `tasks: any[]` parameter type matches `unblockDependents`'s own exported signature
  (`export function unblockDependents(tasks: any[], ...)`, line 5) rather than the
  stricter `TaskRecord[]` used in `getTaskDetails.ts` — kept consistent with the sibling
  mutation function's own precedent.
- `stripDisprovenBlocker` removes exactly one entry, never every entry that happens to
  share the same `taskNum`/`reason` pair: `findIndex` locates only the first matching
  index, and `[...blockedBy.slice(0, index), ...blockedBy.slice(index + 1)]` drops that
  one index only. A `.filter()` predicate would instead drop every entry matching the
  predicate, including duplicates — wrong when the same `{taskNum, reason}` claim
  legitimately appears twice (e.g. two different investigation pairs produced the same
  text). One CLI invocation must remove one entry.
- The CLI takes three positional arguments (`<blockedTaskNumber> <blockerTaskNumber>
  <reasonToken>`) because one task can have more than one `blockedBy` entry against the
  same blocker task number with different reasons; matching on `taskNum` alone would
  remove every entry sharing that blocker instead of only the one claim a subagent
  actually disproved. The third argument is a base64url token, not the raw reason text —
  `reason` strings come from investigator notes and can contain `"`, `$()`, backticks,
  backslashes, or newlines, none of which are safe to interpolate into a Bash argument.
  `encodeBlockerReasonToken`/`decodeBlockerReasonToken` round-trip through
  `Buffer.from(..., "utf8")`/`Buffer.from(..., "base64url")` (Node's built-in base64url
  encoding, no new dependency), so the CLI decodes the token first, then matches the
  decoded `reason` against the entry's `reason` string exactly (`===`). A same-`taskNum`
  entry with a different reason is left untouched, and a call whose decoded reason
  doesn't exactly match any entry writes nothing and reports no match.
- Every token is prefixed with a literal `r` (`encodeBlockerReasonToken` returns
  `"r" + base64url`, `decodeBlockerReasonToken` decodes `token.slice(1)`), so an empty
  `reason` string still produces the non-empty token `"r"` instead of the empty string —
  an empty CLI argument would otherwise vanish when passed unquoted, making the
  empty-reason case unremovable. The CLI guard validates the raw token against
  `/^r[A-Za-z0-9_-]*$/` before decoding, so a malformed or unprefixed token is rejected
  with the usage message rather than silently mis-decoded. The `[A-Za-z0-9_-]` character
  class referenced above still holds with the `r` prefix included.
- `BLOCKER_VERDICTS` (`{ DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" }`) is
  the single source of truth for the two literal verdict strings; `BLOCKER_VERDICT_VALUES`
  is derived from it via `Object.values(...)` rather than restated as its own literal
  array. `blockers.workflow.js` and its schema/prompt/comparisons reference
  `BLOCKER_VERDICTS.DISPROVEN`/`BLOCKER_VERDICTS.STILL_BLOCKED` — no hardcoded
  `'disproven'`/`'still-blocked'` string literal appears anywhere outside this file.

## skills/tackle-tasks/blockers.workflow.js (NEW FILE)

File does not exist yet (owned-files check confirmed `missing: file not found on disk`).
Create with exactly this content:

```js
import { BLOCKER_VERDICTS, BLOCKER_VERDICT_VALUES, BLOCKER_VERDICT_SCHEMA_FRAGMENT, buildBlockerInvestigationPrompt, encodeBlockerReasonToken } from '../../scripts/blockerVerdicts.ts'

export const meta = {
  name: 'tackle-tasks-blockers',
  description: 'Investigate each blocked-task/blocker pair with one subagent, so a disproven reason can be stripped before the run',
  phases: [{ title: 'Blockers', detail: 'one investigator per blocked-task/blocker pair' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PAIRS = ARGS.pairs ?? []

const BLOCKER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: BLOCKER_VERDICT_SCHEMA_FRAGMENT,
    notes: { type: 'string' },
  },
  required: ['id', 'verdict', 'notes'],
}

const pairId = (pair) => JSON.stringify([pair.blockedTask, pair.blockerTask, pair.reason])

const investigatorBrief = (pair) => `Invoke /ponytail:ponytail ultra.
${buildBlockerInvestigationPrompt(pair.blockedTask, pair.blockerTask, pair.reason)}

Source code and git history are the truth for this project — do not trust stale docs. Read the codebase and recent git history/commits (git log, git show) to check whether that reason still holds against the current state of the code. You may run read-only Bash and Read commands; do not edit any file.

Return verdict "${BLOCKER_VERDICTS.DISPROVEN}" only if you find clear evidence in the current code or git history that the reason no longer applies. Otherwise, or if you cannot tell, return verdict "${BLOCKER_VERDICTS.STILL_BLOCKED}" — when unsure, stay blocked.

Return {id: ${JSON.stringify(pairId(pair))}, verdict, notes} where notes explains what you found. The id must be copied exactly as given — it is how the orchestrator matches your answer back to this pair.`

log(`investigating ${PAIRS.length} blocker reason(s)`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const results = await parallel(PAIRS.map((pair) => () =>
  retryAgent(() => agent(investigatorBrief(pair), {
    label: `blocker:${pair.blockedTask}:${pair.blockerTask}`,
    phase: 'Blockers',
    schema: BLOCKER_SCHEMA,
  }))))

const isValidVerdict = (pair, result) =>
  result != null
  && result.id === pairId(pair)
  && BLOCKER_VERDICT_VALUES.includes(result.verdict)
  && typeof result.notes === 'string'

const verdicts = PAIRS.map((pair, i) => {
  const result = results[i]
  const valid = isValidVerdict(pair, result)
  return {
    ...pair,
    reasonToken: encodeBlockerReasonToken(pair.reason),
    verdict: valid && result.verdict === BLOCKER_VERDICTS.DISPROVEN ? BLOCKER_VERDICTS.DISPROVEN : BLOCKER_VERDICTS.STILL_BLOCKED,
    notes: valid
      ? result.notes
      : result == null
        ? 'investigator agent returned no result after 3 attempts (killed, errored, or blocked)'
        : 'investigator agent returned a malformed or mismatched result (bad id, verdict, or notes) — treated as still-blocked',
  }
})

return {
  disproven: verdicts.filter((v) => v.verdict === BLOCKER_VERDICTS.DISPROVEN),
  stillBlocked: verdicts.filter((v) => v.verdict === BLOCKER_VERDICTS.STILL_BLOCKED),
}
```

Design notes tying this to the brief:
- `BLOCKER_SCHEMA` is a flat object with `id` (string), `verdict` (enum), `notes`
  (string), all three in `required` — matching the house style set by `PLAN_SCHEMA`
  (`plan.workflow.js` lines 11–22) and `VERIFY_SCHEMA` (`verify.workflow.js` lines
  11–21). The `verdict` field reuses `BLOCKER_VERDICT_SCHEMA_FRAGMENT` imported from
  `scripts/blockerVerdicts.ts` — the enum values are not restated here, per the Design
  decisions section above.
- `investigatorBrief`'s opening question line is `buildBlockerInvestigationPrompt`'s own
  return value, imported and called directly — not duplicated prose — so the question a
  subagent sees and the text `blockerVerdicts.ts` defines are byte-identical, matching
  the brief's user-request phrasing: `"find out if task N is actually blocked by task M
  due to <reason>"`.
- `pairId` builds the expected `id` as `JSON.stringify([blockedTask, blockerTask,
  reason])` — a value unique to this exact `{taskNum, reason}` claim, not just the
  blocker task number. `isValidVerdict` requires the returned `id` to match this exactly
  (`===`), the returned `verdict` to be one of the imported `BLOCKER_VERDICT_VALUES`, and
  `notes` to be a string — the schema is a hint to the model, not a guarantee, so the
  workflow re-checks the shape itself before trusting `verdict === 'disproven'`.
- `retryAgent` (3-attempt null-result guard) is copied verbatim from `plan.workflow.js`
  lines 78–84 / `verify.workflow.js` lines 89–95, including the same `// ponytail: ...
  Duplicated per file.` comment convention — it has no counterpart export in
  `blockerVerdicts.ts` to import, unlike the verdict vocabulary above.
- The conservative-default constraint ("absent, malformed, or unreachable verdict means
  the task stays blocked") is enforced by `isValidVerdict` plus the ternary in the
  `verdicts` map: a `null` result (dead subagent, exhausted retries), a mismatched or
  missing `id`, a `verdict` outside `BLOCKER_VERDICT_VALUES`, a non-string `notes`, or
  any `verdict` value other than the literal string `'disproven'` all collapse to
  `'still-blocked'`. This is the synthesized-fallback idea from `verify.workflow.js`
  lines 104–110, adapted: fallback verdict is `'still-blocked'`, never `'disproven'`.
- No string literal `'disproven'` or `'still-blocked'` appears anywhere in this file.
  The prompt text interpolates `BLOCKER_VERDICTS.DISPROVEN`/`BLOCKER_VERDICTS.STILL_BLOCKED`,
  the verdict-defaulting ternary compares against and returns those same constants, and
  the final `disproven`/`stillBlocked` bucket filters compare against them too —
  `scripts/blockerVerdicts.ts` is the only place either literal string is written.
- The mutation (`stripDisprovenBlocker`/its CLI) is deliberately **not** called from
  inside this workflow or from inside a subagent brief — see Design decisions above.
  This workflow only investigates and reports; `SKILL.md` performs the strip
  sequentially after collecting `disproven`.
- Every returned verdict (both `disproven` and `stillBlocked`) carries a `reasonToken`
  field — `pair.reason` encoded with `encodeBlockerReasonToken`, imported from
  `scripts/blockerVerdicts.ts` — alongside the plain `reason` string already spread in
  from `...pair`. `SKILL.md` reads `reasonToken` off each `disproven` entry and passes it
  unquoted to `blockerVerdicts.ts`'s CLI; it never passes the raw `reason` string to a
  shell command.

## tests/checkBlockers.test.ts

The non-`--unblocked` output is now a JSON array per blocker line
(`task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]`), so every
assertion that inspects that branch's exact text changes — the old `/open task\(s\) 1/`
regex no longer matches, since `1` no longer appears immediately after `open task(s) `.
Only the `--unblocked` test is untouched. Replace the whole file's content with:

```ts
// checkBlockers.ts: a task is BLOCKED only by still-open blockers; closed ones don't count. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "checkBlockers.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "open blocker" },
      { taskNumber: 2, title: "blocked by open task", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
  const out = runScript(makeProjectRoot(), "2", "4", "1");
  assert.match(out, /task 2: BLOCKED by open task\(s\) \[\{"taskNum":1,"reason":"needs task 1"\}\]/);
  assert.match(out, /task 4: unblocked/);
  assert.match(out, /task 1: unblocked/);
});

test("--unblocked prints only unblocked numbers, space-separated", () => {
  const out = runScript(makeProjectRoot(), "--unblocked", "2", "4", "1");
  assert.equal(out, "4 1\n");
});

test("no task numbers checks every open task", () => {
  const out = runScript(makeProjectRoot());
  assert.match(out, /task 1: unblocked/);
  assert.match(out, /task 2: BLOCKED by open task\(s\) \[\{"taskNum":1,"reason":"needs task 1"\}\]/);
  assert.match(out, /task 4: unblocked/);
});

test("non-numeric args like 'valid' are ignored", () => {
  const out = runScript(makeProjectRoot(), "2", "valid");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]\n');
});

test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, 'task 2: BLOCKED by open task(s) [{"taskNum":1,"reason":"needs task 1"}]\n');
});
```

## tests/blockerVerdicts.test.ts (NEW FILE)

File does not exist yet (owned-files check confirmed `missing: file not found on disk`).
Create with exactly this content. It covers the exported vocabulary/schema/prompt/token
contract directly via import, then exercises the 3-argument CLI (`<blockedTaskNumber>
<blockerTaskNumber> <reasonToken>`) mirroring the style already used by
`tests/checkBlockers.test.ts` (temp project root via `mkdtempSync`, `execFileSync`
running the `.ts` file directly with `node`). Every CLI call passes a token built with
`encodeBlockerReasonToken`, never a raw reason string, matching how `SKILL.md` will call
it. Nine tests total, including the empty-reason token round-trip and its CLI removal:

```ts
// blockerVerdicts.ts: exported verdict vocabulary/schema/prompt/token helpers, and the CLI that strips one exact disproven blockedBy entry. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKER_VERDICTS,
  BLOCKER_VERDICT_VALUES,
  BLOCKER_VERDICT_SCHEMA_FRAGMENT,
  buildBlockerInvestigationPrompt,
  encodeBlockerReasonToken,
  decodeBlockerReasonToken,
} from "../scripts/blockerVerdicts.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "blockerVerdicts.ts");

test("exports the verdict vocabulary, derived values, schema fragment, and a token round-trip for Unicode and shell-metacharacter reasons", () => {
  assert.deepEqual(BLOCKER_VERDICTS, { DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" });
  assert.deepEqual(BLOCKER_VERDICT_VALUES, ["disproven", "still-blocked"]);
  assert.deepEqual(BLOCKER_VERDICT_SCHEMA_FRAGMENT, { type: "string", enum: ["disproven", "still-blocked"] });
  const reason = 'needs "task 1" $(rm -rf /) `whoami` \\ backslash 日本語 emoji 🎉\nline two';
  const token = encodeBlockerReasonToken(reason);
  assert.match(token, /^r[A-Za-z0-9_-]*$/);
  assert.equal(decodeBlockerReasonToken(token), reason);
});

test("encodeBlockerReasonToken/decodeBlockerReasonToken round-trip an empty reason as the bare 'r' token", () => {
  const token = encodeBlockerReasonToken("");
  assert.equal(token, "r");
  assert.equal(decodeBlockerReasonToken(token), "");
});

test("buildBlockerInvestigationPrompt renders the exact investigation question", () => {
  assert.equal(
    buildBlockerInvestigationPrompt(70, 69, "needs task 69"),
    "Find out if task 70 is actually blocked by task 69 due to: needs task 69",
  );
});

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-blockerVerdicts-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      {
        taskNumber: 2,
        title: "blocked by two claims against the same task",
        blockedBy: [
          { taskNum: 1, reason: "needs task 1" },
          { taskNum: 1, reason: "also needs task 1 for docs" },
          { taskNum: 5, reason: "needs task 5" },
        ],
      },
      { taskNumber: 4, title: "blocked by one", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
      {
        taskNumber: 6,
        title: "blocked by two identical claims",
        blockedBy: [
          { taskNum: 1, reason: "needs task 1" },
          { taskNum: 1, reason: "needs task 1" },
        ],
      },
      { taskNumber: 7, title: "blocked with an empty reason", blockedBy: [{ taskNum: 1, reason: "" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

test("removes only the exact matching entry, keeping a same-taskNum entry with a different reason", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "2", "1", encodeBlockerReasonToken("needs task 1"));
  assert.equal(out, "removed blockedBy entry from task 2 for blocker task 1\n");
  const task2 = readTasks(root).find((t: any) => t.taskNumber === 2);
  assert.deepEqual(task2.blockedBy, [
    { taskNum: 1, reason: "also needs task 1 for docs" },
    { taskNum: 5, reason: "needs task 5" },
  ]);
});

test("deletes blockedBy entirely when the last entry is removed", () => {
  const root = makeProjectRoot();
  runScript(root, "4", "3", encodeBlockerReasonToken("needs task 3"));
  const task4 = readTasks(root).find((t: any) => t.taskNumber === 4);
  assert.equal("blockedBy" in task4, false);
});

test("reports no match and leaves tasks.json untouched when the decoded reason doesn't match", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "2", "1", encodeBlockerReasonToken("some other reason entirely"));
  assert.equal(out, "no matching blockedBy entry for task 2 blocked by task 1 with that reason\n");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("reports no match and leaves tasks.json untouched when the pair doesn't exist", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "2", "99", encodeBlockerReasonToken("needs task 99"));
  assert.equal(out, "no matching blockedBy entry for task 2 blocked by task 99 with that reason\n");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("two identical blockedBy entries: one CLI invocation removes exactly one", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "6", "1", encodeBlockerReasonToken("needs task 1"));
  assert.equal(out, "removed blockedBy entry from task 6 for blocker task 1\n");
  const task6 = readTasks(root).find((t: any) => t.taskNumber === 6);
  assert.deepEqual(task6.blockedBy, [{ taskNum: 1, reason: "needs task 1" }]);
});

test("removes a blockedBy entry whose reason is the empty string, via the bare 'r' token", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "7", "1", encodeBlockerReasonToken(""));
  assert.equal(out, "removed blockedBy entry from task 7 for blocker task 1\n");
  const task7 = readTasks(root).find((t: any) => t.taskNumber === 7);
  assert.equal("blockedBy" in task7, false);
});
```

## skills/tackle-tasks/SKILL.md

Two edits, both inside the unnumbered preamble (lines 8–18 of the live file); the six
numbered steps (Step 1 plan at line 41 through Step 6 merge at line 79) are untouched.

**Edit 1** — drop both the "task details" bullet and the "pipeline args" bullet from
the auto-executing preamble list, leaving only "blocked status". Both become
manually-run commands later, added in Edit 2, because both must run *after*
investigation and stripping now — a task whose blocker was just disproven must have
its details fetched and must reach `prepareTasks.ts`, neither of which happened when
these two ran unconditionally before investigation.

Current (lines 8–10, exact):

```
- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`
- task details (unblocked tasks only): !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS'); [ -n "$u" ] && node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$u" || echo "none of the requested tasks are unblocked"`
- pipeline args: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`
```

Replace with:

```
- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`
```

**Edit 2** — replace the line-14 refusal sentence with investigation instructions plus
the now-manual task-details and pipeline-args commands. This is the exact single line
at line 14 of the live file (surrounding blank lines at 13 and 15 are untouched, so
paragraph spacing is preserved):

Current (line 14, exact):

```
Do not work on any task reported as BLOCKED in the "blocked status" above — report its open blockers and move on to the next requested task that is unblocked.
```

Replace with:

```
Every task reported BLOCKED above lists its open blocker(s) as a JSON array — investigate before trusting the report. Parse each BLOCKED line's JSON array into one `{ blockedTask, blockerTask, reason }` entry per element (`blockedTask` is the task number named in "task N: BLOCKED", `blockerTask` is that element's `taskNum`, `reason` is that element's `reason` taken verbatim). Call Workflow with scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/blockers.workflow.js`, args `{ pairs }` where `pairs` is the full list built this way across every BLOCKED task above. It returns `{ disproven, stillBlocked }`, where every entry also carries a `reasonToken` — the entry's `reason` string encoded as a base64url token, safe to use as a bare shell word. For every entry in `disproven`, in order, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/blockerVerdicts.ts" <blockedTask> <blockerTask> <reasonToken>` with Bash to strip that exact blockedBy entry from tasks.json, passing the entry's `reasonToken` value unquoted as the third argument — a base64url token contains only `[A-Za-z0-9_-]` characters, so it needs no quoting. Never substitute the raw `reason` string into this command; it can contain characters unsafe in a shell argument. Do not work on any task with an entry left in `stillBlocked` — report those open blockers and move on to the next requested task that is unblocked. If nothing was reported BLOCKED, skip straight to the next paragraph.

Now get task details and the pipeline args yourself with Bash, in this order, so both run after any stripping above and see a disproven task as runnable, using only commands that start with `node` (the skill's `allowed-tools` permits `Bash(node *)`, not compound shell commands like `u=$(...)`): first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS'` and read its output. If that output is non-empty, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <output>`, substituting the exact output text (the space-separated task numbers) in place of `<output>`. If that output is empty, skip that command and report "none of the requested tasks are unblocked" yourself instead. Then, regardless of the previous step, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`.
```

Everything from line 16 onward (`Invoke /ponytail:ponytail ultra.`, the `valid`
clause, `## Verification`, `## Running the pipeline`, and all six numbered steps) is
untouched by these two edits — Edit 2's replacement block is inserted in place of line
14 only, so the file's existing structure after that point is preserved verbatim.

## Files needing no edit

Task 70 edits exactly five files: `scripts/blockerVerdicts.ts` (new),
`scripts/checkBlockers.ts`, `skills/tackle-tasks/blockers.workflow.js` (new),
`skills/tackle-tasks/SKILL.md`, and adds two new test files
(`tests/blockerVerdicts.test.ts`, `tests/checkBlockers.test.ts`).

Four files are brief-provided references, read only for house style and not edited:

- **skills/tackle-tasks/plan.workflow.js** — the house-style reference for
  `PLAN_SCHEMA`'s shape and the `retryAgent` duplication pattern that
  `blockers.workflow.js` copies. No line in this file changes for task 70.
- **skills/tackle-tasks/verify.workflow.js** — the house-style reference for
  `VERIFY_SCHEMA`'s shape, the `retryAgent` pattern, and the synthesized-fallback
  idea (lines 104–110) that `blockers.workflow.js`'s verdict-defaulting logic adapts.
  No line in this file changes for task 70.
- **scripts/unblockDependents.ts** — the reference for the CLI argv convention
  (`process.argv[1] && import.meta.url === ...`) and the `delete t.blockedBy` /
  `t.blockedBy = remaining` empty-array pattern that `scripts/blockerVerdicts.ts`'s
  `stripDisprovenBlocker` copies. No line in this file changes for task 70.
- **scripts/getTaskDetails.ts** — its `listTaskTitles` (line 15) already renders
  `blockedBy` entries as `${taskNum} (${reason})`, and `checkBlockers.ts`'s
  `--unblocked` output — the only part of `checkBlockers.ts` this file consumes — is
  unchanged by this task's edits. No line in this file changes for task 70.

Six more files are owned by task 62 (per `tasks.json`), which also edits
`skills/tackle-tasks/SKILL.md` to add commit-message/staging behavior. They are listed
here only to confirm task 70 does not touch or interact with them: `scripts/stage-and-summarize-stop.ts`,
`scripts/stagedDiffs.ts`, `skills/commit-message/SKILL.md`,
`skills/tackle-tasks/COMMIT_MESSAGES.md`, `skills/update-tasks/SKILL.md`,
`tests/commitMessageSubagent.test.ts`. Task 70's edits to `SKILL.md` are confined to the
unnumbered preamble (lines 8–14) — blocked-status reporting and the investigation
instructions — and do not alter staging, commit-message, update-task, or
commit-message-subagent behavior. None of these six files changes for task 70.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

```
node --test tests/checkBlockers.test.ts tests/blockerVerdicts.test.ts
```

Expected: all 5 `checkBlockers.test.ts` tests pass against the new JSON-array output
(3 `match`-based, 2 exact-match, all rewritten above), and all 9
`blockerVerdicts.test.ts` tests pass (1 covering the exported vocabulary/derived
values/schema/token round-trip, 1 covering the empty-reason token round-trip, 1
covering `buildBlockerInvestigationPrompt`, 6 exercising the 3-argument CLI including
the two-identical-entries case and the empty-reason removal case) — `# pass 14`,
`# fail 0` in the node:test summary.

Smoke-test the new CLI directly against a scratch project to confirm both the "removed"
and "no match" output strings, and the pretty-printed JSON it writes, match this plan's
design exactly. The third argument is the `r`-prefixed base64url token for the reason
`"needs task 1"`, precomputed as `rbmVlZHMgdGFzayAx`
(`"r" + Buffer.from("needs task 1", "utf8").toString("base64url")`):

```
mkdir -p /tmp/blocker-cli-check && cd /tmp/blocker-cli-check && \
  echo '[{"taskNumber":2,"blockedBy":[{"taskNum":1,"reason":"needs task 1"}]}]' > tasks.json && \
  echo '[]' > completedTasks.json && \
  node /Users/matkatmusicllc/Programming/taskTools/scripts/blockerVerdicts.ts 2 1 rbmVlZHMgdGFzayAx && \
  cat tasks.json
```

Expected: prints `removed blockedBy entry from task 2 for blocker task 1`, and
`tasks.json` now shows the pretty-printed (2-space indented) JSON that
`JSON.stringify(tasks, null, 2) + "\n"` actually writes:

```
[
  {
    "taskNumber": 2
  }
]
```

(no `blockedBy` key — deleted since the array emptied).

Finally, smoke-test the new workflow file through the Workflow tool itself, not
`node --check` — `blockers.workflow.js` is a Workflow DSL file with a top-level
`return` statement and injected `agent`/`parallel`/`log`/`args` globals that ordinary
Node does not provide, so plain Node cannot parse or run it. Call Workflow with
scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/blockers.workflow.js` and args
`{"pairs":[]}`. With an empty `pairs` array, `TASKS`/`PAIRS` is empty, no subagent is
spawned, and `verdicts` maps to an empty array, so the call must return exactly:

```
{"disproven": [], "stillBlocked": []}
```
