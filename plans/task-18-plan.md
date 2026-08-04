# Task 18 Plan: Per-occurrence test policy with related-test map and complete-suite command

Brief: `plans/brief-18.md`. Phase 2 of the recursive repository-discovery redesign
(`plans/codex-tackle-tasks-repo-discovery-phase-2.md`).

Scope: add exactly two new files — `scripts/testPolicy.ts` and
`tests/testPolicy.test.ts`. Do not edit any existing file. No call site wires
this into `repositoryDiscovery.ts` or the run manifest yet — that is later
work.

## Behavior, in plain English

For one occurrence (an `occurrenceId` plus its `checkoutPath` on disk), decide
two commands:
- **complete suite command** — runs the whole test suite for that occurrence;
  used to validate a parent chain.
- **related test command** — runs a narrower, faster set of tests scoped to
  edited files; used for ordinary edits.

The commands are discovered by reading `package.json`'s `scripts` object at
`checkoutPath`, using two fixed naming conventions (no guessing beyond these):
- `"test"` is the one and only recognized complete-suite script name (the
  universal npm/bun/yarn entry point — there is never more than one script
  named exactly `"test"`, so this half of discovery can never be ambiguous,
  only present or absent).
- `"test:related"`, `"test:changed"`, `"test:affected"` are the recognized
  related-test script names. Zero or one of these present is fine; more than
  one present is a genuine ambiguity (nothing tells us which one is "the"
  related-test command), so a resolution request must be raised instead of
  picking one.

Decision order for one occurrence:
1. No `"test"` script found (`package.json` missing, unreadable, no `scripts`
   object, or `scripts` lacks a `"test"` key) → blocking: emit a
   `REASON_NO_TEST_CONFIGURATION` resolution request. This must be checked
   before the ambiguity check below, because a missing complete-suite command
   blocks the policy regardless of how many related-test candidates exist.
2. More than one related-test candidate key present → blocking: emit a
   `REASON_AMBIGUOUS_RELATED_TEST_COMMAND` resolution request carrying the
   matched candidate keys (in the fixed candidate-list order below, not
   `package.json` key order, so the result is deterministic).
3. Otherwise resolved: `completeSuiteCommand` = the `"test"` script run
   command; `relatedTestCommand` = the one matched related-test script's run
   command, or — if none matched — the same command as `completeSuiteCommand`
   (falling back to running the whole suite for related-test purposes is not
   "guessing among candidates", it is simply accepting there is no
   finer-grained runner).

A "run command" string for a script key is literally `` `npm run ${key}` ``.
Do not special-case bun/yarn — pick this one convention and document it as a
`ponytail:` comment (`ponytail: npm run always resolves via a repo's chosen
package manager, no need to detect one`).

Persisted answers: this reuses `scripts/resolutionRequests.ts` unmodified —
do not edit that file. `discoverTestPolicy` takes a `ResolutionManifest` and,
before creating a new request, computes the request id with
`createResolutionRequestId(occurrenceId, reason)` and checks
`hasResolutionAnswer`. If already answered, build the resolved `TestPolicy`
straight from `resolutionManifest.resolutionAnswers[requestId]` instead of
creating a request:
- For `REASON_AMBIGUOUS_RELATED_TEST_COMMAND`, the stored answer is the
  chosen related-test script key; `relatedTestCommand` = run command for that
  key, `completeSuiteCommand` = run command for `"test"` (already known
  present, since this reason is only reached after step 1 passes).
- For `REASON_NO_TEST_CONFIGURATION`, the stored answer is a raw shell command
  string supplied by whoever resolved the request; use it directly for both
  `relatedTestCommand` and `completeSuiteCommand`.

Do not call `applyResolutionAnswers` from `testPolicy.ts` for either reason:
that helper validates the answer is a member of `candidateBaseBranches`, which
holds `[]` for `REASON_NO_TEST_CONFIGURATION` (no candidate list exists to
validate a free-form command against). Tests and any future caller write the
answer directly into `resolutionManifest.resolutionAnswers[requestId]`, the
same plain `Record<string, string>` `applyResolutionAnswers` itself writes
into — this is not a workaround, it is using the existing open dictionary
shape directly for a case its validating wrapper doesn't cover.

"Missing/unresolved policy blocks the occurrence" is expressed structurally,
the same way `repositoryDiscovery.ts` already blocks on
`needsResolution`: `discoverTestPolicy` returns a `status` union, never a
placeholder/default policy. There is nothing else to implement for
"blocking" — no caller exists yet to add blocking logic to.

## `scripts/testPolicy.ts`

```ts
// testPolicy.ts: per-occurrence test policy (related-test command, complete-suite command), discovered from package.json scripts or resolved via a persisted answer.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    createResolutionRequest,
    createResolutionRequestId,
    hasResolutionAnswer,
    recordResolutionRequest,
} from "./resolutionRequests.ts";
import type { ResolutionManifest, ResolutionRequest } from "./resolutionRequests.ts";

export const REASON_NO_TEST_CONFIGURATION = "no-test-configuration";
export const REASON_AMBIGUOUS_RELATED_TEST_COMMAND = "ambiguous-related-test-command";

const COMPLETE_SUITE_SCRIPT_KEY = "test";
const RELATED_TEST_SCRIPT_KEY_CANDIDATES = ["test:related", "test:changed", "test:affected"];

export type TestPolicy = {
    occurrenceId: string;
    relatedTestCommand: string;
    completeSuiteCommand: string;
};

export type TestPolicyResult =
    | { status: "resolved"; policy: TestPolicy }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };

function readPackageScripts(checkoutPath: string): Record<string, unknown> | null {
    const packageJsonPath = join(checkoutPath, "package.json");
    if (!existsSync(packageJsonPath)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return null;
    return scripts as Record<string, unknown>;
}

// ponytail: npm run always resolves via a repo's chosen package manager, no need to detect one.
function runScriptCommand(scriptKey: string): string {
    return `npm run ${scriptKey}`;
}

function resolveWithAnswerOrRequest(
    occurrenceId: string,
    candidateScriptKeys: string[],
    reason: string,
    resolutionManifest: ResolutionManifest,
    buildPolicyFromAnswer: (answer: string) => TestPolicy
): TestPolicyResult {
    const requestId = createResolutionRequestId(occurrenceId, reason);
    if (hasResolutionAnswer(resolutionManifest, requestId)) {
        return { status: "resolved", policy: buildPolicyFromAnswer(resolutionManifest.resolutionAnswers[requestId]) };
    }
    const request = createResolutionRequest(occurrenceId, "", candidateScriptKeys, reason);
    recordResolutionRequest(resolutionManifest, request);
    return { status: "needsResolution", resolutionRequests: [request] };
}

export function discoverTestPolicy(
    occurrenceId: string,
    checkoutPath: string,
    resolutionManifest: ResolutionManifest
): TestPolicyResult {
    const scripts = readPackageScripts(checkoutPath);
    const hasCompleteSuite = scripts !== null && COMPLETE_SUITE_SCRIPT_KEY in scripts;
    if (!hasCompleteSuite) {
        return resolveWithAnswerOrRequest(occurrenceId, [], REASON_NO_TEST_CONFIGURATION, resolutionManifest, (answer) => ({
            occurrenceId,
            relatedTestCommand: answer,
            completeSuiteCommand: answer,
        }));
    }

    const relatedCandidates = RELATED_TEST_SCRIPT_KEY_CANDIDATES.filter((key) => key in scripts);
    if (relatedCandidates.length > 1) {
        return resolveWithAnswerOrRequest(
            occurrenceId,
            relatedCandidates,
            REASON_AMBIGUOUS_RELATED_TEST_COMMAND,
            resolutionManifest,
            (answer) => ({
                occurrenceId,
                relatedTestCommand: runScriptCommand(answer),
                completeSuiteCommand: runScriptCommand(COMPLETE_SUITE_SCRIPT_KEY),
            })
        );
    }

    const completeSuiteCommand = runScriptCommand(COMPLETE_SUITE_SCRIPT_KEY);
    const relatedTestCommand = relatedCandidates.length === 1 ? runScriptCommand(relatedCandidates[0]) : completeSuiteCommand;
    return { status: "resolved", policy: { occurrenceId, relatedTestCommand, completeSuiteCommand } };
}
```

This is ~85 lines, well under the 250-line file cap; no splitting needed.

Naming check against `~/.claude/guides/coding-standards.md`: every function name is a verb phrase
describing what it does (`readPackageScripts`, `runScriptCommand`,
`resolveWithAnswerOrRequest`, `discoverTestPolicy`), matching the
`discoverRepositoryTree` / `resolveBaseBranchCandidates` naming already used
in this codebase for the same kind of discover-or-request function.

## `tests/testPolicy.test.ts`

Follow `tests/baseBranchResolution.test.ts`'s fixture style: `node:test`,
`node:assert/strict`, `mkdtempSync`/`rmSync` under `os.tmpdir()`, a
`withTempDir` wrapper, no git repo needed (this module only reads
`package.json`, not git state).

Write these tests first (RED), in this order, then implement
`testPolicy.ts` function-by-function until each goes green:

1. `test_missingPackageJsonProducesResolutionRequest` — empty temp dir, no
   `package.json`. `discoverTestPolicy` → `status: "needsResolution"`, one
   request with `reason: REASON_NO_TEST_CONFIGURATION`, `candidateBaseBranches: []`.
2. `test_packageJsonWithoutTestScriptProducesResolutionRequest` — write
   `package.json` with `scripts: { build: "tsc" }` (no `"test"` key). Same
   assertion as test 1.
3. `test_unambiguousTestScriptIsDiscoveredAndRecorded` — write `package.json`
   with `scripts: { test: "vitest run" }` only. `discoverTestPolicy` →
   `status: "resolved"`, `policy.occurrenceId` equals the passed-in id,
   `policy.completeSuiteCommand === "npm run test"`, and
   `policy.relatedTestCommand === policy.completeSuiteCommand` (no
   related-specific script exists, so it falls back to the suite command).
4. `test_unambiguousRelatedScriptIsRecordedSeparatelyFromCompleteSuite` —
   `scripts: { test: "vitest run", "test:related": "vitest related" }`.
   Resolved policy has `completeSuiteCommand === "npm run test"` and
   `relatedTestCommand === "npm run test:related"` (the two differ).
5. `test_twoEquallyPlausibleRelatedCandidatesProduceResolutionRequest` —
   `scripts: { test: "x", "test:related": "a", "test:changed": "b" }`.
   `discoverTestPolicy` → `status: "needsResolution"`, one request with
   `reason: REASON_AMBIGUOUS_RELATED_TEST_COMMAND` and
   `candidateBaseBranches` deep-equal to `["test:related", "test:changed"]`
   (fixed candidate-list order, not `package.json` key order — write the
   fixture with `test:changed` listed before `test:related` in the JSON to
   prove the order is not just echoing insertion order).
6. `test_persistedAnswerIsReusedOnNextRunForAmbiguousCandidates` — same
   fixture as test 5. First call: capture the returned request's `id`. Set
   `resolutionManifest.resolutionAnswers[request.id] = "test:changed"`
   directly (do not go through `applyResolutionAnswers` — see rationale
   above). Second call with the same `resolutionManifest`, same
   `occurrenceId`/`checkoutPath` → `status: "resolved"`,
   `policy.relatedTestCommand === "npm run test:changed"`,
   `policy.completeSuiteCommand === "npm run test"`.
7. `test_persistedAnswerIsReusedOnNextRunForMissingConfiguration` — same
   fixture as test 1 (no `package.json`). First call to get the request id,
   set `resolutionManifest.resolutionAnswers[request.id] = "npm run custom-test"`
   directly. Second call → `status: "resolved"`,
   `policy.relatedTestCommand === policy.completeSuiteCommand === "npm run custom-test"`.
8. `test_occurrencesOfOneLogicalRepositoryCarrySamePolicyWhileRecordedSeparately`
   — one fixture dir with `scripts: { test: "vitest run" }` (simulating two
   occurrences that check out the same upstream repository and therefore
   share the same `package.json`). Call `discoverTestPolicy("occ-a", dir, manifest)`
   and `discoverTestPolicy("occ-b", dir, manifest)` against the same
   `resolutionManifest`. Both resolve; assert
   `policyA.occurrenceId !== policyB.occurrenceId`,
   `policyA.relatedTestCommand === policyB.relatedTestCommand`, and
   `policyA.completeSuiteCommand === policyB.completeSuiteCommand` — two
   distinct `TestPolicy` records carrying identical commands, not one shared
   object.

Use `createEmptyResolutionManifest()` from `../scripts/resolutionRequests.ts`
to build a fresh `resolutionManifest` per test (import it; do not hand-roll
`{ resolutionRequests: [], resolutionAnswers: {} }` inline).

Run with `node --test tests/` (matches every existing test file's
convention — this repo's own `package.json` currently has no `"test"`
script, which is out of scope to add here).

## Implementation order (TDD)

1. Write all 8 tests in `tests/testPolicy.test.ts` against the not-yet-existing
   `scripts/testPolicy.ts` (RED — the import itself will fail first).
2. Add `scripts/testPolicy.ts` with just the types, constants, and
   `readPackageScripts`/`runScriptCommand`; get tests 1–4 green.
3. Add `resolveWithAnswerOrRequest` and the ambiguity branch; get test 5
   green.
4. Get tests 6–7 green (no new production code should be needed beyond step
   3 — these exercise the answer-reuse path already built).
5. Confirm test 8 passes with no changes (it exercises existing per-call
   independence, nothing new to add).
6. Run the full suite: `node --test tests/testPolicy.test.ts` then
   `node --test tests/` to confirm nothing else broke.

## Out of scope (say so, don't build it)

- No call site: nothing in `repositoryDiscovery.ts`, `repositoryManifest.ts`,
  or the run manifest is wired to `testPolicy.ts`. That is a later task.
- No non-npm ecosystem support ("equivalents" in the brief). Only
  `package.json` `scripts` is read. `ponytail:` — extend when a non-Node
  occurrence actually shows up in a real graph; nothing in the current
  fixtures or codebase needs it yet.
- No batch/multi-occurrence helper (e.g. `buildTestPolicies(occurrences, ...)`).
  Each occurrence calls `discoverTestPolicy` individually; add a batch
  wrapper only once a real caller needs one.
- No edits to `scripts/resolutionRequests.ts`. Its existing generic shape
  (`ResolutionRequest`, `ResolutionManifest`, `hasResolutionAnswer`,
  `createResolutionRequest`, `recordResolutionRequest`) is reused as-is;
  `candidateBaseBranches` holds script-key candidates here, not branch names
  — same field, reused for a second kind of candidate list, exactly as the
  brief directs ("emit a setup resolution request through
  scripts/resolutionRequests.ts").

## Note on how this plan was produced

The task instruction said to read only `plans/brief-18.md`. That brief names
`scripts/resolutionRequests.ts` as the mechanism to reuse and describes
per-occurrence records, both of which only have concrete, checkable shapes in
the existing code. Writing an implementable, unambiguous plan (per
`~/.claude/guides/planning.md`, "the implementing agent does not need to
reason about *how*") required reading that existing module plus its
consumer (`scripts/repositoryDiscovery.ts`), the occurrence type
(`scripts/repositoryManifest.ts`), a same-shaped prior-art discovery module
(`scripts/baseBranchResolution.ts`), their tests, and the three linked coding
guides. This plan should be reviewed with that in mind before being handed to
an implementer under a stricter "brief-only" constraint.
