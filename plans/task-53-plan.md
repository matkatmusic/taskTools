# Task 53 Plan: Re-scope task 49 — supply authorization, occurrence and receipt data to mergeTaskWorktrees

## Problem

Task 49 wants `mergeTaskWorktrees.ts` to drive the finalization chain
(`runFinalizer` → `runConsolidation` → `operationPush` → `basePublication` →
`taskArchival`), but every one of those needs a `RunAuthorizationToken`/`RunState`.
That token can only be minted by `approvalGate.ts`'s
`recordApproval` → `issueApprovalAuthorization` flow, which needs an
`ApprovalDigestInput`:

```ts
type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
    baseRef: string;
    occurrenceDigests: string[];
    testReceipts: TestReceipt[];
    reviewHandoffs: string[];
};
```

None of `manifest`, `occurrenceDigests`, `testReceipts`, or `reviewHandoffs`
exist on `WorkflowArguments` or on the flat `CliInput` that
`mergeTaskWorktrees.ts` reads from `argv[2]`. Task 49 forbids changing the
CLI contract, so its two owned files can't supply this data — task 49 is
unimplementable as scoped. Task 53 fixes the plumbing gap and re-opens task 49.

## Decision: widen the CLI contract (not a prerequisite step)

Two options were on the table:

1. **Widen the CLI contract** — add optional fields to `CliInput` for the
   data that genuinely can't be derived locally (test receipts, review
   handoffs); derive everything else (`manifest`, `files`, ref data) inside
   `mergeTaskWorktrees.ts` from data it already has or can rebuild with an
   existing helper.
2. **Add a prerequisite step** — a new script that mints the authorization
   and builds the occurrence graph before `mergeTaskWorktrees.ts` runs.

Going with **option 1**, because:

- `CliInput` already *is* a widened, ad-hoc extension of `WorkflowArguments`
  (`runId`, `startTimestamp`, `doneCount`, `partialCount`, `blockedCount`,
  `needsClarificationCount`, `requeueCount` are all optional bolt-ons the
  caller may or may not supply). Adding a few more optional fields is the
  same pattern, not a new one — no new IPC boundary, no new file.
- `prepareTasks.ts` already builds a `RepositoryManifest` via
  `bootstrapRepositoryManifest` (see `loadRepositoryManifest`).
  `mergeTaskWorktrees.ts` has the same `repo` root available in
  `runPipelineCli` and can call the same helper itself — the manifest never
  needs to cross the JSON boundary at all.
- `files` is already on `WorkflowArguments` (every `PreparedTask.files`,
  flattened across groups) — no new plumbing needed.
- `operationRef`/`baseRef` are resolvable from data already in
  `WorkflowArguments.repositorySources` and the merged group branches.
- Only `testReceipts` and `reviewHandoffs` are truly external — they're
  produced by the test-running phase, upstream of the merge phase, and have
  no other route into `mergeTaskWorktrees.ts` than being handed to it. That's
  the one real widening this task has to do.
- Option 2 means a new script file plus a new phase wedged into the
  plan/verify/implement/test/merge sequence in `SKILL.md` — more files, more
  moving parts, for data half of which doesn't need transporting at all.

**Note:** `skills/tackle-tasks/merge.workflow.js` shows as already modified
(uncommitted) in git status. Before touching it, read its current state —
this exact wiring may already be partway done there.

## Design

### 1. `scripts/mergeTaskWorktrees.ts` — widen `CliInput`, mint the authorization

Add the two genuinely-external fields to `CliInput`:

```ts
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

(Import `TestReceipt` from `./approvalReadiness.ts`.)

Add a small, exported builder that assembles `ApprovalDigestInput` and mints
the authorization, so task 49's finalizer wiring (and any future caller) can
import it instead of re-deriving this by hand. Minting is gated on evidence
actually being present — a missing or red `testReceipts`, or missing
`reviewHandoffs`, must return `null` instead of silently defaulting to `[]`
and minting anyway:

```ts
export function buildRunAuthorization(
    workflowArguments: WorkflowArguments,
    input: CliInput,
    manifest: RepositoryManifest,
    operationRef: string,
    baseRef: string,
): RunAuthorizationToken | null {
    if (!input.testReceipts || input.testReceipts.length === 0) return null;
    if (input.testReceipts.some((receipt) => receipt.status === "red")) return null;
    if (!input.reviewHandoffs || input.reviewHandoffs.length === 0) return null;

    const files = workflowArguments.groups.flatMap((g) => g.tasks.flatMap((t) => t.files));
    const digestInput: ApprovalDigestInput = {
        manifest,
        files,
        operationRef,
        baseRef,
        occurrenceDigests: manifest.occurrences.map((occurrence) => occurrence.baseOid),
        testReceipts: input.testReceipts,
        reviewHandoffs: input.reviewHandoffs,
    };
    // readyForApproval is true here only because the three guards above already passed.
    const runState: RunState = { readyForApproval: true, status: "pending", digestInput };
    recordApproval(runState);
    return issueApprovalAuthorization(runState);
}
```

`occurrenceDigests` is each occurrence's `baseOid` (its current commit hash —
`repositoryManifest.ts`'s `RepositoryOccurrence` has no separate digest
field, and `baseOid` already serves as one).

Add `loadRepositoryManifest` to the manifest-building step: export it from
`scripts/prepareTasks.ts` (see section 2) and import it here instead of
calling `bootstrapRepositoryManifest` directly, so the refusal handling
(`throw` when `result.refused`) isn't duplicated:

```ts
import { loadRepositoryManifest } from "./prepareTasks.ts";
```

Wire it into `runPipelineCli`, right after merges are resolved, and include
the token in the CLI's stdout JSON. `operationRef`/`baseRef` are plain
strings — `ApprovalDigestInput` (in `approvalGate.ts`, already quoted above)
declares them as `string`, not `string[]`, so a multi-group run joins its
branch names into one string:

```ts
const manifest = loadRepositoryManifest(workflowArguments.repo);
const operationRef = sortedGroups.map((g) => g.branch).join(",");
const baseRef = findSourceBranch("");
const authorization = buildRunAuthorization(workflowArguments, input, manifest, operationRef, baseRef);
const publicationTargets = buildPublicationTargets(manifest);
process.stdout.write(JSON.stringify({ merged, conflicts, authorization, publicationTargets }));
```

This task does **not** call `runFinalizer`/`runConsolidation`/`operationPush`/
`basePublication`/`taskArchival` — that remains task 49's job, now unblocked
because it has a token and publication targets to work with. Keep this
change to: widen `CliInput`, build the manifest locally, mint and surface the
token, and build+surface `publicationTargets` (section 4).

### 2. `scripts/prepareTasks.ts` — export `loadRepositoryManifest`

Change:

```ts
function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
```

to:

```ts
export function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
```

No other change to this file. `WorkflowArguments` already carries everything
`mergeTaskWorktrees.ts` needs to derive `files`.

### 3. `skills/tackle-tasks/merge.workflow.js` — pass through the new fields

Its current (already-modified) state builds `mergeCliInput` from `ARGS` and
does not read or forward `testReceipts`/`reviewHandoffs` at all — `ARGS` has
no such fields today because nothing upstream of this script supplies them
yet (the caller that builds `ARGS` is outside `skills/tackle-tasks/` and
outside this task's owned files, so it cannot be changed here). Add a
straight pass-through, forwarding `undefined` when the caller hasn't
supplied them — do not invent or default to non-empty values here:

```js
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
  testReceipts: ARGS.testReceipts,
  reviewHandoffs: ARGS.reviewHandoffs,
}
```

When the orchestrator hasn't been updated to supply `ARGS.testReceipts`/
`ARGS.reviewHandoffs`, `mergeCliInput.testReceipts`/`.reviewHandoffs` are
`undefined`, `buildRunAuthorization` (section 1) returns `null`, and
`result.authorization` in the CLI's stdout JSON is `null` — no token is
minted without real evidence. Wiring the orchestrator itself to produce
`ARGS.testReceipts`/`ARGS.reviewHandoffs` is outside this task's owned
files and is not part of this plan.

### 4. The `LogicalRepository` name collision — alias, don't rename

`scripts/logicalRepository.ts` and `scripts/basePublication.ts` both export
a type named `LogicalRepository` with incompatible shapes:

- `logicalRepository.ts`'s version is the canonical, occurrence-grouping
  shape (`normalizedIdentity`, `occurrenceIds`, `canonicalOccurrenceId`,
  `convergenceDigest`, `consolidationState`).
- `basePublication.ts`'s version is a per-repo *publish plan*
  (`canonicalOccurrencePath`, `canonicalRefName`, `otherOccurrences`,
  `recordedBaseOid`, `targetOid`).

A grep for `LogicalRepository` (run 2026-08-05) shows `basePublication.ts`'s
export is imported by name from three places outside this task's owned
files: `tests/basePublication.test.ts`, plus `scripts/runConsolidation.ts`
and `scripts/operationPush.ts` import a *same-named* type from
`logicalRepository.ts` (not from `basePublication.ts` — those two are
unaffected either way). Renaming `basePublication.ts`'s export to
`PublicationTarget` would change `tests/basePublication.test.ts`'s import
(`import type { LogicalRepository, UpdatedRef } from "../scripts/basePublication.ts";`)
from a valid import to a compile error — and that test file is not in this
task's owned files. **Renaming the export is therefore out of scope for
task 53 and must not be done.**

What *is* in scope: `mergeTaskWorktrees.ts` (owned) is the first file that
needs to import both `LogicalRepository` types at once (one from
`logicalRepository.ts` to build occurrence groups, one from
`basePublication.ts`'s shape to build publish targets), which is where the
collision actually bites. Resolve it there with an import alias, and add a
converter, both scoped to `mergeTaskWorktrees.ts`:

```ts
import { buildLogicalRepositories } from "./logicalRepository.ts";
import type { LogicalRepository as PublicationTarget } from "./basePublication.ts";

export function buildPublicationTargets(manifest: RepositoryManifest): PublicationTarget[] {
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    return buildLogicalRepositories(manifest.occurrences).map((logicalRepo) => {
        const canonical = occurrenceById.get(logicalRepo.canonicalOccurrenceId)!;
        const otherOccurrences = logicalRepo.occurrenceIds
            .filter((id) => id !== logicalRepo.canonicalOccurrenceId)
            .map((id) => {
                const occurrence = occurrenceById.get(id)!;
                return { path: occurrence.checkoutPath, refName: occurrence.baseBranch };
            });
        return {
            name: `${logicalRepo.normalizedIdentity.owner}/${logicalRepo.normalizedIdentity.repository}`,
            canonicalOccurrencePath: canonical.checkoutPath,
            canonicalRefName: canonical.baseBranch,
            otherOccurrences,
            recordedBaseOid: canonical.baseOid,
            targetOid: git(canonical.checkoutPath, "rev-parse", "HEAD").trim(),
        };
    });
}
```

`targetOid` reads the canonical occurrence's current `HEAD` — call this
*after* `mergeGroupBranchIntoRepo` has already applied the run's merges (see
the `runPipelineCli` wiring in section 1), so `HEAD` reflects the
post-merge commit that publication should push forward to.

`buildPublicationTargets` is exported and included in `runPipelineCli`'s
stdout JSON (section 1) but is **not** called against `basePublication.ts`'s
`publishBases` — invoking the actual publication phase remains task 49's
job, same as the authorization token.

**Residual defect, deliberately left for a later task:** the two
`LogicalRepository` exports still share a name in their own files; only the
one place that needs both (`mergeTaskWorktrees.ts`) is disambiguated. A full
rename requires updating `tests/basePublication.test.ts`, which needs that
file added to a task's owned-files list — not something this plan can do.

## Test plan

- `tests/mergeTaskWorktrees.test.ts`: add a case that calls
  `buildRunAuthorization` with `testReceipts` (all `"green"`) and
  `reviewHandoffs` supplied on `CliInput`, and asserts the result is a
  non-null token with a `stateDigest`. Add three more cases asserting `null`
  is returned when: `testReceipts` is omitted, `testReceipts` contains a
  `"red"` entry, and `reviewHandoffs` is omitted.
- `tests/mergeTaskWorktrees.test.ts`: add a case that calls
  `buildPublicationTargets` against a small manifest fixture (two
  occurrences sharing one `originUrl`, one distinct) and asserts the
  returned `PublicationTarget[]` has one entry per distinct upstream, with
  `canonicalOccurrencePath`/`canonicalRefName`/`recordedBaseOid` matching the
  canonical occurrence's fields and `otherOccurrences` containing the rest.
- Run `npx tsc --noEmit` — confirms the `basePublication.ts` type-alias
  import in `mergeTaskWorktrees.ts` compiles against the (unrenamed)
  `LogicalRepository` export.

Do not add or modify `tests/basePublication.test.ts` — it is not in this
task's owned files, and section 4 above doesn't require changing it.

## Unblock task 49

This plan does not edit `tasks.json` — that file is not in this task's
owned files. Once this lands, removing task 53 from task 49's `blockedBy` is
a separate step for whoever runs `taskTools:update-tasks` or edits
`tasks.json` directly. Task 49 can then mint a `RunAuthorizationToken` via
`buildRunAuthorization`, get its publish targets via
`buildPublicationTargets`, and proceed to wire the actual
`runFinalizer`/`runConsolidation`/`operationPush`/`basePublication`/
`taskArchival` chain, which was the whole point of task 49 in the first place.
