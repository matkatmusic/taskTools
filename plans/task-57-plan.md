# Task 57 Plan: Rename basePublication's `LogicalRepository` to `PublicationTarget`

## Goal
`scripts/basePublication.ts` and `scripts/logicalRepository.ts` both export a type named
`LogicalRepository`, and the two are structurally incompatible. Any file importing both must
alias one. Rename the `basePublication.ts` one to `PublicationTarget`. `scripts/logicalRepository.ts`
keeps its own `LogicalRepository` name unchanged — it is the older, more widely used of the two.

No behavior change. Type-level rename only.

## Verified inventory

Every occurrence of the string `LogicalRepository` in the ten owned files, from
`rg -n 'LogicalRepository' <file>` run against the current tree. Two files need edits;
eight do not.

### Files that MUST change

**`scripts/basePublication.ts`** — declares the colliding type. Six occurrences across five
lines, all rename: the declaration and five annotations:

| Line | Occurrence | Action |
| --- | --- | --- |
| 6 | `export type LogicalRepository = {` | rename declaration to `PublicationTarget` |
| 48 | `revalidateRecordedBaseOids(repos: LogicalRepository[]): { ok: boolean; moved: LogicalRepository[] }` | rename both annotations |
| 59 | `publishCanonicalRef(repo: LogicalRepository)` | rename annotation |
| 80 | `repo: LogicalRepository,` | rename annotation |
| 116 | `repos: LogicalRepository[],` | rename annotation |

**`tests/basePublication.test.ts`** — imports the colliding type from `basePublication.ts`.
Three occurrences, all rename:

| Line | Occurrence | Action |
| --- | --- | --- |
| 13 | `import type { LogicalRepository, UpdatedRef } from "../scripts/basePublication.ts";` | rename the imported binding to `PublicationTarget` |
| 62 | `function makeLogicalRepoFixture(name: string): { repo: LogicalRepository; otherPath: string }` | rename the annotation only; the function name `makeLogicalRepoFixture` does not contain `LogicalRepository` and stays as is |
| 132 | `const failingRepoC: LogicalRepository = { ...fixtureC.repo, targetOid: "a".repeat(40) };` | rename annotation |

### Files that must NOT change

**`scripts/logicalRepository.ts`** — lines 1, 9, 28, 31, 49, 67. This is the type being kept.
Line 9 `export interface LogicalRepository` is its own declaration; lines 28/31/49 annotate it;
lines 1 and 67 are a comment and the identifier `buildLogicalRepositoryFromGroup`, which merely
contains the substring.

**`scripts/operationPush.ts`** — lines 3, 13, 60, 61, 98. Line 3 is
`import type { LogicalRepository } from "./logicalRepository.ts"` — the kept type, not the
renamed one. Lines 13/61 annotate that imported type. Lines 60 and 98 are the identifiers
`pushLogicalRepository` / `logicalRepositories`, substrings only.

**`scripts/ownershipKeys.ts`** — lines 5, 18, 29, 34. Line 5 imports from
`./logicalRepository.ts`, the kept type. Line 18 annotates it. Lines 18/29/34 also carry the
identifiers `findLogicalRepository` and `logicalRepository`, substrings only.

**`scripts/runConsolidation.ts`** — lines 19, 117, 118, 178, 183. Every hit is part of a longer
identifier: `LogicalRepositoryConsolidationInput` (a distinct locally declared type),
`consolidateLogicalRepository`, `logicalRepositories`. No reference to either bare type.

**`tests/logicalRepository.test.ts`** — lines 47, 94, 116. All three are inside test *name*
string literals (`test_groupsThreeOccurrencesOfSameUpstreamIntoOneLogicalRepository` and
similar). No type reference. Renaming them would rewrite test assertions, which this task
forbids.

**`tests/operationPush.test.ts`** — lines 8, 65, 84, 108, 134, 168, 190. Line 8 imports from
`../scripts/logicalRepository.ts`, the kept type. Line 65 annotates it. The rest are the
identifiers `makeLogicalRepository` / `logicalRepository`, substrings only.

**`tests/runConsolidation.test.ts`** — lines 9, 12, 77, 78, 95, 114, 118, 130, 186, 196, 207.
All are `LogicalRepositoryConsolidationInput`, `consolidateLogicalRepository`, or a test-name
string. No reference to either bare type.

**`tests/testPolicy.test.ts`** — line 128 only, and it is inside the test name string
`test_occurrencesOfOneLogicalRepositoryCarrySamePolicyWhileRecordedSeparately`. There is no
import of either type in this file and no type annotation to change. This file needs no edit
at all; it appears in the task's owned-file list only because that list was built from a
substring grep that matched the test name.

## Steps

1. In `scripts/basePublication.ts`, rename the exported type at line 6 from `LogicalRepository`
   to `PublicationTarget`, then update the five type annotations on lines 48, 59, 80, and 116
   (line 48 carries two annotations). Leave every other identifier alone.
2. In `tests/basePublication.test.ts`, change the line 13 import binding to `PublicationTarget`
   and update the two annotations at lines 62 and 132. Do not rename
   `makeLogicalRepoFixture` or any test name.
3. Touch none of the other eight files.

## Verification

- `npx tsc --noEmit` is clean. This is the real check: if any consumer of
  `basePublication.LogicalRepository` was missed, the compiler reports an unresolved name,
  because the export no longer exists under the old name.
- `npm test` passes the complete test suite.
- `rg -n 'LogicalRepository' scripts/basePublication.ts tests/basePublication.test.ts` returns
  no matches afterwards.
- `rg -n 'LogicalRepository' scripts/logicalRepository.ts` still returns its declaration —
  proving the wrong type was not renamed.
- No test assertion is rewritten other than the type name in the two annotations named above.

## Out of scope

- Renaming `scripts/logicalRepository.ts`'s `LogicalRepository`.
- Renaming any identifier that merely contains the substring (`buildLogicalRepositoryFromGroup`,
  `pushLogicalRepository`, `findLogicalRepository`, `consolidateLogicalRepository`,
  `makeLogicalRepository`, `makeLogicalRepoFixture`, `LogicalRepositoryConsolidationInput`).
- Renaming any test name string.
- Any behavior change, new test, or signature change beyond the type's name.
