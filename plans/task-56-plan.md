# Task 56 plan: produce real TestReceipts and reviewHandoffs, define occurrenceDigests

## Design decisions (resolved here, not left to the implementer)

- **TestReceipt producer**: `skills/tackle-tasks/test.workflow.js` already builds
  `tests` (one `{groupId, passed, rounds, failures, notes}` per group). Map that
  directly to `TestReceipt` (`scripts/approvalReadiness.ts` lines 22–25:
  `{groupId: string; status: "green" | "red"}`): `groupId: String(t.groupId)`,
  `status: t.passed ? 'green' : 'red'`. Add this as a new `testReceipts` field
  on the workflow's existing return.
- **reviewHandoffs source**: the verify phase's codex verdicts, per the brief's
  own instruction. `skills/tackle-tasks/verify.workflow.js` already builds
  `verified` (one `{task, verdict, revised, notes}` per planned task). Turn
  each into one string: `` `task ${v.task}: ${v.verdict}${v.revised ? ' (revised)' : ''} - ${v.notes}` ``,
  covering both approved and rejected tasks (a complete review record, not
  just the successes). Add this as a new `reviewHandoffs` field on the
  workflow's existing return.
- **occurrenceDigests algorithm**: `scripts/approvalGate.ts` line 15 types this
  as `occurrenceDigests: string[]` inside `ApprovalDigestInput`. No owned file
  computes it today, and the brief rules out raw git oids ("baseOid") as the
  source. A per-file content hash was rejected on review: it breaks on
  deletions (no on-disk file left to read) and on submodule/gitlink paths
  (directories, not readable files). Use a stable **git-tree snapshot** per
  group instead: add an exported type
  `OccurrenceSnapshot = { groupId: number; repositoryPath: string; treeListing: string }`
  and an exported function `computeOccurrenceDigests(snapshots: OccurrenceSnapshot[]): string[]`
  in `scripts/approvalGate.ts` that sorts a copy of `snapshots` by
  `groupId` then `repositoryPath` (deterministic order independent of input
  order — this is what makes the result ordered, not the caller), then hashes
  each sorted record whole with the file's existing `stableStringify` +
  `createHash("sha256")`, returning the hex digests in that sorted order.
  `treeListing` is an opaque string the caller supplies (the raw output of a
  `git ls-tree` call) — `computeOccurrenceDigests` itself never touches git or
  the filesystem, so deletions (an absent tree entry) and gitlinks (a
  `160000` entry) are just more bytes in the string it hashes.
- **Where the snapshots come from**: `scripts/mergeTaskWorktrees.ts`'s
  `runPipelineCli` builds one `OccurrenceSnapshot` per `(group, repositoryPath)`
  pair for every group that ended up in `merged` (never for a group in
  `conflicts` — only merged evidence counts), for `repositoryPath` `""` (the
  main repo) and every path in `submodulePathsDeepestFirst` (the same
  paths its existing submodule-merge loop already iterates for every group,
  so no new "did this group touch this repo" branch is needed). For `""`,
  `treeListing` is `git(workflowArguments.repo, "ls-tree", "-r", "-z", group.branch)`
  — resolving the group's branch **ref**, not its checked-out worktree, so it
  is unaffected by `repoRoot` having since been checked out to
  `sourceBranch` and merged into. For a submodule path, `treeListing` is
  `git(join(group.worktree, repositoryPath), "ls-tree", "-r", "-z", "HEAD")`
  — read from the group's own dedicated submodule worktree, which is never
  checked out anywhere else and so is unaffected by merging that submodule
  into the main submodule path. Both are safe to compute **after** the merge
  loop finishes (unlike a diff against `sourceBranch`, a branch ref and an
  untouched worktree don't go stale once their content has been merged
  elsewhere), so a merge retry recomputes identical evidence for
  already-merged groups without needing to cache anything from before the
  loop ran.
- **Threading into the merge step's args**: `mergeCliInput` in
  `skills/tackle-tasks/merge.workflow.js` is exactly what
  `scripts/mergeTaskWorktrees.ts`'s CLI (`runPipelineCli`) receives as its one
  argument — that is "the merge step['s] args" the brief refers to. Add
  `testReceipts` and `reviewHandoffs` to that object, sourced from the
  orchestrator's step 4 and step 2 results per the `SKILL.md` update below.
  `runPipelineCli` then has real `testReceipts`/`reviewHandoffs` in its own
  `CliInput`, computes `occurrenceDigests` itself, and reports all three in
  its stdout JSON alongside `merged`/`conflicts`.
- **Scope boundary**: `mergeTaskWorktrees.ts` only *receives and reports* this
  evidence — it does not call `assessApprovalReadiness` or `approvalGate.ts`'s
  `recordApproval`/`issueApprovalAuthorization`, because no owned file
  currently constructs an `ApprovalReadinessInput` or a `RunState`, and
  wiring that up would require editing whatever file does construct those
  (not in the owned list). This plan stops at "the merge step receives real
  evidence in its args," which is the brief's literal requirement.
- **No changes to `scripts/approvalReadiness.ts`**: neither this plan's new
  function nor its call sites touch any type or function it exports, so its
  behavior is unaffected; the file needs no edit.
- **`tests/approvalReadiness.test.ts` gets new tests, not changed ones**: the
  file's existing tests are untouched (they test `approvalReadiness.ts`
  behavior, which this plan does not change), but it is this task's only
  owned test file, so the tests this plan needs for
  `computeOccurrenceDigests` (ordering, content sensitivity, deletions,
  gitlinks — see review feedback below) go here, importing the function from
  `../scripts/approvalGate.ts` alongside the file's existing
  `approvalReadiness.ts` imports.

## Edits

### 1. `skills/tackle-tasks/test.workflow.js`

Current line 158 (last line of file):
```
return { tests, allPassed: tests.every((t) => t.passed) }
```
Becomes:
```
const testReceipts = tests.map((t) => ({ groupId: String(t.groupId), status: t.passed ? 'green' : 'red' }))

return { tests, allPassed: tests.every((t) => t.passed), testReceipts }
```

### 2. `skills/tackle-tasks/verify.workflow.js`

Current lines 83–88:
```
return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
}
```
Becomes:
```
const reviewHandoffs = verified.map((v) => `task ${v.task}: ${v.verdict}${v.revised ? ' (revised)' : ''} - ${v.notes}`)

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
  reviewHandoffs,
}
```

### 3. `scripts/approvalGate.ts`

Current lines 47–51 (no import changes needed — `createHash` is already
imported, and this function touches no filesystem or git object, only the
strings it is given):
```
export function computeApprovalDigest(input: ApprovalDigestInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function recordApproval(runState: RunState): Approval {
```
Becomes:
```
export function computeApprovalDigest(input: ApprovalDigestInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type OccurrenceSnapshot = { groupId: number; repositoryPath: string; treeListing: string };

// Hashes the whole sorted record, not a git oid, so deletions and gitlinks are just more bytes.
export function computeOccurrenceDigests(snapshots: OccurrenceSnapshot[]): string[] {
    return [...snapshots]
        .sort((a, b) => a.groupId - b.groupId || a.repositoryPath.localeCompare(b.repositoryPath))
        .map((snapshot) => createHash("sha256").update(stableStringify(snapshot)).digest("hex"));
}

export function recordApproval(runState: RunState): Approval {
```

### 4. `scripts/mergeTaskWorktrees.ts`

Edit A — current lines 6–11:
```
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
```
Becomes:
```
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { computeOccurrenceDigests } from "./approvalGate.ts";
import type { OccurrenceSnapshot } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
```

Edit B — current lines 13–21:
```
type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
};
```
Becomes:
```
type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};
```

Edit C — current lines 245–248 (inside `runPipelineCli`, no change needed to
the merge loop itself — the loop is untouched, evidence is built from `merged`
after it finishes):
```
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
    }
    const endTimestamp = new Date().toISOString();
```
Becomes:
```
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
    }
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => {
        const group = sortedGroups.find((g) => g.groupId === outcome.groupId)!;
        return ["", ...submodulePathsDeepestFirst].map((repositoryPath) => ({
            groupId: group.groupId,
            repositoryPath,
            treeListing: repositoryPath === ""
                ? git(workflowArguments.repo, "ls-tree", "-r", "-z", group.branch)
                : git(join(group.worktree, repositoryPath), "ls-tree", "-r", "-z", "HEAD"),
        }));
    });
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const endTimestamp = new Date().toISOString();
```
Only groups in `merged` contribute snapshots (a rejected/conflicted group has
no evidence to report). The `""` branch resolves `group.branch` as a git ref
in the main repo, unaffected by `repoRoot` having since been checked out to
`sourceBranch`; the submodule branch resolves `HEAD` inside the group's own
dedicated submodule worktree (`join(group.worktree, repositoryPath)`), which
merging into the main submodule path never touches. Both stay valid after the
loop ends, including on a merge retry.

Edit D — current line 264:
```
    process.stdout.write(JSON.stringify({ merged, conflicts }));
```
Becomes:
```
    process.stdout.write(JSON.stringify({
        merged,
        conflicts,
        testReceipts: input.testReceipts ?? [],
        reviewHandoffs: input.reviewHandoffs ?? [],
        occurrenceDigests,
    }));
```

### 5. `skills/tackle-tasks/merge.workflow.js`

Edit A — current lines 39–52:
```
const mergeCliInput = {
  repo: ARGS.repo,
  typecheckCommand: ARGS.typecheckCommand ?? 'npx tsc --noEmit',
  groups: ARGS.groups ?? [],
  repositorySources: ARGS.repositorySources,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
}
```
Becomes:
```
const mergeCliInput = {
  repo: ARGS.repo,
  typecheckCommand: ARGS.typecheckCommand ?? 'npx tsc --noEmit',
  groups: ARGS.groups ?? [],
  repositorySources: ARGS.repositorySources,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
  testReceipts: ARGS.testReceipts ?? [],
  reviewHandoffs: ARGS.reviewHandoffs ?? [],
}
```

Edit B — current `RUN_SCHEMA`:
```
const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    merged: { type: 'array' },
    conflicts: { type: 'array' },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'error'],
}
```
Becomes:
```
const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    merged: { type: 'array' },
    conflicts: { type: 'array' },
    testReceipts: { type: 'array' },
    reviewHandoffs: { type: 'array', items: { type: 'string' } },
    occurrenceDigests: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'testReceipts', 'reviewHandoffs', 'occurrenceDigests', 'error'],
}
```

Edit C — current `runBrief`:
```
const runBrief = `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

result = run(${command})

if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged or conflicts values on the success branch.`
```
Becomes:
```
const runBrief = `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

result = run(${command})

if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, testReceipts: result.stdout.testReceipts, reviewHandoffs: result.stdout.reviewHandoffs, occurrenceDigests: result.stdout.occurrenceDigests, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], testReceipts: [], reviewHandoffs: [], occurrenceDigests: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged, conflicts, testReceipts, reviewHandoffs, or occurrenceDigests values on
the success branch.`
```

Edit D — current clean-first-attempt return:
```
if (mergeResultCode(firstMergeAttempt) === MERGE_OK) {
  return { merged: firstMergeAttempt.merged, conflicts: [], fixedBlockers: null, blockers: [], decisions: [] }
}
```
Becomes:
```
if (mergeResultCode(firstMergeAttempt) === MERGE_OK) {
  return {
    merged: firstMergeAttempt.merged,
    conflicts: [],
    testReceipts: firstMergeAttempt.testReceipts,
    reviewHandoffs: firstMergeAttempt.reviewHandoffs,
    occurrenceDigests: firstMergeAttempt.occurrenceDigests,
    fixedBlockers: null,
    blockers: [],
    decisions: [],
  }
}
```

Edit E — current blocked-after-diagnosis return:
```
if (diagnosisFixed === false || decisionsPending === true) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    fixedBlockers: false,
    blockers: diagnosisMissing ? ['the diagnosing agent returned no result'] : diagnosis.blockers,
    decisions: diagnosisMissing ? [] : diagnosis.decisions,
    summary: diagnosisSummary,
  }
}
```
Becomes (`occurrenceDigests` is always `[]` here — a blocked merge has no
merged evidence to report, even if a prior attempt produced some):
```
if (diagnosisFixed === false || decisionsPending === true) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    testReceipts: firstMergeAttempt?.testReceipts ?? [],
    reviewHandoffs: firstMergeAttempt?.reviewHandoffs ?? [],
    occurrenceDigests: [],
    fixedBlockers: false,
    blockers: diagnosisMissing ? ['the diagnosing agent returned no result'] : diagnosis.blockers,
    decisions: diagnosisMissing ? [] : diagnosis.decisions,
    summary: diagnosisSummary,
  }
}
```

Edit F — current final return (after the retry):
```
return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}
```
Becomes (`occurrenceDigests` is `[]` when the retry itself failed, otherwise
the retry's own digests — never a stale value from the first attempt):
```
return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  testReceipts: retry?.testReceipts ?? [],
  reviewHandoffs: retry?.reviewHandoffs ?? [],
  occurrenceDigests: retryFailed ? [] : (retry?.occurrenceDigests ?? []),
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}
```

### 6. `skills/tackle-tasks/SKILL.md`

Edit A — current lines 44–48:
```
Reviews each plan with codex. On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns `{verified, approved, rejected, revisedCount}`. If `approved` is
empty, stop and report — there is nothing to implement. Report `revisedCount`
so the user knows how many plan files codex rewrote.
```
Becomes:
```
Reviews each plan with codex. On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns `{verified, approved, rejected, revisedCount, reviewHandoffs}`.
If `approved` is empty, stop and report — there is nothing to implement.
Report `revisedCount` so the user knows how many plan files codex rewrote.
`reviewHandoffs` is one string per verified task recording codex's verdict —
real evidence the approval gate later checks, carried into step 6.
```

Edit B — current line 63:
```
Returns `{tests, allPassed}`.
```
Becomes:
```
Returns `{tests, allPassed, testReceipts}`. `testReceipts` is one
`{groupId, status}` record per group — real evidence the approval gate later
checks, carried into step 6.
```

Edit C — current lines 70–79:
```
**Step 6 — merge.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/merge.workflow.js`,
args = the pipeline args JSON plus:
- `approvedByUser`: `true` — only after the user approved in step 5. The
  workflow refuses to merge without it.
- `doneCount`: length of `done` from step 3.
- `partialCount`: length of `partial` from step 3.
- `blockedCount`: length of `blocked` from step 3.
- `needsClarificationCount`: length of `needsClarification` from step 1.
- `rejectedCount`: length of `rejected` from step 2.
- `requeueCount`: `requeueCount` from step 3.
```
Becomes:
```
**Step 6 — merge.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/merge.workflow.js`,
args = the pipeline args JSON plus:
- `approvedByUser`: `true` — only after the user approved in step 5. The
  workflow refuses to merge without it.
- `doneCount`: length of `done` from step 3.
- `partialCount`: length of `partial` from step 3.
- `blockedCount`: length of `blocked` from step 3.
- `needsClarificationCount`: length of `needsClarification` from step 1.
- `rejectedCount`: length of `rejected` from step 2.
- `requeueCount`: `requeueCount` from step 3.
- `testReceipts`: `testReceipts` from step 4, verbatim — real green/red
  evidence per group.
- `reviewHandoffs`: `reviewHandoffs` from step 2, verbatim — real codex
  review evidence per task.

`mergeTaskWorktrees.ts` receives `testReceipts` and `reviewHandoffs` in its
own CLI args, computes an `occurrenceDigests` array from a git-tree snapshot
of each merged group's branch (main repo and every submodule), and includes
all three in its stdout JSON alongside `merged`/`conflicts` — this is the
real evidence an approval gate needs instead of an empty or fabricated array.
```

Edit D — current "Returns" line for step 6, a few lines further down:
```
Returns `{merged, conflicts, fixedBlockers, blockers, decisions, summary}`.
```
Becomes:
```
Returns `{merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests,
fixedBlockers, blockers, decisions, summary}`. `testReceipts` and
`reviewHandoffs` are the evidence carried in from steps 4 and 2;
`occurrenceDigests` is the git-tree-snapshot evidence `mergeTaskWorktrees.ts`
itself computes for whatever merged in this run, and is empty whenever the
merge did not fully complete.
```

### 7. `tests/approvalReadiness.test.ts`

Current import block:
```
import {
    assessApprovalReadiness,
    isActionableExerciseMethod,
    reviewGroupExerciseMethod,
} from "../scripts/approvalReadiness.ts";
import type { ApprovalReadinessInput } from "../scripts/approvalReadiness.ts";
```
Becomes (adding an import from `approvalGate.ts` — the file already imports
from more than one module, this just adds a second `../scripts/` source):
```
import {
    assessApprovalReadiness,
    isActionableExerciseMethod,
    reviewGroupExerciseMethod,
} from "../scripts/approvalReadiness.ts";
import type { ApprovalReadinessInput } from "../scripts/approvalReadiness.ts";
import { computeOccurrenceDigests } from "../scripts/approvalGate.ts";
import type { OccurrenceSnapshot } from "../scripts/approvalGate.ts";
```

Add these four tests at the end of the file (after the last existing
`test(...)` block, before the file's closing):
```
test("test_occurrenceDigestOrderIsSortedByGroupIdThenRepositoryPath", () => {
    const reversed: OccurrenceSnapshot[] = [
        { groupId: 2, repositoryPath: "sub", treeListing: "b" },
        { groupId: 1, repositoryPath: "sub", treeListing: "a" },
        { groupId: 1, repositoryPath: "", treeListing: "c" },
    ];
    const forward: OccurrenceSnapshot[] = [
        { groupId: 1, repositoryPath: "", treeListing: "c" },
        { groupId: 1, repositoryPath: "sub", treeListing: "a" },
        { groupId: 2, repositoryPath: "sub", treeListing: "b" },
    ];
    assert.deepEqual(computeOccurrenceDigests(reversed), computeOccurrenceDigests(forward));
});

test("test_occurrenceDigestChangesWithTreeListingContent", () => {
    const base: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "100644 blob abc\tfile.ts\0" }];
    const changed: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "100644 blob def\tfile.ts\0" }];
    assert.notEqual(computeOccurrenceDigests(base)[0], computeOccurrenceDigests(changed)[0]);
});

test("test_occurrenceDigestHandlesDeletionAsAbsentTreeEntry", () => {
    const withFile: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "100644 blob abc\tfile.ts\0" }];
    const withoutFile: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "" }];
    assert.notEqual(computeOccurrenceDigests(withFile)[0], computeOccurrenceDigests(withoutFile)[0]);
});

test("test_occurrenceDigestHandlesGitlinkEntryDeterministically", () => {
    const snapshot: OccurrenceSnapshot = { groupId: 1, repositoryPath: "", treeListing: "160000 commit abc123\tsub\0" };
    assert.equal(computeOccurrenceDigests([snapshot])[0], computeOccurrenceDigests([snapshot])[0]);
});
```
These test `computeOccurrenceDigests` directly on hand-built `treeListing`
strings (no git process invoked in the test) — a deletion and a `160000`
gitlink are just different byte content to the function, which is exactly
why it needs no special-casing for either.

## Files needing no edit (accounted for)

- `scripts/approvalReadiness.ts` — no exported type or function it defines is
  changed or newly consumed by this plan; nothing to edit.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `npx tsc --noEmit`
   Expected: exit code 0, no errors — confirms the new imports/types in
   `scripts/approvalGate.ts` and `scripts/mergeTaskWorktrees.ts` (the two real
   TypeScript modules touched) type-check cleanly, including the new
   `computeOccurrenceDigests` import and the widened `CliInput` type.

2. Smoke-test the new digest function directly, using only a hand-built
   snapshot so the check doesn't depend on any file outside the owned list or
   on git being run:
   ```
   bun -e "
   import { computeOccurrenceDigests } from './scripts/approvalGate.ts';
   const snapshot = { groupId: 1, repositoryPath: '', treeListing: '100644 blob deadbeef\tfile.ts\0' };
   console.log(JSON.stringify(computeOccurrenceDigests([snapshot, snapshot])));
   "
   ```
   Expected: prints a JSON array of exactly two equal 64-character lowercase
   hex strings — hashing the same snapshot twice yields the same digest
   (determinism), one entry per input snapshot.

3. `bun test tests/approvalReadiness.test.ts`
   Expected: all tests pass, including the four new
   `test_occurrenceDigest*` tests added in Edit 7 above (ordering, content
   sensitivity, deletion, gitlink) and every pre-existing test in the file
   (regression check — `scripts/approvalReadiness.ts` itself is unchanged).

4. Confirm the evidence fields actually survive every return path in
   `merge.workflow.js`, not just that their names appear somewhere in the
   file — read the file after editing and check each of the following
   contains all three of `testReceipts`, `reviewHandoffs`, and
   `occurrenceDigests`: `RUN_SCHEMA`'s `properties` and `required` arrays,
   the `runBrief` template's two `return {...}` lines, the clean-first-attempt
   `return` (Edit D), the blocked `return` (Edit E, where `occurrenceDigests`
   must specifically be `[]`), and the final post-retry `return` (Edit F,
   where `occurrenceDigests` must be `[]` when `retryFailed` is true). A
   mechanical check for the same thing:
   ```
   rg -c "testReceipts|reviewHandoffs|occurrenceDigests" skills/tackle-tasks/merge.workflow.js
   ```
   Expected: at least 12 (3 fields × roughly 4 sites each: schema, runBrief,
   and the three JS `return` statements) — a count near 3 or 6 would mean a
   return path was missed, not just that the fields exist somewhere.

5. Consistency of the threaded keys across the remaining workflow files and
   the skill doc (the `.workflow.js` files run inside a custom harness this
   repo does not expose to planning, so this greps for the key names instead
   of executing them):
   ```
   rg -c "testReceipts" skills/tackle-tasks/test.workflow.js skills/tackle-tasks/SKILL.md
   rg -c "reviewHandoffs" skills/tackle-tasks/verify.workflow.js skills/tackle-tasks/SKILL.md
   rg -c "occurrenceDigests" scripts/approvalGate.ts scripts/mergeTaskWorktrees.ts skills/tackle-tasks/SKILL.md
   ```
   Expected: every listed file reports at least one match for its key,
   confirming the value is produced and documented in `SKILL.md` — not
   dropped anywhere along the chain.
