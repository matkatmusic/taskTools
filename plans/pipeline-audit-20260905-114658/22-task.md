# Task 22 plan — FIX_CONFLICTS returns the packet answer protocol; COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED verifies it against live git state

Source: `.claude/tasks/taskTools-86/22.json` and `plans/pipeline-audit-codex-20260905-113523.md`, "Missing critical task: FIX_CONFLICTS emits the wrong answer protocol" (verified; this task was itself found missing by codex review, so there is no earlier "task 22 description" the audit is correcting — the fix below implements the audit's own "Required task" text directly).

Depends on task 7: reuses `writeJsonAtomically`-backed atomic state (no direct dependency on the new `readJsonFile.ts` reader, since this task's own JSON.parse calls are all on packets the walker already validated); land task 7's plan first so the shared helpers it touches are stable.

Owns `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts`'s consumption of the conflict receipt exclusively. Task 18 covers `COMMIT_IMPLEMENTATION_IF_NEEDED.ts`, `COMMIT_SUITE_FIX_IF_NEEDED.ts`, and the four `generateWorkflow.ts` branch tests, and must not touch this file.

## Scope confirmation

- **`scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts`**
  - Line 6, today: `import { printAsFinalMessageSection } from "./whatToReturn.ts";` — the only import from `whatToReturn.ts`.
  - Line 84, today (the prompt's last line):
    ```ts
    ${printAsFinalMessageSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', "replacing every `<...>` with a real value")}`;
    ```
    `printAsFinalMessageSection` (`scripts/tackle-tasks/shared/whatToReturn.ts`, confirmed live) tells the agent to *print* the raw `{resolved, unresolvedPaths}` object as its final message — the shape used by the retired CLI-spawn design (`claude -p` piped through `jq`, now fully commented out). The live workflow agent instead follows the prompt itself and must call `writeAgentAnswer.ts`, which only accepts `{message: string, additionalData: object}` (`scripts/tackle-tasks/shared/writeAgentAnswer.ts:5-9`, confirmed: `if (typeof answer.message !== "string") throw ...; if (answer.additionalData === null || typeof answer.additionalData !== "object" || Array.isArray(answer.additionalData)) throw ...`). A raw `{resolved, unresolvedPaths}` object has no `message` key and fails `writeAgentAnswer`'s first check.
  - `scripts/tackle-tasks/fixConflicts/FIX_CONFLICTS.template.json`, `agentAnswer` key, today: `{"message": "", "additionalData": {"resolved": true, "unresolvedPaths": []}}` — the template this box's contract test (`tests/stepTemplates.test.ts`) checks against **already declares the correct, packet-shaped answer**. The live prompt text is the only place still emitting the wrong shape.
  - `scripts/tackle-tasks/fixConflicts/FIX_CONFLICTS.ts`, lines 27–47, today — fully commented out (confirmed live: every line in this range starts with `//`). It contains the one place in the repo that already calls `whatToReturnSection(...)` with this exact receipt shape: `whatToReturnSection('{ "resolved": "<...>", "unresolvedPaths": [...] }', 'copied from what \`cat "$ANSWER_FILE"\` printed', "")`. Its `explanationOfValue` ("copied from what `cat \"$ANSWER_FILE\"` printed") is retired-CLI-spawn wording — `$ANSWER_FILE` does not exist in the live design — so this plan does not copy that string verbatim; it reuses the value shape only and writes a fresh `explanationOfValue` matching the live pattern used by `IMPLEMENT_TASK.ts:128` and `FIX_IMPLEMENT_TASK_TESTS.ts:73` (both pass `""` as `explanationOfReturnShape`).

- **`scripts/tackle-tasks/shared/whatToReturn.ts`**, lines 6–21, today — `whatToReturnSection(value, explanationOfValue, explanationOfReturnShape)` already builds the section this task needs verbatim; no change to this file.

- **`scripts/tackle-tasks/shared/FixConflictsBodyEmitter.test.ts`**
  - Lines 58–65, today, `test_fixConflictsPrompt_endsWithTheSharedWhatToReturnSectionAndCarriesNoDataBlock`: asserts `## WHAT YOU PRINT` and a `Print \`...\` as your final message` pattern — this is exactly the section this plan removes. This test must be rewritten (Step 1) to assert the new `## WHAT YOU, THE SPAWNING AGENT, RETURNS` section instead.

- **`scripts/tackle-tasks/commitMergeConflictFixIfNeeded/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts`**, lines 15–29, today (full body of `main`):
  ```ts
  export function main(input: string): CommitMergeConflictFixIfNeededPacket {
      const { next: _next, ...packet } = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket & { next?: string };
      refreshOwnedSourceRepoLockOrThrow(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));

      commitTaskWork({
          projectRoot: packet.projectRoot,
          worktreePath: packet.worktree,
          taskNumber: packet.taskNumber,
          runId: packet.runId,
          stepId: "commit-merge-conflict-fix",
          rootSourceBranch: baseBranch(packet.projectRoot),
      });

      return { ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
  }
  ```
  `packet.additionalData` (typed `Record<string, unknown>` in `CommitMergeConflictFixIfNeededPacket`, confirmed in `_packet.ts`) is spread into the return value via `...packet` but never read. Confirmed live at these exact lines.
  - Verified empirically (`git commit` after staging one clean file while a second, unrelated file stays unmerged) that `git commit` with no pathspec refuses outright — exit 128, "Committing is not possible because you have unmerged files" — whenever **any** unmerged index entry exists anywhere in the repository, not only among the paths actually staged. `commitTaskWork` (`scripts/tackle-tasks/shared/commitTaskWork.ts:92-117`, confirmed) calls exactly this form of `git commit`. This means a check placed **after** `commitTaskWork` returns can never observe an unowned unmerged path from a single-repo conflict — `commitTaskWork` itself already throws first, which is already loud, so no `--diff-filter=U`-style check adds anything for that scenario.
  - Also verified empirically that `git diff --name-only --diff-filter=U` (and `git commit` itself) both track the git **index**, not file content: `git add` on a file clears its "unmerged" status unconditionally, even when the file still physically contains conflict-marker text. Since `commitTaskWork`'s `stageOwnedChanges` runs `git add -A` scoped to the task's **owned** files, an owned file that still holds a marker line is exactly the case a `--diff-filter=U`-based check — before or after the commit — cannot detect: staging clears the index signal a marker check would need, regardless of order.
  - The check this box needs is therefore not a git-index check at all: it is a direct read of file **content** for each path in `packet.conflictedFilePaths` (the pipeline's own authoritative list, set by an earlier box's real conflict detection, confirmed `_packet.ts:12`), scanning for a literal conflict-marker line (`<<<<<<<`, `=======`, `>>>>>>>`). This is independent of staging order, so it runs **before** `commitTaskWork`, letting the box refuse to commit a still-broken file at all rather than relying on `commitTaskWork`'s unrelated refusal to fail for the right reason.
  - `packet.conflictedFilePaths` must be resolved against `packet.stoppedCheckoutPath`, not `packet.worktree` — `_packet.ts:15` (confirmed) declares `stoppedCheckoutPath` as a distinct field, populated by `REBASE_ONTO_TARGET_BRANCH.ts:47` and `CONTINUE_REBASE.ts:34` (confirmed live) from the actual occurrence where the rebase stopped, which can be a nested submodule checkout different from the root `worktree`. (`FIX_CONFLICTS.ts` itself currently builds its prompt from `packet.worktree` instead of `packet.stoppedCheckoutPath` — a separate, pre-existing question about a file task 22 does not own; this plan does not touch `FIX_CONFLICTS.ts`'s checkout-path selection, only uses the correct field in its own new code.)
  - The prompt (`FixConflictsBodyEmitter.ts:81-83`, confirmed live) states "Returning `resolved: false` is a correct outcome when a conflict genuinely cannot be resolved. It is not a failure." Unconditionally running `commitTaskWork` regardless of `resolved` — today's behavior — means a `resolved: false` answer with a partially-edited-but-still-broken owned file would get `git add -A`'d and committed anyway (clearing its unmerged index status and burying the still-present markers in a real commit), silently letting the downstream `CONTINUE_REBASE` believe the rebase can proceed. This box must not call `commitTaskWork` at all when `resolved` is `false` — it passes the packet through unchanged, so the conflicted file's index entry stays genuinely unmerged, and `CONTINUE_REBASE`'s own `git rebase --continue` (via `advanceTaskRebase`) re-discovers the real conflict and feeds the existing `ARE_2_CONFLICT_FIXES_DONE_Q` retry-or-fail loop exactly as it does today.

- **`scripts/tackle-tasks/commitMergeConflictFixIfNeeded/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.test.ts`**
  - Line 58–65, today, the `answer(...)` helper used by all three existing tests: `additionalData: {}` — no `resolved`/`unresolvedPaths` keys, and `conflictedFilePaths: []`. This plan's new required-shape check would reject this fixture as written, so Step 3 updates it to `additionalData: { resolved: true, unresolvedPaths: [] }`. `conflictedFilePaths` stays `[]`, so the new marker scan has nothing to check and finds nothing — no other change to the three existing tests is required.

## Steps

### Step 1 — `FixConflictsBodyEmitter.ts` emits the packet answer protocol

`test_fixConflictsPrompt_endsWithTheSharedWhatToReturnSectionCarryingTheConflictReceiptShape` (replace the existing `test_fixConflictsPrompt_endsWithTheSharedWhatToReturnSectionAndCarriesNoDataBlock` in `scripts/tackle-tasks/shared/FixConflictsBodyEmitter.test.ts`, lines 58–65 — same fixture, new assertions):
- Step: build a prompt with `fixConflictsPrompt(makeConflictedRepo(), 99, "/tmp/fake-project-root", "run-1", "main")`.
- Step: assert the prompt still carries no `---- DATA ----` block and no bare `CHECKOUT_PATH`/`CONFLICTED_PATHS` placeholder (unchanged from today — `whatToReturnSection` does not reintroduce either).
- Assert: the prompt matches `/## WHAT YOU, THE SPAWNING AGENT, RETURNS/`.
- Assert: the prompt matches `/"message": "", "additionalData": \{ "resolved": "<[^"]+>", "unresolvedPaths": \["<[^"]+>"\] \}/` (the same value shape as today, now wrapped in the packet envelope).
- Assert: the prompt does **not** match `/## WHAT YOU PRINT/` (the old section is gone, not just supplemented).

Production code, `scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts`:
```ts
// before, line 6
import { printAsFinalMessageSection } from "./whatToReturn.ts";
// after
import { whatToReturnSection } from "./whatToReturn.ts";
```
```ts
// before, line 84
${printAsFinalMessageSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', "replacing every `<...>` with a real value")}`;
// after
${whatToReturnSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', "replacing every `<...>` with a real value", "")}`;
```
(Third argument `""` matches the established `explanationOfReturnShape` convention already used identically by `IMPLEMENT_TASK.ts:128` and `FIX_IMPLEMENT_TASK_TESTS.ts:73`.)

### Step 2 — `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts` validates the receipt and scans for remaining conflict markers before committing

`test_main_throwsWhenAdditionalDataHasNoBooleanResolved` (add to `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.test.ts`):
- Step: build the existing `answer(...)` fixture but override `additionalData` to `{}`.
- Step: call `main(...)` with it.
- Assert: it throws, matching `/additionalData holds no boolean "resolved"/`.

`test_main_throwsWhenAdditionalDataHasNoArrayUnresolvedPaths`:
- Step: same fixture, `additionalData: { resolved: true }` (no `unresolvedPaths`).
- Step: call `main(...)`.
- Assert: it throws, matching `/additionalData holds no array "unresolvedPaths"/`.

`test_main_throwsWhenResolvedTrueButAConflictMarkerRemains`:
- Step: use `makeTempRepoWithCommit("main")` and `createLinkedWorktree(rootOrigin)` exactly as the existing tests do.
- Step: `seedTaskAndMarkActiveAndLock(rootOrigin, taskNumber, "fix a conflict", "run-X")`.
- Step: `writeFileSync(join(worktreePath, "resolved.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");` (a genuine, unremoved marker in the file the agent was supposed to fix).
- Step: `JSON.parse(answer(rootOrigin, worktreePath, taskNumber, "run-X"))`, then override `conflictedFilePaths: ["resolved.txt"]` (the `answer(...)` helper always sets `conflictedFilePaths: []`) before re-stringifying and passing it to `main`.
- Step: call `main(...)`.
- Assert: it throws, matching `/conflict marker/`, and the message includes `resolved.txt`.
- Assert: `getCurrentTaskRun(taskNumber, rootOrigin)?.commits` is still `[]` — the check runs before `commitTaskWork`, so nothing gets committed.

`test_main_skipsCommitWhenResolvedIsFalse`:
- Step: same setup as `test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_commitsWhateverTheFixLeftDirty`, including `writeFileSync(join(worktreePath, "resolved.txt"), "resolved\n")`.
- Step: `JSON.parse(answer(rootOrigin, worktreePath, taskNumber, "run-X"))`, then override `additionalData: { resolved: false, unresolvedPaths: ["resolved.txt"] }` and `conflictedFilePaths: ["resolved.txt"]` before re-stringifying and passing it to `main`.
- Step: call `main(...)`.
- Assert: it does not throw and returns `{ ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: "continue" }`.
- Assert: `getCurrentTaskRun(taskNumber, rootOrigin)?.commits` is still `[]`, and `git(worktreePath, "status", "--porcelain")` still shows `resolved.txt` as dirty (`commitTaskWork` never ran, so the file was never staged or committed).

Production code, `scripts/tackle-tasks/commitMergeConflictFixIfNeeded/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts`:
```ts
// before
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
...
export function main(input: string): CommitMergeConflictFixIfNeededPacket {
    // The prompt block before this one leaves its own next in the packet; one exit path, so drop it.
    const { next: _next, ...packet } = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket & { next?: string };
    refreshOwnedSourceRepoLockOrThrow(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));

    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: "commit-merge-conflict-fix",
        rootSourceBranch: baseBranch(packet.projectRoot),
    });

    return { ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}
// after
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
...
const CONFLICT_MARKER_LINE = /^(<{7}|={7}|>{7})/m;

export function main(input: string): CommitMergeConflictFixIfNeededPacket {
    // The prompt block before this one leaves its own next in the packet; one exit path, so drop it.
    const { next: _next, ...packet } = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket & { next?: string };
    if (typeof packet.additionalData.resolved !== "boolean") {
        throw new Error(`COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: additionalData holds no boolean "resolved"`);
    }
    if (!Array.isArray(packet.additionalData.unresolvedPaths)) {
        throw new Error(`COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: additionalData holds no array "unresolvedPaths"`);
    }
    refreshOwnedSourceRepoLockOrThrow(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));

    if (packet.additionalData.resolved) {
        const stillMarked = packet.conflictedFilePaths.filter((relativePath) =>
            CONFLICT_MARKER_LINE.test(readFileSync(join(packet.stoppedCheckoutPath, relativePath), "utf8")),
        );
        if (stillMarked.length > 0) {
            throw new Error(`COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: resolved: true but ${stillMarked.length} file(s) still hold a conflict marker: ${stillMarked.join(", ")}`);
        }
        commitTaskWork({
            projectRoot: packet.projectRoot,
            worktreePath: packet.worktree,
            taskNumber: packet.taskNumber,
            runId: packet.runId,
            stepId: "commit-merge-conflict-fix",
            rootSourceBranch: baseBranch(packet.projectRoot),
        });
    }

    return { ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}
```
(`refreshOwnedSourceRepoLockOrThrow` stays unconditional, ahead of the `if (packet.additionalData.resolved)` block — the source repo lock's heartbeat must keep refreshing on every pass through this box regardless of whether this particular attempt resolved anything, or a long-running retry loop could lose the lock to another run. Single condition per `if`: "is the shape valid" is checked in two separate `if`s already above; "should this attempt commit at all" is the one new condition this step adds.)

### Step 3 — update the existing fixture helper for the new required shape

`test_COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED_commitsWhateverTheFixLeftDirty`, `..._runsTwiceWithTheSameInput`, `..._carriesTheStoppedLayerThroughUnchangedForContinueRebase` (all three existing, unchanged assertions) — update only their shared fixture:
```ts
// before, line 58-65
function answer(projectRoot: string, worktree: string, taskNumber: number, runId: string): string {
    const packet: CommitMergeConflictFixIfNeededPacket = {
        box: "FIX_CONFLICTS", scriptSignal: "continue", taskNumber, runId, projectRoot, worktree, branch: `task-${taskNumber}`,
        exitType: "", exitNote: "", message: "resolved the conflict", additionalData: {}, stoppedOccurrenceId: "",
        stoppedCheckoutPath: worktree, conflictedFilePaths: [], conflicted: true, finished: false, failureReason: "",
    };
    return JSON.stringify(packet);
}
// after
function answer(projectRoot: string, worktree: string, taskNumber: number, runId: string): string {
    const packet: CommitMergeConflictFixIfNeededPacket = {
        box: "FIX_CONFLICTS", scriptSignal: "continue", taskNumber, runId, projectRoot, worktree, branch: `task-${taskNumber}`,
        exitType: "", exitNote: "", message: "resolved the conflict", additionalData: { resolved: true, unresolvedPaths: [] }, stoppedOccurrenceId: "",
        stoppedCheckoutPath: worktree, conflictedFilePaths: [], conflicted: true, finished: false, failureReason: "",
    };
    return JSON.stringify(packet);
}
```
No other line in these three tests changes; each still sets `conflictedFilePaths: []`, so Step 2's marker scan has nothing to check (the `.filter` runs over an empty array) and they pass unchanged.

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

If it does not print `all passing`, run `npm test 2>&1 | tail -50` and fix the codebase (never the tests, unless a test is fraudulent) until it does. Pay particular attention to `tests/stepTemplates.test.ts`'s `test_stepTemplate_pipeline-fixConflicts_FIX_CONFLICTS_promptHasNoContinuationInstructions`-style checks and the `FIX_CONFLICTS.test.ts` suite — none of Step 1/2/3's changes alter `FIX_CONFLICTS.ts`'s own `main()` or its template, so these should pass unchanged, but they are the closest existing coverage to this box and are worth watching first if anything regresses.
