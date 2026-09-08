# Task 11 plan — comment out planPrompt's dead `extra` parameter

## Scope confirmation

- `scripts/tackle-tasks/shared/planPrompt.ts` — read in full (191 lines).
  - Line 7: `import type { PlanReview } from "./recordPlanReview.ts";` — used only as the type of `PlanPromptExtra.planReview` (line 34). Once that field is commented out, this import has no other use in the file (confirmed: `grep -n "PlanReview" scripts/tackle-tasks/shared/planPrompt.ts` shows only lines 7 and 34).
  - Lines 32-36:
    ```ts
    export type PlanPromptExtra = {
        clarifyRequest?: string;
        planReview?: PlanReview;
        updateDocs?: true;
    };
    ```
  - Lines 38-46: `clarifyRequestBlock`.
  - Lines 48-56: `planReviewBlock`.
  - Lines 58-66: `updateDocsBlock`.
  - Lines 79-83, the function signature and the `leadingBlocks` assembly:
    ```ts
    export function planPrompt(t: PreparedTask, extra?: PlanPromptExtra): string {
        const leadingBlocks =
            (extra?.clarifyRequest !== undefined ? clarifyRequestBlock(t, extra.clarifyRequest) : "") +
            (extra?.planReview !== undefined ? planReviewBlock(t, extra.planReview) : "") +
            (extra?.updateDocs ? updateDocsBlock(t) : "");
    ```
  - Line 93: `return \`${leadingBlocks}${codexNotes}## YOUR JOB` — `leadingBlocks` is spliced into the returned string here; this reference must be removed together with the declaration it reads.
- Every live caller confirmed via `grep -rn "planPrompt(" --include="*.ts" . | grep -v node_modules | grep -v archive`:
  - `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:28` — `writeFileSync(codexPromptFile, planPrompt(t));` (inside `codexPlanPrompt`), one argument only.
  - `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:62` — `` : `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`; `` (inside `main`), one argument only.
  - No other live caller passes `extra`. The only other references to `PlanPromptExtra`, `clarifyRequestBlock`, `planReviewBlock`, or `updateDocsBlock` anywhere in the repo are inside `archive/tackle-tasks-v1_5/`, a frozen, non-live copy (confirmed via `grep -rn "clarifyRequestBlock\|planReviewBlock\|updateDocsBlock\|PlanPromptExtra" --include="*.ts" .`). This confirms the codex review's "no production caller since commit 8849857" claim.
  - The clarify question still reaches the planner through a different path, unaffected by this task: `WRITE_CLARIFY_REQUEST.ts:23` writes the request into the tasks.json entry, `prepareTasks.ts:150-151` reads it back into the brief, and `planPrompt.ts:104-107`'s existing `/read-file` block (which reads `t.briefFile`) delivers it to the planner. None of that path touches `extra`.
- `scripts/tackle-tasks/shared/planPrompt.test.ts` — read in full (58 lines).
  - Lines 27-42, `test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent`: its second line, `assert.equal(prompt, planPrompt(fakeTask, {}));`, calls `planPrompt` with a second argument. Once `extra` is commented out of the signature, this call becomes meaningless (there is no second parameter to compare against) — this one line must be commented out, not the whole test, since the rest of the test (the `startsWith` check and the "no unexpected marker" loop) still verifies real, current behavior of the one-argument call.
  - Lines 44-56, `test_planPrompt_prependsACommandBlockPerPresentPayloadField`: this entire test exercises `clarifyRequest`, `planReview`, and `updateDocs` — all three being retired. Comment out the whole test.
  - Lines 58-64 (a `test_planPrompt_readsThePlanShapeThroughReadFileInsteadOfPastingIt` test, unaffected) and the already-commented-out `test_planPrompt_tellsThePlannerToVerifyNamedIdentifiersAgainstTheCode` at the bottom are untouched.
- `scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts` — **not edited by this task.** Its two `planPrompt(...)` call sites (lines 28, 62) already pass one argument each; commenting out `extra` in `planPrompt`'s signature does not change either call site's meaning, since a caller that never passed a second argument is unaffected by that argument being removed. (Task 19 restructures this file's difficulty branch separately, in the next plan; this task and that one touch disjoint lines of `PLAN_THE_TASK.ts` — in fact this task touches zero lines of it.)

## Steps

### Step 1 — retire the three block builders and the `extra` parameter in `planPrompt.ts`

No new test: this is a pure retirement of code with the confirmed-dead callers above; no live behavior changes for either of the two real call sites, both of which already omit `extra`. The existing test `test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent`'s surviving assertions continue to prove the one-argument call's behavior is unchanged.

Edit `scripts/tackle-tasks/shared/planPrompt.ts`:

#### 1a. Line 7 — comment out the now-unused type import

Old:
```ts
import type { PlanReview } from "./recordPlanReview.ts";
```
New:
```ts
// Retired (task 11): only used by the dead `extra.planReview` field below.
// import type { PlanReview } from "./recordPlanReview.ts";
```

#### 1b. Lines 24-29 — comment out the three path constants and `shellQuote`

Each of these four declarations is read only inside the block builder it feeds (confirmed: `grep -n "WRITE_CLARIFY_REQUEST_PATH\|RECORD_PLAN_REVIEW_PATH\|UPDATE_TASK_DOCS_PATH\|shellQuote" scripts/tackle-tasks/shared/planPrompt.ts` shows each identifier's only two lines are its declaration and its one use inside `clarifyRequestBlock`, `planReviewBlock`, or `updateDocsBlock`). Once those three builders are commented out (1d-1f below), these four would be live declarations with no consumer.

Old:
```ts
const WRITE_CLARIFY_REQUEST_PATH = fileURLToPath(new URL("./writeClarifyRequest.ts", import.meta.url));
const RECORD_PLAN_REVIEW_PATH = fileURLToPath(new URL("./recordPlanReview.ts", import.meta.url));
const UPDATE_TASK_DOCS_PATH = fileURLToPath(new URL("./updateTaskDocs.ts", import.meta.url));

// Its own copy, so this file never imports the dispatch hub.
const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
```
New:
```ts
// Retired (task 11): each only fed clarifyRequestBlock/planReviewBlock/updateDocsBlock below, all now retired.
// const WRITE_CLARIFY_REQUEST_PATH = fileURLToPath(new URL("./writeClarifyRequest.ts", import.meta.url));
// const RECORD_PLAN_REVIEW_PATH = fileURLToPath(new URL("./recordPlanReview.ts", import.meta.url));
// const UPDATE_TASK_DOCS_PATH = fileURLToPath(new URL("./updateTaskDocs.ts", import.meta.url));

// Retired (task 11): only planReviewBlock below called this.
// // Its own copy, so this file never imports the dispatch hub.
// const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
```

#### 1c. Lines 32-36 — comment out `PlanPromptExtra`

Old:
```ts
// Set only by the box that ran, telling the next agent to run the matching script first.
export type PlanPromptExtra = {
    clarifyRequest?: string;
    planReview?: PlanReview;
    updateDocs?: true;
};
```
New:
```ts
// Retired (task 11): no live caller has set any of these fields since commit 8849857.
// // Set only by the box that ran, telling the next agent to run the matching script first.
// export type PlanPromptExtra = {
//     clarifyRequest?: string;
//     planReview?: PlanReview;
//     updateDocs?: true;
// };
```

#### 1d. Lines 38-46 — comment out `clarifyRequestBlock`

Old:
```ts
const clarifyRequestBlock = (t: PreparedTask, clarifyRequest: string): string => {
    const payload = JSON.stringify({ projectRoot: t.taskStateRoot, taskNumber: t.number, clarifyRequest, boxId: "WRITE_CLARIFY_REQUEST" });
    return `Run this first, before doing anything else, exactly as written:
node ${WRITE_CLARIFY_REQUEST_PATH} <<'TTCLARIFY'
${payload}
TTCLARIFY

`;
};
```
New: comment out every line of the block above with a leading `// `, preceded by:
```ts
// Retired (task 11): dead since commit 8849857, no live caller passes extra.clarifyRequest.
```

#### 1e. Lines 48-56 — comment out `planReviewBlock`

Same treatment: prefix with `// Retired (task 11): dead since commit 8849857, no live caller passes extra.planReview.` and comment out every line of the `planReviewBlock` declaration.

#### 1f. Lines 58-66 — comment out `updateDocsBlock`

Same treatment: prefix with `// Retired (task 11): dead since commit 8849857, no live caller passes extra.updateDocs.` and comment out every line of the `updateDocsBlock` declaration.

#### 1g. Lines 79-83 — drop `extra` from the signature and comment out `leadingBlocks`

Old:
```ts
export function planPrompt(t: PreparedTask, extra?: PlanPromptExtra): string {
    const leadingBlocks =
        (extra?.clarifyRequest !== undefined ? clarifyRequestBlock(t, extra.clarifyRequest) : "") +
        (extra?.planReview !== undefined ? planReviewBlock(t, extra.planReview) : "") +
        (extra?.updateDocs ? updateDocsBlock(t) : "");
```
New:
```ts
export function planPrompt(t: PreparedTask): string {
    // Retired (task 11): the extra param (clarifyRequest/planReview/updateDocs) had no live caller.
    // const leadingBlocks =
    //     (extra?.clarifyRequest !== undefined ? clarifyRequestBlock(t, extra.clarifyRequest) : "") +
    //     (extra?.planReview !== undefined ? planReviewBlock(t, extra.planReview) : "") +
    //     (extra?.updateDocs ? updateDocsBlock(t) : "");
```

(`leadingBlocks` is not kept as a live `""` stand-in — Step 1h below comments out its one reader instead, so no new dead variable is left behind.)

#### 1h. Line 93 — comment out the `leadingBlocks` interpolation

The old line cannot become a same-line trailing comment: it is the first line of the function's multi-line template-literal return, which continues for many more lines and does not close here — so, matching this file's existing retirement style (1a-1g above), the old line goes on its own comment line directly above the new one.

Old:
```ts
    return `${leadingBlocks}${codexNotes}## YOUR JOB`
```
New:
```ts
    // Retired (task 11): leadingBlocks no longer exists (1g above); this line dropped its interpolation.
    // return `${leadingBlocks}${codexNotes}## YOUR JOB`
    return `${codexNotes}## YOUR JOB`
```

### Step 2 — retire the matching test cases in `planPrompt.test.ts`

Edit `scripts/tackle-tasks/shared/planPrompt.test.ts`:

#### 2a. Line 28 — drop the two-argument comparison

Old:
```ts
test("test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent", () => {
    const prompt = planPrompt(fakeTask);
    assert.equal(prompt, planPrompt(fakeTask, {}));
    assert.ok(prompt.startsWith("## YOUR JOB"));
```
New:
```ts
test("test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent", () => {
    const prompt = planPrompt(fakeTask);
    // Retired (task 11): planPrompt no longer takes a second argument to compare against.
    // assert.equal(prompt, planPrompt(fakeTask, {}));
    assert.ok(prompt.startsWith("## YOUR JOB"));
```

#### 2b. Lines 44-56 — comment out the whole test

Old:
```ts
test("test_planPrompt_prependsACommandBlockPerPresentPayloadField", () => {
    const clarifyPrompt = planPrompt(fakeTask, { clarifyRequest: "need the migration file" });
    assert.match(clarifyPrompt, /node \S*writeClarifyRequest\.ts <<'TTCLARIFY'/);
    assert.ok(clarifyPrompt.indexOf("TTCLARIFY") < clarifyPrompt.indexOf("## YOUR JOB"));

    const review = { outcome: "OK" as const, missingFiles: [], message: "", issues: [], fixes: [], sectionsThatHoldUp: [] };
    const reviewPrompt = planPrompt(fakeTask, { planReview: review });
    assert.match(reviewPrompt, /node \S*recordPlanReview\.ts .* <<'TTREVIEW'/);
    assert.ok(reviewPrompt.indexOf("TTREVIEW") < reviewPrompt.indexOf("## YOUR JOB"));

    const docsPrompt = planPrompt(fakeTask, { updateDocs: true });
    assert.match(docsPrompt, /node \S*updateTaskDocs\.ts <<'TTDOCS'/);
    assert.ok(docsPrompt.indexOf("TTDOCS") < docsPrompt.indexOf("## YOUR JOB"));

    // A clarify round always re-enters with both fields set, so the order must be clarify then docs.
    const combined = planPrompt(fakeTask, { clarifyRequest: "need X", updateDocs: true });
    assert.ok(combined.indexOf("TTCLARIFY") < combined.indexOf("TTDOCS"));
});
```
New: comment out every line above with a leading `// `, preceded by:
```ts
// Retired (task 11): planPrompt's extra param (clarifyRequest/planReview/updateDocs) is retired; see planPrompt.ts.
```

No other test in the file changes.

## Verification

```sh
cd /Users/matkatmusicllc/Programming/taskTools-86
node --test scripts/tackle-tasks/shared/planPrompt.test.ts
```
Expected: the two surviving active tests (`test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent`, `test_planPrompt_readsThePlanShapeThroughReadFileInsteadOfPastingIt`) pass; the retired test no longer appears in the run.

```sh
node --test scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.test.ts
```
Expected: all three existing tests still pass unchanged (neither call site of `planPrompt` passed `extra`).

```sh
grep -n "extra\|leadingBlocks\|WRITE_CLARIFY_REQUEST_PATH\|RECORD_PLAN_REVIEW_PATH\|UPDATE_TASK_DOCS_PATH\|shellQuote" scripts/tackle-tasks/shared/planPrompt.ts | grep -v "^\s*//"
```
Expected: no output — every live reference to `extra` is gone; only commented-out lines remain.

Full suite:
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
Expected: `all passing`.
