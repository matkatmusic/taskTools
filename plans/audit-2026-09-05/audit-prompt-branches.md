# Audit: prompt-branch conditionals in the 7 pipeline blocks

Scope note: pure packet-shape guards (`Number.isInteger(taskNumber)`, `requireAbsolutePath(...)`,
`if (!taskTests) throw`, `if (paths.length === 0) throw`) are excluded from the tables below. They
abort the block before any prompt is built — they don't shape a prompt and don't route to a
different agent/block, so they fit neither ROUTING nor TEXT. They're named once per block in a
footnote so nothing is silently dropped.

---

## 1. `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts` (+ `shared/planPrompt.ts`)

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `Number(entry.difficulty) >= 7` | PLAN_THE_TASK.ts:60 | ROUTING | `entry.difficulty` (tasks.json) | difficulty>=7: spawns `codex exec` **detached** (`spawn(..., {detached:true})`), returns a "wait via polling loop, timeout 600000" prompt (`codexPlanPrompt`). difficulty<7: returns `planPrompt(t)` unchanged, telling the in-workflow (claude) agent to write the plan itself, no process spawned. |
| `extra?.clarifyRequest !== undefined` | planPrompt.ts:81 | TEXT | `extra.clarifyRequest` | prepends a "run `writeClarifyRequest.ts` first" block. **Dead from this block**: PLAN_THE_TASK.ts never passes `extra`, so this branch is unreachable from either call site (line 28, line 62). |
| `extra?.planReview !== undefined` | planPrompt.ts:82 | TEXT | `extra.planReview` | prepends a "run `recordPlanReview.ts` first" block. Same dead-from-this-block note as above. |
| `extra?.updateDocs` | planPrompt.ts:83 | TEXT | `extra.updateDocs` | prepends a "run `updateTaskDocs.ts` first" block. Same dead-from-this-block note as above. |
| `t.codexReviewNotes.trim() === ""` | planPrompt.ts:84 | TEXT | `t.codexReviewNotes` (from taskRunState, set by a prior failed codex plan review) | non-empty: inserts "## CODEX'S PREVIOUS REVIEW NOTES" section instructing the planner to address every point. |
| `resumedFrom` presence / `exitType === ""` | resumedRunSection.ts:7,9,10 (called from planPrompt.ts:117) | TEXT | `plans/checkpoint.json` → `resumedFrom` | no file / `resumedFrom === null`: emits `""`. Otherwise inserts "## RESUMED RUN" with a sentence that varies on whether `exitType` is empty vs named. |
| `t.hasTests ? (t.tests ?? "...") : "skip"` | planPrompt.ts:188 | TEXT | `t.hasTests`, `t.tests` | switches the `TESTS_FIELD` block between "skip" and the task's test example (or a placeholder sentence when the task has tests but the user gave no example). |

**Retry produces a different prompt:** yes. A second run after a rejected codex review carries `t.codexReviewNotes`, which injects the "CODEX'S PREVIOUS REVIEW NOTES" section (planPrompt.ts:84) that round 1 never has. A resumed run also differs via `resumedRunSection`. The difficulty routing itself (line 60) is stable across retries within one task (difficulty doesn't change mid-task), so it does not itself vary run-to-run.

Footnote: `codexPlanPrompt` itself has no conditionals — it always writes the run script, spawns detached, and returns the same polling-loop prompt shape.

---

## 2. `scripts/tackle-tasks/codexReviewsPlan/CODEX_REVIEWS_PLAN.ts` (+ `shared/CodexReviewBodyEmitter.ts`)

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `readCheckpoint(t.repoRoot)?.resumedFrom?.exitType === "plan-scrapped"` | CodexReviewBodyEmitter.ts:228 | TEXT | `plans/checkpoint.json` → `resumedFrom.exitType` | swaps the entire review body to `approveReviewByDefaultPrompt`: "Approve the plan. Do not judge it, do not hunt for problems." No real review is performed. |
| `getAttemptCount(t.number, "planReview", t.taskStateRoot) >= 1` | CodexReviewBodyEmitter.ts:229 | TEXT | attempt count from `taskRunState.ts` for key `"planReview"` | 2nd+ attempt: swaps to `recheckOnlyPrompt` — only rechecks issues already flagged in round 1's `t.reviewOutputFile`, never hunts for new ones. |
| (else) | CodexReviewBodyEmitter.ts:230 | TEXT | — | 1st attempt, not resumed from plan-scrapped: full `reviewByDefaultPrompt`, adversarial audit. |
| `isCodexDraftedPlan(t)` (`entry.difficulty >= 7`) | CodexReviewBodyEmitter.ts:13-16, used at 68-71 | TEXT | `entry.difficulty` (tasks.json) — same field as PLAN_THE_TASK's routing check, but only used for wording here | difficulty>=7: role sentence says "second, independent codex instance auditing... drafted by another codex instance. Actively hunt for flaws." Else: plain "read-only review agent" sentence. Does **not** change which reviewer/model runs — codex still runs first either way. |
| `t.siblingTasks.length > 0` | CodexReviewBodyEmitter.ts:101 | TEXT | `t.siblingTasks` (file-overlap siblings) | lists sibling tasks vs "No other open task shares files with task N." |
| `t.blockedBy.length > 0` | CodexReviewBodyEmitter.ts:103 | TEXT | `t.blockedBy` | lists blockers vs "No open task blocks task N." |
| `t.blocks.length > 0` | CodexReviewBodyEmitter.ts:105 | TEXT | `t.blocks` | lists blocked tasks vs "Task N blocks no open task." |

**Retry produces a different prompt:** yes, by design — this is the block whose entire job is to change behavior on retry. Round 1 = full adversarial review; round 2+ = recheck-only (line 229); a run resumed from `plan-scrapped` = rubber-stamp approve (line 228) regardless of attempt count.

Footnote: `createCodexShellInvocationLive` always emits the same `codex exec || claude fable || claude opus` shell fallback chain (spawnAgentCli.ts codexExecCommand/spawnClaudeFableCli/spawnClaudeOpus48Cli) — that's runtime shell `||`, not a script-level conditional, and it never varies by input, so it isn't listed as a row. `createCodexShellInvocationTTY` / `createCodexShellInvocationOriginal` are dead alternatives, commented out at the call site (CodexReviewBodyEmitter.ts:293-294).

---

## 3. `scripts/tackle-tasks/codexReviewsTests/CODEX_REVIEWS_TESTS.ts` (+ `shared/CodexTestReviewBodyEmitter.ts`)

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `t.codexReviewNotes.trim() !== ""` | CodexTestReviewBodyEmitter.ts:216 | TEXT | `t.codexReviewNotes` | non-empty (i.e. a prior round already flagged issues): swaps to `recheckOnlyPrompt` — rechecks only the audited issues in `t.testReviewFile`. Empty: full `reviewByDefaultPrompt` adversarial test review. |
| `preExistingTestFiles.length === 0` | CodexTestReviewBodyEmitter.ts:98 | TEXT | `taskTests.testFiles` minus `taskTests.createdTestFiles` (taskRunState) | "(none)" vs a bulleted list under "## TESTS THIS TASK DID NOT CREATE". |

**Retry produces a different prompt:** yes — same mechanism as block 2 but keyed off `codexReviewNotes` instead of an attempt counter: once round 1 leaves notes, round 2 gets the recheck-only body.

Footnote: `approveReviewByDefaultPrompt` (CodexTestReviewBodyEmitter.ts:40-63) is defined but **never called** — `reviewTestsQuestion` only branches between recheck-only and full review, no rubber-stamp path exists for this block (unlike CODEX_REVIEWS_PLAN's `plan-scrapped` case). The `codexExecCommand || claude fable || claude opus` shell fallback (reviewTestsPrompt) is the same unconditional runtime chain noted in block 2.

---

## 4. `scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.ts`

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `t.tests === "skip" \|\| !t.hasTests` | IMPLEMENT_TASK.ts:30 | TEXT | `t.tests`, `t.hasTests` | true: "## DO NOT CREATE TESTS" section. false: "## TESTS" section requiring TDD, paired `tests/<name>.test.ts` files. |
| `note.trim() === ""` (`t.codexReviewNotes`) | IMPLEMENT_TASK.ts:48 | TEXT | `t.codexReviewNotes` | non-empty: prepends "## NOTE FOR THIS RUN" with the reviewer's/prior notes. |
| `resumedFrom` presence / `exitType === ""` | resumedRunSection.ts:7,9,10 (called IMPLEMENT_TASK.ts:85) | TEXT | `plans/checkpoint.json` | same as block 1: adds/omits "## RESUMED RUN". |
| `packet.typecheckCommand \|\| DEFAULT_TYPECHECK_COMMAND` | IMPLEMENT_TASK.ts:138 | TEXT | `packet.typecheckCommand` | substitutes the caller-supplied typecheck command into the "Run `${rootedTypecheck}`" instruction (line 92), else `npx tsc --noEmit`. |
| `packet.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS` | IMPLEMENT_TASK.ts:138 | TEXT | `packet.maxFixRounds` | substitutes the fix-round cap into "Stop after N rounds" (line 94) and the forbidden-actions count (line 123); no sender currently sets it (`// ponytail:` comment, line 15), so it's always 3 in practice. |

**Retry produces a different prompt:** yes, via `codexReviewNotes` (line 48, populated after `FIX_IMPLEMENT_TASK_TESTS`/review rounds) and via `resumedRunSection` if the worktree was resumed. No routing branch exists in this block — always the in-workflow agent, never a spawned process.

---

## 5. `scripts/tackle-tasks/fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.ts`

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `resumedFrom` presence / `exitType === ""` | resumedRunSection.ts:7,9,10 (called FIX_IMPLEMENT_TASK_TESTS.ts:49) | TEXT | `plans/checkpoint.json` | adds/omits "## RESUMED RUN". |

**Retry produces a different prompt:** the prompt body itself doesn't branch on an attempt count, but its content is inherently retry-dependent: `${prepared.codexReviewNotes}` is spliced verbatim into "## FAILING TASK TESTS" (line 78) — a different failing-test list each round is not a conditional, it's the whole point of the block (it's substitution, not branching), so it's not listed as a row above. Only `resumedRunSection` is a true conditional, and only differs when the worktree itself was resumed mid-run.

---

## 6. `scripts/tackle-tasks/fixConflicts/FIX_CONFLICTS.ts` (+ `shared/FixConflictsBodyEmitter.ts`)

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `resumedFrom` presence / `exitType === ""` | resumedRunSection.ts:7,9,10 (called FixConflictsBodyEmitter.ts:56) | TEXT | `plans/checkpoint.json` | adds/omits "## RESUMED RUN". |

**Retry produces a different prompt:** the "WHAT TO READ" / "WHAT YOU MAY EDIT" lists are rebuilt from `conflictedPaths(checkoutPath)` (a live `git diff --diff-filter=U` at call time), so a second run naturally lists whatever paths are still conflicted — again substitution, not a conditional, so not tabled. Only `resumedRunSection` is a true branch.

Footnote (guard, excluded from the table per the scope note above): `if (paths.length === 0) throw` at FixConflictsBodyEmitter.ts:26 — aborts the block instead of producing a prompt when there is nothing conflicted; not a routing or text choice, a precondition.

The large commented-out block (FIX_CONFLICTS.ts:27-48, the old `spawnClaudeCliPrompt`-based inline codex/claude CLI invocation) is dead code, not a live conditional — the block now always returns `invoke '/read-file ...'` for the in-workflow agent (line 49-50), no spawn.

---

## 7. `scripts/tackle-tasks/fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.ts`

| condition | file:line | kind | input it reads | effect |
|---|---|---|---|---|
| `resumedFrom` presence / `exitType === ""` | resumedRunSection.ts:7,9,10 (called FIX_THE_CODEBASE_FOR_SUITE.ts:59) | TEXT | `plans/checkpoint.json` | adds/omits "## RESUMED RUN". |

**Retry produces a different prompt:** `packet.output` (the full suite's failing output, spliced verbatim into "## FAILING SUITE OUTPUT", line 87) differs run to run because the suite itself was re-run — that's substitution from the caller's packet, not a conditional in this script, so not tabled. Only `resumedRunSection` is a true branch. No ROUTING conditionals anywhere in this block: always the in-workflow agent, no spawn.

---

## Cross-block note: shared `resumedRunSection`

`resumedRunSection.ts` (lines 5-19) is the one TEXT-kind helper reused across blocks 1, 4, 5, 6, 7 (not imported by blocks 2 or 3, which are pure review/spawn prompts with no "resume" concept). Its 3 internal checks (file exists, `resumedFrom !== null`, `exitType === ""`) are always counted as a single condition per call site in the tables above, since they collapse into one yes/no "was this worktree resumed" decision for the prompt.
