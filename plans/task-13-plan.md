# Task 13 Plan: Base and recorded-OID reconciliation gate for repeated repositories

Supersedes the previous version of this file (which planned `baseReconciliation.ts` alone,
against a `resolutionRequests.ts` assumed unchanged). brief-13.md is now marked AMENDED: it
requires extending `scripts/resolutionRequests.ts` first, and its own prose plus the shown
current file contents are detailed enough to plan from directly — that prose is treated as
the spec of record below.

Non-goals confirmed by the brief: no production call sites wired up in this task, and no
new "Occurrence" domain type — `checkBaseReconciliation`'s `occurrences` parameter is typed
directly as `BaseReconciliationMember[]` (defined below) since nothing consumes it yet.

## Order of work (strict TDD: failing test, then minimum code, per increment)

### Increment 0 — widen shared types (prerequisite, no behavior change yet)

File: `scripts/resolutionRequests.ts`

Add, without touching any existing export's behavior:

```ts
export const REASON_BASE_RECONCILIATION: ResolutionReason = "base-reconciliation";

export interface BaseReconciliationMember {
    occurrenceId: string;
    recordedOid: string;
    baseBranch: string;
}

export interface BaseReconciliationChoice {
    recordedOid: string;
    baseBranch: string;
}

export interface BaseReconciliationRequest {
    id: string;
    logicalRepositoryId: string;
    members: BaseReconciliationMember[];
    reason: ResolutionReason;
}
```

Widen the manifest (existing two fields untouched, two fields added):

```ts
export interface ResolutionManifest {
    resolutionRequests: ResolutionRequest[];
    resolutionAnswers: Record<string, string>;
    baseReconciliationRequests: BaseReconciliationRequest[];
    baseReconciliationAnswers: Record<string, BaseReconciliationChoice>;
}
```

Update `createEmptyResolutionManifest` to initialize both new fields to empty. This alone
must keep all 7 existing tests in `tests/resolutionRequests.test.ts` green — run them now
before adding anything else, to confirm the widening is behavior-neutral.

Generalize the id function's parameter name only (body/output byte-identical):

```ts
export function createResolutionRequestId(subjectId: string, reason: ResolutionReason): string {
    const hash = createHash("sha256").update(`${subjectId}::${reason}`).digest("hex");
    return `rr_${hash.slice(0, 16)}`;
}
```

`createResolutionRequest` keeps its own `occurrenceId` parameter name (it is still
occurrence-scoped) and simply passes that value as the first argument to
`createResolutionRequestId` — no call-site behavior changes.

### Increment 1 — `createBaseReconciliationRequest` + `recordBaseReconciliationRequest`

Test first, in `tests/resolutionRequests.test.ts`:

```ts
// Same generalized id function as occurrence-scoped requests — proves the id is stable, not a second id scheme.
test("createResolutionRequestId is stable when keyed by a logical repository id", () => {
    const idBefore = createResolutionRequestId("repo-e", REASON_BASE_RECONCILIATION);
    const idAfter = createResolutionRequestId("repo-e", REASON_BASE_RECONCILIATION);
    assert.equal(idBefore, idAfter);
    const request = createBaseReconciliationRequest("repo-e", []);
    assert.equal(request.id, idBefore);
});

// Every member's full {occurrenceId, recordedOid, baseBranch} record must be retrievable from the manifest — nothing gets collapsed into a string or a subset of fields.
test("recordBaseReconciliationRequest persists the full member payload", () => {
    const manifest = createEmptyResolutionManifest();
    const members = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const request = createBaseReconciliationRequest("repo-f", members);
    recordBaseReconciliationRequest(manifest, request);
    assert.deepEqual(manifest.baseReconciliationRequests[0].members, members);
});

// A later discovery pass that changes the occurrence set for the same logical repository must not create a second request — it must overwrite the one entry, keyed by the same id.
test("recordBaseReconciliationRequest refreshes a changed member list under the stable id", () => {
    const manifest = createEmptyResolutionManifest();
    const firstMembers = [{ occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" }];
    recordBaseReconciliationRequest(manifest, createBaseReconciliationRequest("repo-c", firstMembers));
    const secondMembers = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "abc123", baseBranch: "feature-x" },
    ];
    recordBaseReconciliationRequest(manifest, createBaseReconciliationRequest("repo-c", secondMembers));
    assert.equal(manifest.baseReconciliationRequests.length, 1);
    assert.deepEqual(manifest.baseReconciliationRequests[0].members, secondMembers);
});
```

Minimum implementation in `scripts/resolutionRequests.ts`:

```ts
export function createBaseReconciliationRequest(
    logicalRepositoryId: string,
    members: BaseReconciliationMember[]
): BaseReconciliationRequest {
    return {
        id: createResolutionRequestId(logicalRepositoryId, REASON_BASE_RECONCILIATION),
        logicalRepositoryId,
        members,
        reason: REASON_BASE_RECONCILIATION,
    };
}

export function recordBaseReconciliationRequest(
    manifest: ResolutionManifest,
    request: BaseReconciliationRequest
): void {
    const existingIndex = manifest.baseReconciliationRequests.findIndex(
        (existing) => existing.id === request.id
    );
    if (existingIndex === -1) {
        manifest.baseReconciliationRequests.push(request);
        return;
    }
    manifest.baseReconciliationRequests[existingIndex] = request;
}
```

Overwrite-by-id (rather than "skip if id exists", which is how the legacy
`recordResolutionRequest` behaves) is the one deliberate divergence from the legacy
function's idempotency pattern — it's what makes "refresh changed members under a stable
id" and "never duplicate" the same code path instead of two.

### Increment 2 — `applyBaseReconciliationAnswers`

Test first:

```ts
// A structured answer round-trips through JSON as a single {recordedOid, baseBranch}
// value, not two separately-keyed fields that could desync.
test("applyBaseReconciliationAnswers answer survives a JSON round trip", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createBaseReconciliationRequest("repo-a", [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ]);
    recordBaseReconciliationRequest(manifest, request);
    applyBaseReconciliationAnswers(manifest, { [request.id]: { recordedOid: "abc123", baseBranch: "main" } });
    const roundTripped: ResolutionManifest = JSON.parse(JSON.stringify(manifest));
    assert.deepEqual(roundTripped.baseReconciliationAnswers[request.id], { recordedOid: "abc123", baseBranch: "main" });
});

// An answer that mixes one member's recordedOid with a DIFFERENT member's baseBranch was never recorded together on any single occurrence — validating the two fields independently would wrongly accept this, so it must be rejected as one unit.
test("applyBaseReconciliationAnswers rejects a cross-member OID/base pair", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createBaseReconciliationRequest("repo-b", [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ]);
    recordBaseReconciliationRequest(manifest, request);
    const crossedPair = { recordedOid: "abc123", baseBranch: "develop" };
    assert.throws(() => applyBaseReconciliationAnswers(manifest, { [request.id]: crossedPair }));
    assert.equal(manifest.baseReconciliationAnswers[request.id], undefined);
});
```

Minimum implementation:

```ts
export function hasBaseReconciliationAnswer(manifest: ResolutionManifest, requestId: string): boolean {
    return Object.prototype.hasOwnProperty.call(manifest.baseReconciliationAnswers, requestId);
}

export function applyBaseReconciliationAnswers(
    manifest: ResolutionManifest,
    answers: Record<string, BaseReconciliationChoice>
): void {
    for (const [requestId, choice] of Object.entries(answers)) {
        const request = manifest.baseReconciliationRequests.find((candidate) => candidate.id === requestId);
        if (!request) {
            throw new Error(`No base reconciliation request found with id "${requestId}"`);
        }
        const matchesRecordedMember = request.members.some(
            (member) => member.recordedOid === choice.recordedOid && member.baseBranch === choice.baseBranch
        );
        if (!matchesRecordedMember) {
            throw new Error(
                `{recordedOid: "${choice.recordedOid}", baseBranch: "${choice.baseBranch}"} does not match any member of request "${requestId}"`
            );
        }
        manifest.baseReconciliationAnswers[requestId] = { recordedOid: choice.recordedOid, baseBranch: choice.baseBranch };
    }
}
```

The `{recordedOid, baseBranch}` object is assigned in one statement — never build it via two
separate field mutations — so "persists it atomically" holds even mid-loop if a later
entry in the same `answers` batch throws.

### Increment 3 — legacy function rejects reconciliation ids explicitly

Test first:

```ts
// Legacy string-answer function must reject a reconciliation id by name, not the generic not-found error.
test("applyResolutionAnswers explicitly rejects a base-reconciliation request id", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createBaseReconciliationRequest("repo-d", [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
    ]);
    recordBaseReconciliationRequest(manifest, request);
    assert.throws(
        () => applyResolutionAnswers(manifest, { [request.id]: "main" }),
        /base-reconciliation/
    );
});
```

Minimum implementation — add one guard at the top of the existing loop body in
`applyResolutionAnswers`, before its existing `manifest.resolutionRequests.find(...)` lookup:

```ts
const isReconciliationRequest = manifest.baseReconciliationRequests.some(
    (candidate) => candidate.id === requestId
);
if (isReconciliationRequest) {
    throw new Error(
        `Request "${requestId}" is a base-reconciliation request; use applyBaseReconciliationAnswers instead of applyResolutionAnswers`
    );
}
```

Everything below that guard in the existing function body is untouched. Re-run the 7
original tests plus this one — all 8 plus the 4 new tests from increments 1–2 must pass
(13 tests total in `tests/resolutionRequests.test.ts`).

### Increment 4 — `scripts/baseReconciliation.ts` (new file)

Test first, in a new `tests/baseReconciliation.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmptyResolutionManifest, applyBaseReconciliationAnswers, createBaseReconciliationRequest, recordBaseReconciliationRequest } from "../scripts/resolutionRequests.ts";
import { checkBaseReconciliation, assertBaseReconciled } from "../scripts/baseReconciliation.ts";

// Zero occurrences is a caller bug, not a reconciliation question — fail loudly.
test("checkBaseReconciliation throws when given zero occurrences", () => {
    const manifest = createEmptyResolutionManifest();
    assert.throws(() => checkBaseReconciliation("repo-g", [], manifest));
});

// A persisted typed answer wins even when the occurrences it was recorded against would otherwise disagree — the manifest answer is the source of truth once it exists.
test("checkBaseReconciliation resolves from a persisted answer over disagreeing occurrences", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const request = createBaseReconciliationRequest("repo-h", occurrences);
    recordBaseReconciliationRequest(manifest, request);
    applyBaseReconciliationAnswers(manifest, { [request.id]: { recordedOid: "abc123", baseBranch: "main" } });
    const result = checkBaseReconciliation("repo-h", occurrences, manifest);
    assert.deepEqual(result, { status: "resolved", recordedOid: "abc123", baseBranch: "main" });
});

// All occurrences already agree — resolve without ever creating a resolution request.
test("checkBaseReconciliation resolves when occurrences are unanimous", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "abc123", baseBranch: "main" },
    ];
    const result = checkBaseReconciliation("repo-i", occurrences, manifest);
    assert.deepEqual(result, { status: "resolved", recordedOid: "abc123", baseBranch: "main" });
    assert.equal(manifest.baseReconciliationRequests.length, 0);
});

// Disagreeing occurrences with no persisted answer block, and exactly one request is recorded carrying every occurrence's full payload.
test("checkBaseReconciliation blocks and records one request when occurrences disagree", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const result = checkBaseReconciliation("repo-j", occurrences, manifest);
    assert.equal(result.status, "blocked");
    assert.equal(manifest.baseReconciliationRequests.length, 1);
    assert.deepEqual(manifest.baseReconciliationRequests[0].members, occurrences);
});

// Same occurrence set, different input order — the persisted member order must be identical both times, so re-derivation on a resumed run is deterministic.
test("checkBaseReconciliation normalizes member order before persisting", () => {
    const manifestA = createEmptyResolutionManifest();
    const manifestB = createEmptyResolutionManifest();
    const forward = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const reversed = [...forward].reverse();
    checkBaseReconciliation("repo-k", forward, manifestA);
    checkBaseReconciliation("repo-k", reversed, manifestB);
    assert.deepEqual(manifestA.baseReconciliationRequests[0].members, manifestB.baseReconciliationRequests[0].members);
});

// assertBaseReconciled narrows the union away on the resolved path: callers get the plain {recordedOid, baseBranch} pair, no status field to check.
test("assertBaseReconciled returns the resolved pair directly", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [{ occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" }];
    const choice = assertBaseReconciled("repo-l", occurrences, manifest);
    assert.deepEqual(choice, { recordedOid: "abc123", baseBranch: "main" });
});

// On the blocked path assertBaseReconciled throws, and the thrown message names BOTH the logical repository id and the request id — so a caller reading the error knows which repository is blocked and which request answers it.
test("assertBaseReconciled throws naming both the logical repository id and the request id", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    assert.throws(() => assertBaseReconciled("repo-m", occurrences, manifest), (error: Error) => {
        assert.match(error.message, /repo-m/);
        const requestId = createBaseReconciliationRequest("repo-m", occurrences).id;
        assert.match(error.message, new RegExp(requestId));
        return true;
    });
});
```

Minimum implementation, `scripts/baseReconciliation.ts`:

```ts
// baseReconciliation.ts: base/recorded-OID reconciliation gate for repeated repositories.
import {
    ResolutionManifest,
    BaseReconciliationMember,
    BaseReconciliationChoice,
    createBaseReconciliationRequest,
    recordBaseReconciliationRequest,
} from "./resolutionRequests.ts";

export type BaseReconciliationResult =
    | ({ status: "resolved" } & BaseReconciliationChoice)
    | { status: "blocked"; logicalRepositoryId: string; requestId: string };

function normalizeMemberOrder(members: BaseReconciliationMember[]): BaseReconciliationMember[] {
    return [...members].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
}

function findUnanimousChoice(members: BaseReconciliationMember[]): BaseReconciliationChoice | undefined {
    const [first, ...rest] = members;
    const allAgree = rest.every(
        (member) => member.recordedOid === first.recordedOid && member.baseBranch === first.baseBranch
    );
    if (!allAgree) {
        return undefined;
    }
    return { recordedOid: first.recordedOid, baseBranch: first.baseBranch };
}

export function checkBaseReconciliation(
    logicalRepositoryId: string,
    occurrences: BaseReconciliationMember[],
    manifest: ResolutionManifest
): BaseReconciliationResult {
    if (occurrences.length === 0) {
        throw new Error(
            `checkBaseReconciliation requires at least one occurrence for logical repository "${logicalRepositoryId}"`
        );
    }

    const normalizedMembers = normalizeMemberOrder(occurrences);
    const request = createBaseReconciliationRequest(logicalRepositoryId, normalizedMembers);

    const persistedAnswer = manifest.baseReconciliationAnswers[request.id];
    if (persistedAnswer) {
        return { status: "resolved", recordedOid: persistedAnswer.recordedOid, baseBranch: persistedAnswer.baseBranch };
    }

    const unanimousChoice = findUnanimousChoice(normalizedMembers);
    if (unanimousChoice) {
        return { status: "resolved", recordedOid: unanimousChoice.recordedOid, baseBranch: unanimousChoice.baseBranch };
    }

    recordBaseReconciliationRequest(manifest, request);
    return { status: "blocked", logicalRepositoryId, requestId: request.id };
}

export function assertBaseReconciled(
    logicalRepositoryId: string,
    occurrences: BaseReconciliationMember[],
    manifest: ResolutionManifest
): BaseReconciliationChoice {
    const result = checkBaseReconciliation(logicalRepositoryId, occurrences, manifest);
    if (result.status === "blocked") {
        throw new Error(
            `Base reconciliation blocked for logical repository "${result.logicalRepositoryId}": awaiting answer to request "${result.requestId}"`
        );
    }
    return { recordedOid: result.recordedOid, baseBranch: result.baseBranch };
}
```

Order inside `checkBaseReconciliation` (persisted answer, then unanimity, then
create/refresh-and-block) is checked with single-condition nested `if`s per
`single-condition-branching.md` — no `&&`/`||` compound guards.

`checkBaseReconciliation` never mutates the manifest on either resolved path — only the
blocked path calls `recordBaseReconciliationRequest` — which is what makes "does not
duplicate an unanswered request" true for free: resolved runs simply never touch the
requests array.

No production call sites, no synchronization/worker-edit/branch-creation code, and no
"assert then run" convenience wrapper belong in this task — a caller does
`assertBaseReconciled(...); doTheEdit();` and the throw already prevents `doTheEdit()` from
running; add a wrapper only once a real call site in a later task shows repeated
boilerplate around it.

## File-size check

`scripts/resolutionRequests.ts` grows from ~97 to roughly ~165 lines; `scripts/baseReconciliation.ts`
is a new file at roughly ~65 lines. Both stay well under the 250-line cap — no split needed.

## Verification

Run the two test files the way the existing test file is already written to run (bare
`node:test`/`node:assert` imports, `.ts` extensions on relative imports):

```
bun test tests/resolutionRequests.test.ts tests/baseReconciliation.test.ts
```

All 13 tests in `tests/resolutionRequests.test.ts` (7 original + 6 new) and all 7 tests in
`tests/baseReconciliation.test.ts` must pass. No other test file should be affected — this
task adds no production call sites, so nothing outside these two files imports either
module yet.
