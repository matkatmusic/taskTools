# Amended Task 13: Base and recorded-OID reconciliation gate

This amendment replaces the incompatible interface assumptions in
`plans/task-13-plan.md`. Task 13 is no longer a new-module-only task: the
existing resolution-request module must be extended because its Phase 1
contract cannot represent a logical-repository question or a structured
base/OID answer.

## Confirmed Phase 1 contract

`scripts/resolutionRequests.ts` currently provides:

- request IDs keyed by `(occurrenceId, reason)`;
- one request shape containing `occurrenceId`, `recordedOid`, and
  `candidateBaseBranches`;
- `ResolutionManifest.resolutionAnswers` typed as `Record<string, string>`;
- answer validation that only accepts one of `candidateBaseBranches`.

Do not encode a reconciliation choice as JSON inside a string, substitute a
logical repository ID into `occurrenceId`, or serialize member records into
`candidateBaseBranches`. Those approaches retain the old field names while
changing their meanings and do not provide type-safe atomic selection of an
OID/base pair.

## Amended scope

Files changed by this task:

- `scripts/resolutionRequests.ts`
- `tests/resolutionRequests.test.ts`
- `scripts/baseReconciliation.ts`
- `tests/baseReconciliation.test.ts`
- existing direct consumers of `resolutionAnswers`, but only if required to
  replace an untyped map read with a typed accessor

There are still no production call sites for the reconciliation gate in this
task.

## Resolution-request extension

Keep the existing branch-selection request and string-answer behavior
backward-compatible. Add a second, discriminated request family for base
reconciliation:

```ts
export const REASON_BASE_RECONCILIATION = "base-reconciliation";

export interface ReconciliationMember {
    occurrenceId: string;
    recordedOid: string;
    baseBranch: string;
}

export interface BaseReconciliationChoice {
    recordedOid: string;
    baseBranch: string;
}

export interface BaseReconciliationRequest {
    kind: "base-reconciliation";
    id: string;
    logicalRepositoryId: string;
    reason: typeof REASON_BASE_RECONCILIATION;
    members: ReconciliationMember[];
}
```

The manifest must be able to persist both the legacy requests/answers and the
new request/answer. A suitable shape is:

```ts
export type PersistedResolutionRequest =
    | ResolutionRequest
    | BaseReconciliationRequest;

export type PersistedResolutionAnswer =
    | string
    | BaseReconciliationChoice;

export interface ResolutionManifest {
    resolutionRequests: PersistedResolutionRequest[];
    resolutionAnswers: Record<string, PersistedResolutionAnswer>;
}
```

If widening `resolutionAnswers` makes an existing direct read ambiguous, add
and use a typed string-answer accessor. Do not scatter casts through existing
consumers.

Generalize the parameter name of `createResolutionRequestId` from
`occurrenceId` to `subjectId` without changing its hash input format or output.
Existing request IDs must remain byte-identical. A reconciliation request uses:

```ts
createResolutionRequestId(
    logicalRepositoryId,
    REASON_BASE_RECONCILIATION,
)
```

Add typed operations, with names adjusted only if the module has an established
naming convention:

```ts
createBaseReconciliationRequest(logicalRepositoryId, members)
getBaseReconciliationAnswer(manifest, requestId)
applyBaseReconciliationAnswers(manifest, answers)
```

`applyBaseReconciliationAnswers` must reject an answer unless its complete
`{ recordedOid, baseBranch }` pair occurs in at least one member record. It
must persist the pair atomically. Recording the same unanswered request again
must not duplicate it. If membership can change before an answer is recorded,
refresh the existing request payload under its stable ID so the operator never
sees a stale member list. Once answered, the persisted choice remains
authoritative on resume.

Existing `applyResolutionAnswers(...Record<string, string>)` behavior remains
the branch/string-answer path and must reject a reconciliation request rather
than treating it as a branch request.

## Base-reconciliation API

The manifest is an explicit input. The original proposed signature omitted it
even though the function must both read and record persisted state.

```ts
export interface RepositoryOccurrence {
    occurrenceId: string;
    recordedOid: string;
    baseBranch: string;
}

export type BaseReconciliationOutcome =
    | {
          status: "resolved";
          recordedOid: string;
          baseBranch: string;
      }
    | {
          status: "blocked";
          logicalRepositoryId: string;
          requestId: string;
      };

export function checkBaseReconciliation(
    logicalRepositoryId: string,
    occurrences: RepositoryOccurrence[],
    manifest: ResolutionManifest,
): BaseReconciliationOutcome;

export function assertBaseReconciled(
    outcome: BaseReconciliationOutcome,
): asserts outcome is Extract<
    BaseReconciliationOutcome,
    { status: "resolved" }
>;
```

Require at least one occurrence; an empty logical repository is invalid input.
Normalize member order before persisting so request serialization is
deterministic.

`checkBaseReconciliation` executes in this order:

1. Derive the stable reconciliation request ID from the logical repository ID.
2. If a typed persisted answer exists, return it without comparing the raw
   occurrences or emitting another request.
3. If every occurrence has the same OID and base branch, return that pair and
   emit no request.
4. Otherwise create or refresh one reconciliation request containing every
   member and return `blocked` with its request ID.

`assertBaseReconciled` throws for a blocked outcome and names both the logical
repository and request ID in the error.

## Tests

Retain the seven behavioral tests from the original Task 13 plan, amended to
pass a `ResolutionManifest`. Add these contract tests:

1. The reconciliation request ID is stable and keyed to the logical repository,
   not to whichever occurrence happens to be first.
2. The persisted request contains every member's occurrence ID, OID, and base.
3. A valid structured answer survives a JSON round trip and resolves on resume.
4. An OID from one member combined with a base from a different member is
   rejected when that exact pair was never recorded.
5. Re-recording an unanswered request does not duplicate it and refreshes a
   changed member list deterministically.
6. Existing string-answer creation, validation, persistence, ID stability, and
   JSON round-trip tests remain green.
7. A reconciliation request passed to the legacy string-answer function is
   rejected explicitly.

## Order of work

1. Add failing compatibility and structured-reconciliation tests to
   `tests/resolutionRequests.test.ts`.
2. Extend `scripts/resolutionRequests.ts` while preserving existing IDs and
   string-answer behavior.
3. Update only the existing direct answer reads that require typed accessors.
4. Add the amended `baseReconciliation` tests.
5. Implement the gate using only the new typed resolution-request operations.
6. Run the focused tests, then the complete repository test suite.

## Out of scope

- Logical-repository discovery or grouping.
- Wiring the gate into synchronization, branch creation, or worker execution.
- A second manifest or persistence layer.
- String-encoding structured reconciliation data.

