# Plan: Versioned repository manifest with RepositoryOccurrence records

Implements `plans/brief-2.md` (Phase 1 of the recursive repository-discovery redesign,
`plans/codex-tackle-tasks-repo-discovery-phase-1.md`).

## Goal

Add a new, standalone module — `scripts/repositoryManifest.ts` — that defines the data shape
Phase 1+ will use to describe a repository occurrence graph (one entry per checked-out repository
location, parent/child edges explicit, no filesystem-path inference). This task only builds and
tests the data module. It does not change any production code path.

## Design decisions carried into every step below

- **New module only.** Do not import `repositoryManifest.ts` from `scripts/prepareTasks.ts`,
  `scripts/mergeTaskWorktrees.ts`, or `skills/tackle-tasks/tackle-tasks.workflow.js`, and do not
  edit those three files at all. Production keeps using the existing flat repository-path model
  until the brief's own Phase 4 cutover task. No CLI entry point either — this mirrors
  `scripts/taskGroups.ts` and `scripts/taskFiles.ts`, pure library modules with no `runAsCli`,
  consumed later by other scripts.
- **Every parent/child relationship is a stored edge, never a derived one.** The module must not
  call `dirname()`, split/strip path segments, or count `/` characters to figure out who a
  repository's parent is anywhere in this file, including inside the validator. The one test the
  brief calls out by name — `jfred/jfredToolsPlugin/external/tmux_lib`'s parent is the
  `jfred/jfredToolsPlugin` occurrence, not a synthetic `jfred/jfredToolsPlugin/external`
  occurrence — exists specifically to prove this: that occurrence's `checkoutPath` has 4 path
  segments below the root, but its `parentOccurrenceId` points directly at `jfredToolsPlugin` (a
  3-hop-from-root occurrence) via one stored edge, and its `depth` (computed by walking
  `parentOccurrenceId` links, not by counting `checkoutPath` slashes) is `3`, not `4`. If depth
  were ever computed from `checkoutPath.split("/").length` this test would fail — that's the
  point of it.
- **Field order in the type mirrors the brief's own listed order** (occurrence ID, checkout path,
  parent occurrence ID, path within parent, gitlink OID, depth, origin URL, base branch, base OID,
  operation branch, child occurrence IDs, test state) so a reviewer can check the type against the
  brief line-by-line without re-deriving a mapping.
- **The root occurrence's parent-shaped fields are `null`, not omitted or sentinel strings.**
  `parentOccurrenceId`, `pathInParent`, and `gitlinkOid` are all `string | null` for exactly this
  reason: the root of a run's occurrence graph has no parent edge and no gitlink pointing at it
  (nothing recorded it — it's the checkout the run started from), so `null` is the only accurate
  value, not `""` (which would collide with a legitimately empty path-in-parent, though none is
  expected in practice) and not a made-up ID.
- **`testState` is a minimal 3-value union (`"untested" | "passed" | "failed"`), not an open
  string.** The brief only says "and test state" — Phase 2–4 (`codex-tackle-tasks-repo-discovery-
  phase-2.md` through `-4.md`) are what actually define test policies, receipts, and pass/fail
  semantics. This task just needs a slot the type-checker can hold today; picking the 3 states
  that will obviously always apply (nothing has run yet / it ran and passed / it ran and failed)
  avoids inventing structure Phase 2+ will just replace. If a later phase needs more states
  (`"running"`, etc.), that's that phase's job to widen the union, not this one's job to guess at.
- **The validator returns `{ valid: boolean; errors: string[] }` instead of throwing.** No
  existing module in this repo has a validator to copy the shape from (checked: no
  `export function validate*` anywhere in `scripts/`), so this is a fresh but small decision.
  A returned list beats throwing here because the brief's own test list requires distinguishing
  *which* rule tripped (dangling parent vs. duplicate ID vs. bad depth) in three separate test
  cases — a thrown `Error` would force each test to regex-match a message string, whereas a
  returned `errors: string[]` lets each test assert on a specific, greppable substring without
  coupling to exact wording elsewhere. `valid` is `errors.length === 0`, not tracked separately.
- **Depth is validated by walking `parentOccurrenceId` edges from each occurrence to a root,
  counting hops** — the direct opposite of deriving depth from `checkoutPath`. The walk carries a
  `visited` set and bails out (skips that occurrence's depth check, already-reported by the
  dangling-parent or duplicate-ID checks) if it revisits a node, so a corrupt/cyclic manifest
  can't hang the validator in an infinite loop. This isn't in the brief's test list explicitly,
  but it's required for the validator to be safe to call on arbitrary (possibly malformed) input,
  which is the validator's whole purpose.

## Order of work (strict RED → GREEN)

### Step 1 (RED): `tests/repositoryManifest.test.ts` (new file)

Write these failing tests against not-yet-existing `scripts/repositoryManifest.ts`. Start the
file with a small builder so each test only overrides the fields it cares about instead of
repeating all 12:

```ts
// Behavioral checks for repositoryManifest.ts: round-trip serialization + graph validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    REPOSITORY_MANIFEST_VERSION,
    readRepositoryManifest,
    writeRepositoryManifest,
    validateRepositoryManifest,
    type RepositoryOccurrence,
    type RepositoryManifest,
} from "../scripts/repositoryManifest.ts";

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "root",
        checkoutPath: "",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "https://example.com/root.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "task-group-1",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}
```

Tests to add:

- `test_roundTripSerializationPreservesEveryOccurrenceField` — build a `RepositoryManifest` with
  `version: REPOSITORY_MANIFEST_VERSION` and 3 occurrences forming a chain (root → child →
  grandchild, so every field type is exercised, including non-null `parentOccurrenceId`,
  `pathInParent`, and `gitlinkOid` on the non-root ones). Write it with
  `writeRepositoryManifest(path, manifest)` into a `mkdtempSync(join(tmpdir(),
  "repository-manifest-"))` directory, read it back with `readRepositoryManifest(path)`, and
  `assert.deepEqual(readBack, manifest)`.
- `test_validateRejectsADanglingParentOccurrenceId` — one occurrence whose
  `parentOccurrenceId: "does-not-exist"`. Assert `validateRepositoryManifest(manifest).valid ===
  false` and `errors.some((e) => e.includes("does-not-exist"))`.
- `test_validateRejectsDuplicateOccurrenceIds` — two occurrences both with `occurrenceId: "dup"`.
  Assert `valid === false` and `errors.some((e) => e.includes("dup"))`.
- `test_validateRejectsADepthInconsistentWithTheParentChain` — root occurrence at `depth: 0`, a
  child occurrence with `parentOccurrenceId` pointing at root but `depth: 5` (should be `1`).
  Assert `valid === false` and `errors.some((e) => e.includes("depth"))`.
- `test_validateAcceptsANestedManifestWhoseParentIsTheImmediateRepositoryOccurrenceNotASyntheticPathSegment`
  — build exactly 4 occurrences: root (`checkoutPath: ""`), `jfred` (`checkoutPath: "jfred"`,
  parent = root), `jfredToolsPlugin` (`checkoutPath: "jfred/jfredToolsPlugin"`, parent = `jfred`,
  `pathInParent: "jfredToolsPlugin"`), and `tmuxLib` (`checkoutPath:
  "jfred/jfredToolsPlugin/external/tmux_lib"`, `parentOccurrenceId` = `jfredToolsPlugin`'s
  `occurrenceId`, `pathInParent: "external/tmux_lib"`, `depth: 3`). Do **not** create a 5th
  occurrence for `jfred/jfredToolsPlugin/external`. Assert:
  - `validateRepositoryManifest(manifest).valid === true` (with `errors` empty).
  - `manifest.occurrences.length === 4` (no synthetic entry got added by anything in the module).
  - the `tmuxLib` occurrence's `parentOccurrenceId` strictly equals the `jfredToolsPlugin`
    occurrence's `occurrenceId` (proves the edge, not a path match).
  - no occurrence in the manifest has `checkoutPath === "jfred/jfredToolsPlugin/external"`.

Run `node --test tests/repositoryManifest.test.ts` and confirm every test fails because the
module doesn't exist yet (RED).

### Step 2 (GREEN): `scripts/repositoryManifest.ts` (new file)

```ts
// Versioned repository occurrence graph: one RepositoryOccurrence per checked-out repository location.
import { readFileSync, writeFileSync } from "node:fs";

export const REPOSITORY_MANIFEST_VERSION = 1;

export type TestState = "untested" | "passed" | "failed";

export type RepositoryOccurrence = {
    occurrenceId: string;
    checkoutPath: string;
    parentOccurrenceId: string | null;
    pathInParent: string | null;
    gitlinkOid: string | null;
    depth: number;
    originUrl: string;
    baseBranch: string;
    baseOid: string;
    operationBranch: string;
    childOccurrenceIds: string[];
    testState: TestState;
};

export type RepositoryManifest = {
    version: number;
    occurrences: RepositoryOccurrence[];
};

export function readRepositoryManifest(path: string): RepositoryManifest {
    return JSON.parse(readFileSync(path, "utf8"));
}

export function writeRepositoryManifest(path: string, manifest: RepositoryManifest): void {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

export type ManifestValidationResult = { valid: boolean; errors: string[] };

// Walks parentOccurrenceId edges from `occurrence` to a root, counting hops.
function depthFromParentChain(
    occurrence: RepositoryOccurrence,
    occurrenceById: Map<string, RepositoryOccurrence>,
): number | null {
    const visited = new Set<string>();
    let current = occurrence;
    let depth = 0;
    while (current.parentOccurrenceId !== null) {
        if (visited.has(current.occurrenceId)) return null;
        visited.add(current.occurrenceId);
        const parent = occurrenceById.get(current.parentOccurrenceId);
        if (!parent) return null;
        depth += 1;
        current = parent;
    }
    return depth;
}

export function validateRepositoryManifest(manifest: RepositoryManifest): ManifestValidationResult {
    const errors: string[] = [];
    const occurrenceById = new Map<string, RepositoryOccurrence>();
    const duplicateIds = new Set<string>();
    for (const occurrence of manifest.occurrences) {
        if (occurrenceById.has(occurrence.occurrenceId)) duplicateIds.add(occurrence.occurrenceId);
        occurrenceById.set(occurrence.occurrenceId, occurrence);
    }
    for (const duplicateId of duplicateIds) {
        errors.push(`duplicate occurrence ID: "${duplicateId}"`);
    }

    for (const occurrence of manifest.occurrences) {
        if (occurrence.parentOccurrenceId === null) continue;
        if (!occurrenceById.has(occurrence.parentOccurrenceId)) {
            errors.push(
                `occurrence "${occurrence.occurrenceId}" has a dangling parent occurrence ID "${occurrence.parentOccurrenceId}"`,
            );
        }
    }

    for (const occurrence of manifest.occurrences) {
        const expectedDepth = depthFromParentChain(occurrence, occurrenceById);
        if (expectedDepth !== null && occurrence.depth !== expectedDepth) {
            errors.push(
                `occurrence "${occurrence.occurrenceId}" has depth ${occurrence.depth}, expected ${expectedDepth} from its parent chain`,
            );
        }
    }

    return { valid: errors.length === 0, errors };
}
```

Run `node --test tests/repositoryManifest.test.ts` until every test is green.


### Step 3: guard against wiring drift

Run `git diff --stat` (or `git status`) and confirm the only new/changed paths are
`scripts/repositoryManifest.ts` and `tests/repositoryManifest.test.ts`. Specifically confirm
`scripts/prepareTasks.ts`, `scripts/mergeTaskWorktrees.ts`, and
`skills/tackle-tasks/tackle-tasks.workflow.js` are untouched — the brief requires this module stay
unwired until the Phase 4 cutover task.

### Step 4: full-suite regression check

Run `node --test 'tests/*.test.ts'` and confirm every existing test still passes (this module adds
no imports into any file another test exercises, so this should be a no-op check, but it's cheap
insurance against an accidental edit outside the two new files).

## Known, accepted consequences (do not treat as bugs to fix in this task)

- Nothing reads or writes an actual manifest file at runtime yet — `readRepositoryManifest` /
  `writeRepositoryManifest` are exercised only by this task's own round-trip test until a later
  phase task wires them into discovery.
- `testState`'s 3-value union is a placeholder Phase 2+ may need to widen; that's expected, not a
  gap to close here.
- The validator does not check `childOccurrenceIds` reciprocity (i.e. that every occurrence listed
  in a parent's `childOccurrenceIds` actually has that parent as its `parentOccurrenceId`, or vice
  versa) — the brief's test list names three specific rejection rules and this isn't one of them;
  adding it here would be validating a relationship this task doesn't yet populate meaningfully.

## Line-count note

`scripts/repositoryManifest.ts` is ~75 lines fully written out above — comfortably under the
250-line cap, no split needed.
