# Task 92 Plan: Report the base-drift abort reason from mergePipeline

## Scope

Owned file: `scripts/mergePipeline.ts` only (249 lines as of this plan, version described
in the brief as `00365e92`). Confirmed the live file matches the brief's line references
exactly: `printResult` at line 158, the base-drift abort check at line 221, the
`if (aborted)` print path at line 248.

No other file is edited. The brief mentions a helper module `scripts/baseDrift.ts`
("already extracted during earlier drift work") as the natural home for a split — that
file does not exist in this repo (`ls scripts/` has no `baseDrift.ts`, and
`rg "computeDriftByGroup|probeMergeTreeConflicts|BaseDriftResult"` across `*.ts` returns
no matches). The brief's own instruction to split is conditional: "so split the file
rather than growing it past the cap" / "rather than letting the file grow past the cap."
The edits below are written by folding new statements onto existing lines (the file's
own established style — see current lines 159, 166/248, which already cram multiple
statements per line) so the **net line count change is zero**: the file stays at 249
lines, under the 250 cap. Because the file never grows past the cap, no split and no new
module is needed, and the task's `Files:` field (`scripts/mergePipeline.ts` only) is
honored without touching a second file.

## Design

1. Declare `abortReason` as a `let` immediately before the `runFinalization` call
   (current line 162→163 boundary), outside its callback — satisfies the hard
   requirement from finding 1 of the codex review (must be in scope at the later
   `if (aborted)` check on line 248).
2. `printResult` gains a second parameter, `abortReason: string | null = null`, and adds
   `abortReason` to the printed JSON object. It is a **parameter**, not a closure read of
   the outer `abortReason` variable — this matters because `printResult` is already
   called once at line 159, *before* the outer `let abortReason` declaration would exist
   (that declaration must sit immediately before `runFinalization`, per the hard
   requirement, which is textually after line 159). If `printResult`'s body read the
   outer variable directly, that first call would throw a TDZ `ReferenceError`. Using a
   defaulted parameter avoids this entirely: the two existing call sites (line 159, line
   245) need no edit at all, because the default `null` matches their existing behavior;
   only the new drift-aware call site (line 248) passes the variable explicitly.
3. The base-drift check (line 221) is the only `return true` inside the callback that
   gets a reason — this matches the task's exact scope ("Report the base-drift abort
   reason", brief line 1 title). The other early-return abort paths inside the callback
   (fold-merge conflict, consolidation abort, publication failure) are out of scope for
   this task and are left as `abortReason = null` (the default), which was already their
   effective behavior (an empty-conflicts, no-reason abort) — this task only fixes the
   drift case named in the brief.

## Edits to scripts/mergePipeline.ts

### Edit 1 — line 158 (`printResult` definition)

Current text (line 158, exact):
```
    const printResult = (publicationTargets: PublicationTargetSummary[]): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets })); };
```

New text:
```
    const printResult = (publicationTargets: PublicationTargetSummary[], abortReason: string | null = null): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets, abortReason })); };
```

Net line delta: 0 (1 line → 1 line, longer).

### Edit 2 — line 162 (declare `abortReason` immediately before the `runFinalization` call)

Current text (line 162, exact):
```
    const digest = computeApprovalDigest(runState.digestInput);
```

New text:
```
    const digest = computeApprovalDigest(runState.digestInput); let abortReason: string | null = null;
```

This puts the declaration on the line immediately preceding line 163
(`const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {`),
outside the callback, satisfying the hard requirement verbatim. `abortReason` is typed
`string | null` to match the existing `failureReason: string | null` pattern already used
in this file (`SubmoduleConflict`, `MergeOutcome`, line 57–58).

Net line delta: 0 (1 line → 1 line, longer).

### Edit 3 — line 221 (base-drift abort check, inside the `runFinalization` callback)

Current text (line 221, exact):
```
        for (const occurrence of manifest.occurrences) if (readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`) !== occurrence.baseOid) return true;
```

New text:
```
        for (const occurrence of manifest.occurrences) { const liveOid = readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`); if (liveOid !== occurrence.baseOid) { abortReason = `the source branch moved past the pinned baseOid (pinned ${occurrence.baseOid}, now ${liveOid})`; return true; } }
```
(one `{` opens the `for` body, one `{` opens the `if` body, two matching `}` close them —
ends in `return true; } }`.)

Only assignment to `abortReason` here (no re-declaration) — inside the callback, per the
hard requirement. `liveOid` is a new local `const` scoped to the loop iteration; it
replaces the previous inline `readCurrentRefOid(...)` call so its value can be reused in
both the comparison and the message. `readCurrentRefOid` and `occurrence.baseOid` are
used exactly as before (same call, same comparison target) — no new type assumptions.

Net line delta: 0 (1 line → 1 line, longer).

### Edit 4 — line 248 (`if (aborted)` print path)

Current text (line 248, exact):
```
    if (aborted) { endMetrics(conflicts.length + 1); printResult([]); }
```

New text:
```
    if (aborted) { endMetrics(conflicts.length + 1); printResult([], abortReason); }
```

`abortReason` here is in scope because of Edit 2 (declared at line 162, outside the
`runFinalization` callback, `let`-scoped to the rest of the function including line 248).

Net line delta: 0 (1 line → 1 line, longer).

## Lines NOT edited (and why)

- Line 159 (`if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }`):
  unchanged. `printResult([])` still compiles because `abortReason` is now an optional
  parameter with default `null` (Edit 1) — this early "not ready for approval" path is a
  different run state (blocked, never reached `runFinalization`) and correctly reports no
  abort reason.
- Line 245 (`printResult(summaryTargets);`, inside the callback's success path): unchanged
  for the same reason — a successful run has no abort reason, and the default parameter
  supplies `null`.
- All other `return true;` sites inside the `runFinalization` callback (fold-merge
  conflict, `"aborted" in result`, publication failure): unchanged. Out of scope per the
  brief's title and requirement 2, which name the base-drift case specifically.

## Total file size after edits

249 lines before, 249 lines after (each edit replaces one line with one longer line, no
edit adds or removes a line). Under the 250-line cap — no split, no new file.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. Line count unchanged and under cap:
   ```
   wc -l scripts/mergePipeline.ts
   ```
   Expected: `249 scripts/mergePipeline.ts`.

2. TypeScript compiles (proves `abortReason` is in scope at the `if (aborted)` check and
   no type errors were introduced):
   ```
   bunx tsc --noEmit -p tsconfig.json
   ```
   Expected: exits 0, no output naming `scripts/mergePipeline.ts`.

3. All four edits landed, and only those five `abortReason` occurrences exist (`grep -c`
   counts matching *lines*, not occurrences — since all five sites are each on their own
   line except line 158 which has two, use `grep -o` to count occurrences instead):
   ```
   grep -o "abortReason" scripts/mergePipeline.ts | wc -l
   ```
   Expected: `5` (2 on line 158's `printResult` signature/JSON, 1 on line 162's
   declaration, 1 on line 221's assignment, 1 on line 248's call).

4. The declaration sits immediately before the `runFinalization` call, outside the
   callback:
   ```
   sed -n '162,163p' scripts/mergePipeline.ts
   ```
   Expected:
   ```
       const digest = computeApprovalDigest(runState.digestInput); let abortReason: string | null = null;
       const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {
   ```

5. The drift-specific message text exists exactly once, at the base-drift check:
   ```
   grep -n "the source branch moved past the pinned baseOid" scripts/mergePipeline.ts
   ```
   Expected: exactly one match, on line 221.

6. The two untouched call sites still compile against the new optional parameter (covered
   by check 2, but confirm no edits were made to them):
   ```
   sed -n '159p;245p' scripts/mergePipeline.ts
   ```
   Expected (unchanged from before the edits):
   ```
       if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }
           printResult(summaryTargets);
   ```

## Out of scope: proving the runtime behavior

Checks 1-6 above prove the edits compile, are textually correct, and are scoped to the
right lines — they do not prove that a real drifted run prints a non-empty, drift-specific
`abortReason` containing both the pinned and live OIDs. Proving that requires driving
`runMergePipeline` end-to-end with a repository manifest whose source branch has moved past
its pinned `baseOid`, capturing stdout, and asserting on the printed JSON. That is a
persistent executable regression test, and this task's sole owned file is
`scripts/mergePipeline.ts` — no test file may be added or edited here. That proof belongs to
task 90 (`tests/runMergePhase.test.ts`, the end-to-end merge-pipeline tests), which must add
a case that: constructs a repository manifest with a `baseOid` that no longer matches the
live ref, runs the pipeline through to the `if (aborted)` print path, and asserts the printed
`abortReason` is non-null and contains both the pinned and live OIDs. This plan does not
claim checks 1-6 substitute for that coverage.
