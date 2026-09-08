# Task 7 plan — path-aware JSON reader, atomic writes, and validated agent-owned reads

Codex-corrected scope (`plans/pipeline-audit-codex-20260905-113523.md`, "High: task 7's path-aware parse remedy cannot work as described"): "let parse throw with the path in the message" cannot work for a non-empty, truncated file — `JSON.parse()` never includes the source path in its own error. Verified empirically:

```
$ node -e 'try { JSON.parse("{\"a\":"); } catch (e) { console.log(e.message); }'
Unexpected end of JSON input
```

and separately:

```
$ node -e 'try { readFileSync("/tmp/does-not-exist.json", "utf8"); } catch (e) { console.log(e.message); }'
ENOENT: no such file or directory, open '/tmp/does-not-exist.json'
```

So `readFileSync` already names the path for a **missing** file (no extra code needed). The one real gap is an **existing-but-empty** file, where `JSON.parse("")` throws `Unexpected end of JSON input` with no path. A non-empty-but-corrupt file (a genuine mid-write truncation, e.g. `{"a":`) still cannot be made to carry the path without wrapping `JSON.parse` in a try/catch — which the user's CLAUDE.md forbids ("If something fails, let it throw"; no try/catch, no fallback). This plan accepts that limitation: the reader's own checks name the path; a malformed-but-nonempty parse throws unwrapped, exactly as CLAUDE.md requires.

Tasks 18 and 22 depend on this plan: both call `commitTaskWork`/`writeAgentAnswer`-adjacent consumer code that this plan does not touch, but task 18's four-branch workflow test and task 22's `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED` fix assume `writeAgentAnswer.ts`'s validated-merge behavior and the packet/checkpoint atomic-write shape this plan does not change (task 7 does not touch `writeAgentAnswer.ts`'s validation, only the reader used elsewhere) — no ordering conflict, but both later plans should land on top of this one so `scripts/tackle-tasks/shared/readJsonFile.ts` already exists.

## Scope confirmation

All line numbers below were re-verified live against the current working tree (not the audit's own citations, several of which have drifted — noted explicitly where they have).

- **`scripts/tackle-tasks/shared/readJsonFile.ts`** — does not exist. New file, created by this plan.

- **`scripts/runStepHook.ts`**
  - Lines 19–25, today (the top-level uncaught-exception handler, registered first so a throw while the file loads still reports):
    ```ts
    process.on("uncaughtException", (error: Error) => {
        const reason = `run-step hook failed: ${error.stack ?? error.message}`;
        process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
        mkdirSync(dirname(logFile()), { recursive: true });
        const runLogEntries = existsSync(logFile()) ? JSON.parse(readFileSync(logFile(), "utf8")) : [];
        runLogEntries.push({ block: "HOOK EXCEPTION", reason });
        writeFileSync(logFile(), `${JSON.stringify(runLogEntries, null, 4)}\n`);
    ```
    Line 23 parses the run log; line 25 rewrites it with plain `writeFileSync` (non-atomic).
  - Lines 123–129, today (`appendStepToRunLog`): line 126 parses the run log the same way, line 128 rewrites it the same non-atomic way.
  - Lines 204–211, today (`buildFailure`): line 206 parses the run log, line 208 rewrites it non-atomically. **Not named in task 7's own text**, but it is the exact same read-modify-write-run-log pattern as the two sites task 7 does name, and task 7's own fix (b) says "writeJsonAtomically for every pipeline-owned state file: packet, checkpoint, run log" (every, not "these two"). In scope.
  - Lines 281–284, today (inside `walkFromStep`, logging the agent's own elapsed time after a prompt answer): line 282 parses the run log, line 284 rewrites it non-atomically. Same pattern again.
  - Line 273, today: `const { prompt: _prompt, startedAt, ...packet } = JSON.parse(readFileSync(startPacket.packetFile, "utf8"));` — parses the packet file an agent's `writeAgentAnswer.ts` call already wrote into. This is the exact line the audit cites as `runStepHook.ts:273`; confirmed live at that line.
  - Line 259, today: `writeJsonAtomically(payload, packet);` inside `buildSuccess` — **already atomic**. Confirms `writeJsonAtomically` (from `scripts/taskStateLock.ts:55-65`) is the established shared writer this plan reuses everywhere else; this plan does not touch this line.

- **`scripts/taskStateLock.ts`**, lines 55–65, today — `writeJsonAtomically` already exists (open a `.tmp` file with `wx`, write, `fsyncSync`, `renameSync`). This plan reuses it as-is; no changes to this file.

- **`scripts/tackle-tasks/shared/checkpoint.ts`**
  - Lines 23–27, today (`readCheckpoint`): `if (!existsSync(path)) return null; return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;` — parses without an empty-content check.
  - Lines 29–33, today (`writeCheckpoint`): `writeFileSync(path, \`${JSON.stringify(checkpoint, null, 4)}\n\`);` — non-atomic write. Confirmed live at these exact lines; matches the audit's `checkpoint.ts:29-32` citation (off by one from the doc comment line, but the same statement).
  - No test asserts the exact byte content of `checkpoint.json` (`rg -n "checkpoint.json" tests scripts` shows only an `existsSync` check in `tests/clarifyTask.test.ts:49`); switching the write's indent from 4 spaces (`JSON.stringify(..., null, 4)`) to `writeJsonAtomically`'s 2 spaces is safe.

- **`scripts/tackle-tasks/shared/readReviewJson.ts`**, lines 1–16, today — strips a possible markdown code fence from the file's text, then calls `JSON.parse(body)` at line 15. This file's own fence-stripping means it cannot simply delegate to `readJsonFile.ts` (that reader has no fence-stripping); it gets its own equivalent empty-check inline.

- **`scripts/tackle-tasks/whatIsReviewVerdict/WHAT_IS_REVIEW_VERDICT.ts`**
  - Line 29, today, inside `decideVerdict`: `const plan = JSON.parse(readFileSync(planFile, "utf8"));`
  - Line 44, today, inside `applyFixesToPlan`: `const plan = JSON.parse(readFileSync(planFile, "utf8"));`
  - Line 61, today: `const review = readReviewJson(packet.reviewOutputFile) as PlanReview;` — already routes through `readReviewJson`, which this plan hardens directly (see above); no change needed at this call site itself.
  - Line 55, today: `writeJsonAtomically(planFile, plan);` — already atomic; confirms the same shared writer is already in use here.

- **`scripts/tackle-tasks/resetTask.ts`** — the audit cites `resetTask.ts:69`. That line number has drifted: `git diff HEAD -- scripts/tackle-tasks/resetTask.ts` shows this file gained an `async`/`scope`/dynamic-`import` block (about 10 new lines) ahead of the site in question. `git show HEAD:scripts/tackle-tasks/resetTask.ts` (the pre-edit version) confirms line 69 there is exactly:
  ```ts
  const packet = JSON.parse(readFileSync(join(packetsDirectory, packetFile), "utf-8"));
  ```
  In the current working tree this is **line 76**, inside the loop that decides whether a packets folder belongs to the task being reset (best-effort cleanup scan). This plan fixes the live line 76, not the stale line 69.
  - A second, sibling `JSON.parse(readFileSync(packetPath, "utf-8")).command` call exists at current line 133 (reading a historical packet's command line for a block-scoped reset). Task 7 does not name this line and it is not part of the audit's cited list — **out of scope for this plan**, left as-is.

## Steps

### Step 1 — `readJsonFile`, the shared path-aware reader

`test_readJsonFile_returnsParsedContent` (new file `scripts/tackle-tasks/shared/readJsonFile.test.ts`):
- Step: write a valid JSON file to a temp path.
- Step: call `readJsonFile` on that path.
- Assert: the returned value deep-equals the object that was written.

`test_readJsonFile_throwsNamingThePathWhenTheFileIsEmpty`:
- Step: write a zero-byte file to a temp path.
- Step: call `readJsonFile` on that path.
- Assert: it throws, and the thrown error's message includes the temp path.

`test_readJsonFile_throwsWhenTheFileIsMissing`:
- Step: pick a temp path that is never written.
- Step: call `readJsonFile` on that path.
- Assert: it throws (Node's own `ENOENT`, which already names the path — this test only proves the reader does not swallow it).

`test_readJsonFile_doesNotNameThePathForNonEmptyMalformedContent`:
- Step: write `{"a":` (non-empty, syntactically incomplete) to a temp path.
- Step: call `readJsonFile` on that path.
- Assert: it throws a `SyntaxError` whose message does **not** contain the temp path — this is the documented, accepted limitation (see the empirical proof above); the test exists so a future "fix" attempt that tries to wrap `JSON.parse` in a try/catch fails this test instead of silently reintroducing one.

Production code, `scripts/tackle-tasks/shared/readJsonFile.ts` (new file):
```ts
// One path-aware JSON reader for every pipeline-owned or agent-owned state file. Missing and empty files
// name their own path; a non-empty malformed file's SyntaxError is left unwrapped, per the no-try/catch rule.
import { readFileSync } from "node:fs";

export function readJsonFile(path: string): unknown {
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") throw new Error(`readJsonFile: ${path} is empty`);
    return JSON.parse(text);
}
```

### Step 2 — `runStepHook.ts` packet read at line 273 reports through `buildFailure`, not the crash handler

A missing or empty packet file at this site is an expected, checkable condition (an interrupted `writeAgentAnswer.ts` write, per Step 4 below) — `walkFromStep` already has a structured failure result (`buildFailure`, returned directly from this same function) available at this exact call site, so this condition is checked explicitly and returned as an ordinary `FAILURE`, not left to fall through to the process-level `uncaughtException` handler. A non-empty-but-corrupt packet still cannot be checked before parsing (same limitation as Step 1's last test), so it still falls through to that handler — this plan does not change that.

`test_runStepHook_reportsAFailureOnAnEmptyPacketFile` (add to `tests/runStepHook.test.ts`, next to the existing `packetFile` tests around line 314):
- Step: build a one-box config the way `configWith` does elsewhere in this file.
- Step: write a zero-byte packet file (not `{}` — actually empty) to the temp folder.
- Step: run `/run-step A {"packetFile":"<path>"}` through the hook.
- Assert: `result.ok === false` and `result.errors` includes the packet file's path (an ordinary `FAILURE`, via `buildFailure` — not a `HOOK EXCEPTION`).

`test_runStepHook_stillFailsOnANonEmptyTruncatedPacketFileButWithoutThePathInTheMessage`:
- Step: same config as above.
- Step: write `{"taskNumber": 7, "prompt":` (non-empty, truncated) as the packet file's content.
- Step: run `/run-step A {"packetFile":"<path>"}`.
- Assert: the run log contains a `"HOOK EXCEPTION"` entry (the run still fails loudly — this is what "let it throw" buys you even without the path; a non-empty malformed file cannot be checked before parsing, so it still reaches the crash handler, unlike the empty-file case above).
- Do **not** assert the path appears in this entry's `reason`; per Step 1's proof, it will not.

Production code, `scripts/runStepHook.ts` line 273 — no new import needed (`existsSync` and `readFileSync` are already imported at line 3):
```ts
// before
if (typeof startPacket.packetFile === "string") {
    if (!process.env.RUN_STEP_LOG) runDirectory = dirname(dirname(startPacket.packetFile));
    const { prompt: _prompt, startedAt, ...packet } = JSON.parse(readFileSync(startPacket.packetFile, "utf8"));
// after
if (typeof startPacket.packetFile === "string") {
    if (!process.env.RUN_STEP_LOG) runDirectory = dirname(dirname(startPacket.packetFile));
    if (!existsSync(startPacket.packetFile)) {
        return buildFailure([], [`packet file ${startPacket.packetFile} does not exist`]);
    }
    const packetFileText = readFileSync(startPacket.packetFile, "utf8");
    if (packetFileText.trim() === "") {
        return buildFailure([], [`packet file ${startPacket.packetFile} is empty`]);
    }
    const { prompt: _prompt, startedAt, ...packet } = JSON.parse(packetFileText);
```
(`readJsonFile` is not used at this one site — `walkFromStep` already has `buildFailure` in scope and returning it directly is a smaller, equally loud fix for the two checkable conditions; the reader is still used at every other site named below, none of which have a local structured-failure result to return instead.)

### Step 3 — every run-log read-modify-write in `runStepHook.ts` becomes atomic

`test_runStepHook_writesTheRunLogAtomicallyWithNoStrayTempFile` (add to `tests/runStepHook.test.ts`):
- Step: build a two-box config (`A` stops immediately after `B`, or any two-step chain already used elsewhere in this file).
- Step: run `/run-step A` through the hook to completion.
- Step: read the run log directory's contents (`readdirSync(dirname(logFile))`).
- Assert: exactly one file matching the run log's own name exists in that directory, and no `*.tmp` file is left behind (proving `writeJsonAtomically`'s rename-into-place completed cleanly each time the log was rewritten, not just on the last write).
- Assert: the run log's contents still parse as JSON and contain one entry per step run (unchanged behavior — this test is about the write mechanism, not the log's shape).

`test_runStepHook_crashHandlerReportsAFreshHookExceptionEvenWhenTheRunLogIsAlreadyCorrupt`:
- Step: build a one-box config whose script throws (writes non-JSON to stdout, or exits non-zero after writing garbage — any shape that reaches the `uncaughtException` handler; reuse whatever this file's existing tests already use to make the hook process itself throw before it finishes, if such a case exists, otherwise write a zero-byte file at the run log's path before invoking the hook, then run a config whose script itself throws inside `scripts/runStepHook.ts`'s own process — not inside a spawned block — to land on this exact handler).
- Assert: `spawned.stdout` still contains one parseable `{decision: "block", reason}` line (the handler did not itself crash trying to read the pre-existing corrupt log).
- Assert: the run log now contains exactly one entry, `{block: "HOOK EXCEPTION", reason: <the reason string>}` — prior corrupt content is not preserved, by design (see production code below).

Production code, `scripts/runStepHook.ts`. Add the import once, used by sites 2–4 below:
```ts
import { readJsonFile } from "./tackle-tasks/shared/readJsonFile.ts";
```
(`writeJsonAtomically` needs no new import — already imported at line 11 today.)

Site 1, lines 19–25 (`uncaughtException` handler) — this handler is the one place in the file with no structured result to check against and no caller to report a `buildFailure` to (it is the last-resort path), so it does not attempt to read the existing run log at all before overwriting it: a log that is corrupt at the exact moment this handler fires can never be safely re-parsed here without a try/catch, so this plan stops trying and instead guarantees the handler itself cannot fail:
```ts
// before
process.on("uncaughtException", (error: Error) => {
    const reason = `run-step hook failed: ${error.stack ?? error.message}`;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    mkdirSync(dirname(logFile()), { recursive: true });
    const runLogEntries = existsSync(logFile()) ? JSON.parse(readFileSync(logFile(), "utf8")) : [];
    runLogEntries.push({ block: "HOOK EXCEPTION", reason });
    writeFileSync(logFile(), `${JSON.stringify(runLogEntries, null, 4)}\n`);
    process.exit(0);
});
// after
process.on("uncaughtException", (error: Error) => {
    const reason = `run-step hook failed: ${error.stack ?? error.message}`;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    mkdirSync(dirname(logFile()), { recursive: true });
    // Never re-reads the existing log: a log that is corrupt at the moment this fires cannot be
    // safely re-parsed without a try/catch, so this always starts a fresh one instead of risking
    // a second, unrecoverable throw inside the handler of last resort.
    writeJsonAtomically(logFile(), [{ block: "HOOK EXCEPTION", reason }]);
    process.exit(0);
});
```
(This trades preserving prior run-log history on the rare crash path for the handler never itself being able to fail — no test in the current suite asserts that a `HOOK EXCEPTION` entry is appended alongside earlier entries, confirmed by `rg -n "HOOK EXCEPTION" tests scripts` returning only the production line itself.)

Site 2, lines 123–129 (`appendStepToRunLog`): replace the raw parse with `readJsonFile`, replace the raw `writeFileSync` with `writeJsonAtomically`, same substitution as the example below.
```ts
// before
const runLogEntries = existsSync(logFile()) ? JSON.parse(readFileSync(logFile(), "utf8")) : [];
runLogEntries.push({ block: stepKey, duration: took(tookMs), durationMs: tookMs });
writeFileSync(logFile(), `${JSON.stringify(runLogEntries, null, 4)}\n`);
// after
const runLogEntries = existsSync(logFile()) ? readJsonFile(logFile()) as unknown[] : [];
runLogEntries.push({ block: stepKey, duration: took(tookMs), durationMs: tookMs });
writeJsonAtomically(logFile(), runLogEntries);
```

Site 3, lines 204–211 (`buildFailure`): same substitution, in this function's body.

Site 4, lines 281–284 (inside `walkFromStep`, the agent-elapsed-time log entry): same substitution.

Sites 2–4 each keep the existing `existsSync(logFile()) ? ... : []` ternary — a missing run log is a legitimate "first entry" state, not an error, so the ternary (not `readJsonFile`'s own missing-file throw) is still what decides that case. `readJsonFile` only replaces the parse call inside the `existsSync` branch, which now also rejects a present-but-empty log file loudly instead of returning `undefined`/crashing on `.push`. Site 1 (the crash handler) is the one exception, per its own description above: it never reads the existing log at all.

### Step 4 — `checkpoint.ts` read and write

`test_readCheckpoint_throwsNamingThePathWhenTheCheckpointFileIsEmpty` (add to `scripts/tackle-tasks/shared/checkpoint.test.ts` — check this file exists first; if not, create it with this one test plus a baseline `test_writeCheckpointThenReadCheckpointRoundTrips` if no such coverage exists yet):
- Step: create a temp worktree-shaped folder (`plans/checkpoint.json`'s parent).
- Step: write a zero-byte file at `checkpointPath(worktree)`.
- Step: call `readCheckpoint(worktree)`.
- Assert: it throws, and the message includes `checkpointPath(worktree)`.

Production code, `scripts/tackle-tasks/shared/checkpoint.ts`:
```ts
// before
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
...
export function readCheckpoint(worktree: string): Checkpoint | null {
    const path = checkpointPath(worktree);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
}

export function writeCheckpoint(worktree: string, checkpoint: Checkpoint): void {
    const path = checkpointPath(worktree);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(checkpoint, null, 4)}\n`);
}
```
```ts
// after
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile } from "./readJsonFile.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
...
export function readCheckpoint(worktree: string): Checkpoint | null {
    const path = checkpointPath(worktree);
    if (!existsSync(path)) return null;
    return readJsonFile(path) as Checkpoint;
}

export function writeCheckpoint(worktree: string, checkpoint: Checkpoint): void {
    const path = checkpointPath(worktree);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomically(path, checkpoint);
}
```
(`readFileSync` and `writeFileSync` drop out of the `node:fs` import list since nothing else in this file uses them — confirmed by reading the whole file; it is 34 lines and these are its only two functions.)

### Step 5 — `readReviewJson.ts` gets its own empty-content guard

`test_readReviewJson_throwsNamingThePathWhenTheFileIsEmpty` (add to `scripts/tackle-tasks/shared/readReviewJson.test.ts`):
- Step: write a zero-byte file to a temp path.
- Step: call `readReviewJson` on that path.
- Assert: it throws, and the message includes the temp path.

Production code, `scripts/tackle-tasks/shared/readReviewJson.ts`:
```ts
// before
export function readReviewJson(filePath: string): unknown {
    const text = readFileSync(filePath, "utf8").trim();
    let body = text;
// after
export function readReviewJson(filePath: string): unknown {
    const text = readFileSync(filePath, "utf8").trim();
    if (text === "") throw new Error(`readReviewJson: ${filePath} is empty`);
    let body = text;
```
(This stays local to `readReviewJson.ts` rather than delegating to `readJsonFile` — this function's fence-stripping runs between the read and the parse, so `readJsonFile`'s combined read+parse cannot be reused here without restructuring it to accept pre-read text, which nothing else needs.)

### Step 6 — `WHAT_IS_REVIEW_VERDICT.ts` plan.json and review-JSON reads, with shape validation

Reading valid JSON is not the same as reading a valid `plan.json` or review result — `decideVerdict` immediately dereferences `plan.sections.length` and `review.fixes`, so a syntactically valid but structurally wrong file (a plan with no `sections` array, a review with no `fixes` array) throws a generic, file-less `TypeError` instead of a clear, file-named contract error. This step adds one guard for each, matching task 7's own "(c) agent-owned files ... get validated by the consuming block before the next state transition."

`test_main_throwsNamingThePathWhenPlanFileIsEmpty` (add to `scripts/tackle-tasks/whatIsReviewVerdict/WHAT_IS_REVIEW_VERDICT.test.ts`, reusing this file's own `makeFixture`/`packet`/`review` helpers, confirmed live at lines 9-35):
- Step: `const { projectRoot, planFile } = makeFixture();` then immediately overwrite it empty: `writeFileSync(planFile, "");`.
- Step: `const output = () => main(JSON.stringify(packet(projectRoot, planFile, review([]))));` (an `outcome: "OK"` review with no fixes, exactly like the existing `test_main_acceptsAPlanWithNoFixesAndRoutesToImplement` fixture).
- Assert: `assert.throws(output, new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))` — the thrown error's message includes the empty plan file's path.

`test_main_throwsNamingThePlanFileWhenSectionsIsNotAnArray`:
- Step: `const { projectRoot, planFile } = makeFixture();` then `writeFileSync(planFile, JSON.stringify({ task: 7, revision: 1 }));` (valid JSON, no `sections` key at all).
- Step: `const output = () => main(JSON.stringify(packet(projectRoot, planFile, review([]))));`
- Assert: `assert.throws(output, new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))`.

`test_main_throwsNamingTheReviewFileWhenOutcomeIsNotOkOrError`:
- Step: `const { projectRoot, planFile } = makeFixture();`
- Step: build the packet directly (not through the `review(...)` helper, which always sets a valid `outcome`) so the review file holds `{ outcome: "MAYBE" }`.
- Step: call `main(...)`.
- Assert: it throws, and the message includes the review file's path.

Production code, `scripts/tackle-tasks/whatIsReviewVerdict/WHAT_IS_REVIEW_VERDICT.ts`:
```ts
// add import
import { readJsonFile } from "../shared/readJsonFile.ts";
```
```ts
// before (line 29, inside decideVerdict)
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const fixes = review.fixes;
const sectionCount = plan.sections.length;
// after
const plan = readJsonFile(planFile) as { sections: { id: string }[]; revision: number };
if (!Array.isArray(plan.sections)) throw new Error(`WHAT_IS_REVIEW_VERDICT: ${planFile} has no "sections" array`);
if (review.outcome !== "OK" && review.outcome !== "ERROR") {
    throw new Error(`WHAT_IS_REVIEW_VERDICT: ${packet.reviewOutputFile} has no valid "outcome" (got ${JSON.stringify(review.outcome)})`);
}
if (review.outcome === "OK") {
    if (!Array.isArray(review.fixes)) throw new Error(`WHAT_IS_REVIEW_VERDICT: ${packet.reviewOutputFile} has no "fixes" array`);
}
const fixes = review.fixes;
const sectionCount = plan.sections.length;
```
(`packet.reviewOutputFile` is in scope at the top of `main`, not inside `decideVerdict` — move this one `outcome` guard to the top of `main`, immediately after `const review = readReviewJson(...)`, rather than inside `decideVerdict`, so it has the file path to name; `decideVerdict` keeps its existing `if (review.outcome === "ERROR")` branch unchanged below it.)
```ts
// before (line 44, inside applyFixesToPlan)
const plan = JSON.parse(readFileSync(planFile, "utf8"));
// after
const plan = readJsonFile(planFile) as { sections: { id: string; codexNotes?: string }[]; revision: number };
```
(No second `sections` guard needed in `applyFixesToPlan` — it reads the same, unchanged `planFile` a `decideVerdict` call already validated earlier in the same `main` invocation.)
(`readFileSync` stays imported — line 2 of this file also imports `realpathSync` from `node:fs`, both still used elsewhere in the file.)

### Step 7 — `resetTask.ts` packet-scan read (current line 76)

`test_resetTask_throwsNamingThePathWhenAPacketFileIsEmpty` (add to `scripts/tackle-tasks/resetTask.test.ts`, reusing its existing `makeTempRepoWithCommit` helper, confirmed live at lines 16-24; this file's one existing test resets *to a block*, so this is the file's first plain, no-block reset fixture):
- Step: `const repoRoot = makeTempRepoWithCommit();`
- Step: `mkdirSync(join(repoRoot, ".taskTools"), { recursive: true }); writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 42, title: "t" }])); writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");` (a plain, no-block reset does not touch `run`/worktree state, so this minimal task record is enough — confirmed by reading the `block === ""`/`completedIndex === -1` branch of `resetTask.ts`, lines 110-115 today).
- Step: `const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets"); mkdirSync(packetsFolder, { recursive: true }); const emptyPacketPath = join(packetsFolder, "SOME_BOX-0-1.json"); writeFileSync(emptyPacketPath, "");`
- Step: `resetTask.ts`'s own `execSync("git rev-parse --show-toplevel")` (line 38, no explicit `cwd`) runs against `process.cwd()`, so, exactly like the existing test does at its lines 63-69, wrap the call in `const cwd = process.cwd(); process.chdir(repoRoot); try { ... } finally { process.chdir(cwd); }`.
- Step: inside that `try`, `await assert.rejects(() => resetTask(42, ""), new RegExp(emptyPacketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));` (`resetTask` is `async`, so use `assert.rejects`, not `assert.throws`).

Production code, `scripts/tackle-tasks/resetTask.ts`, add the import and change current line 76:
```ts
import { readJsonFile } from "./shared/readJsonFile.ts";
```
```ts
// before
const packetNamesThisTask = readdirSync(packetsDirectory)
    .some((packetFile) => {
        const packet = JSON.parse(readFileSync(join(packetsDirectory, packetFile), "utf-8"));
        return packet.taskNumber === taskNumber || packet.output?.result?.taskNumber === taskNumber;
    });
// after
const packetNamesThisTask = readdirSync(packetsDirectory)
    .some((packetFile) => {
        const packet = readJsonFile(join(packetsDirectory, packetFile)) as { taskNumber?: number; output?: { result?: { taskNumber?: number } } };
        return packet.taskNumber === taskNumber || packet.output?.result?.taskNumber === taskNumber;
    });
```

### Step 8 — three more pipeline-owned writes that stayed non-atomic

Found while tracing every caller, not named in task 7's own line list, but the same read-modify-write hazard task 7(b) is meant to close everywhere:

- `scripts/tackle-tasks/shared/writeAgentAnswer.ts` line 11 — the agent's answer packet write, plain `writeFileSync`. This is the exact packet file Step 2 above reads back at `runStepHook.ts` line 273; an interrupted write here is what a truncated-packet failure at that site would actually come from in production.
- `scripts/runStepHook.ts` line 171, inside `runStepScript` — the per-block diagnostic packet write, plain `writeFileSync`. `resetTask.ts`'s packet-scan (Step 7) and `resumeRun.ts`'s `findStartAtBlockEntry` both read these packets back later to resume or reset a run.
- `scripts/tackle-tasks/resetTask.ts` lines 168–172 — writes `plans/checkpoint.json` directly with `writeFileSync`, bypassing `checkpoint.ts`'s own `writeCheckpoint` (the function Step 4 just made atomic). Same target path (`checkpointPath(worktreePath)` today is hand-built as `join(worktreePath, "plans", "checkpoint.json")`, identical to what `checkpointPath` computes), so this is a straight call-site swap, not a behavior change.

`test_writeAgentAnswer_writesThePacketAtomically` (add to `scripts/tackle-tasks/shared/writeAgentAnswer.test.ts`):
- Step: `const packetFile = makePacketFile();`
- Step: `writeAgentAnswer(packetFile, JSON.stringify({ message: "", additionalData: { outcome: "PLAN" } }));`
- Step: `readdirSync(dirname(packetFile))`.
- Assert: no `*.tmp` file remains in that directory (proves the write went through `writeJsonAtomically`'s rename-into-place, not a direct `writeFileSync`).

Production code, `scripts/tackle-tasks/shared/writeAgentAnswer.ts`:
```ts
// before
import { readFileSync, writeFileSync } from "node:fs";

export function writeAgentAnswer(packetFile: string, answerJson: string): void {
    const answer = JSON.parse(answerJson) as Record<string, unknown>;
    if (typeof answer.message !== "string") throw new Error(`writeAgentAnswer: answer holds no string "message"`);
    if (answer.additionalData === null || typeof answer.additionalData !== "object" || Array.isArray(answer.additionalData)) {
        throw new Error(`writeAgentAnswer: answer holds no object "additionalData"`);
    }
    const packet = JSON.parse(readFileSync(packetFile, "utf8")) as Record<string, unknown>;
    writeFileSync(packetFile, JSON.stringify({ ...packet, message: answer.message, additionalData: answer.additionalData }, null, 4));
}
// after
import { readFileSync } from "node:fs";
import { writeJsonAtomically } from "../../taskStateLock.ts";

export function writeAgentAnswer(packetFile: string, answerJson: string): void {
    const answer = JSON.parse(answerJson) as Record<string, unknown>;
    if (typeof answer.message !== "string") throw new Error(`writeAgentAnswer: answer holds no string "message"`);
    if (answer.additionalData === null || typeof answer.additionalData !== "object" || Array.isArray(answer.additionalData)) {
        throw new Error(`writeAgentAnswer: answer holds no object "additionalData"`);
    }
    const packet = JSON.parse(readFileSync(packetFile, "utf8")) as Record<string, unknown>;
    writeJsonAtomically(packetFile, { ...packet, message: answer.message, additionalData: answer.additionalData });
}
```

`test_runStepHook_writesTheDiagnosticPacketAtomically` (add to `tests/runStepHook.test.ts`):
- Step: run any one-box config through the hook.
- Step: `readdirSync(packetsFolder)` for that run.
- Assert: no `*.tmp` file remains among the diagnostic packets.

Production code, `scripts/runStepHook.ts` line 171:
```ts
// before
writeFileSync(join(packetsDirectory(), `${step.box}-${process.pid}-${packetSequence}.json`), JSON.stringify({ input: { invocation }, command, commandOutput, output: stepRun }, null, 4));
// after
writeJsonAtomically(join(packetsDirectory(), `${step.box}-${process.pid}-${packetSequence}.json`), { input: { invocation }, command, commandOutput, output: stepRun });
```

Production code, `scripts/tackle-tasks/resetTask.ts` lines 168–172 — reuse `writeCheckpoint` instead of hand-building the same path:
```ts
// add import
import { writeCheckpoint } from "./shared/checkpoint.ts";
```
```ts
// before
writeFileSync(leasePath, JSON.stringify({ pid: process.pid, runId }));
mkdirSync(join(worktreePath, "plans"), { recursive: true });
writeFileSync(join(worktreePath, "plans", "checkpoint.json"), JSON.stringify({
    taskNumber, passId: randomUUID(), runId, projectRoot: repoRoot,
    block: stepKey, input, state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
}, null, 4));
// after
writeFileSync(leasePath, JSON.stringify({ pid: process.pid, runId }));
writeCheckpoint(worktreePath, {
    taskNumber, passId: randomUUID(), runId, projectRoot: repoRoot,
    block: stepKey, input, state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
});
```
(`writeCheckpoint` already does its own `mkdirSync(dirname(path), { recursive: true })`, so the explicit `mkdirSync(join(worktreePath, "plans"), ...)` line drops out — same effective path, one fewer line, same atomic write `checkpoint.ts` now performs everywhere else.)

No test changes needed for this last change beyond Step 4's own `checkpoint.test.ts` coverage — `resetTask.test.ts`'s one existing test does not assert `checkpoint.json`'s exact bytes (confirmed: `rg -n "checkpoint" scripts/tackle-tasks/resetTask.test.ts` returns nothing), so this call-site swap changes no observable behavior there.

## Verification

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```

If it does not print `all passing`, run `npm test 2>&1 | tail -50` and fix the codebase (never the tests, unless a test is fraudulent) until it does.
