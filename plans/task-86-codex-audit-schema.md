# Task 86 Codex Audit Finding Schema

This document defines the shape and evidence standard for findings in
`plans/task-86-codex-audit.json`. Future audit sessions should use it when
adding or revising issues so each entry explains both the remaining defect and
the working boundaries that a fix must preserve.

## Document-level fields

### `schemaDocumentation`

The repo-relative path to this guide. Keep the pointer in the JSON so a session
that opens only the audit data can discover the evolved schema before editing
issues.

### `verificationPerformed`

An array of concise statements describing the evidence gathered for the audit
as a whole: commit range, worktree state, source documents read, commands run,
and test results. Distinguish committed `HEAD` from staged, unstaged, or
untracked changes. Do not claim that a suite passed unless it was run against
the state being audited.

### `notes`

An array of dated audit-wide qualifications. Each item has:

- `date`: ISO 8601 timestamp with offset.
- `text`: context needed to interpret the findings or verification results.

Use this for cross-cutting caveats, not issue-specific evidence.

### `issues`

The array of active findings. Remove an issue only after checking the current
implementation and confirming that its proving case is resolved without
breaking the boundaries named in the issue.

## Required issue fields

New findings should use the fields below in this order.

### `number`

The stable numeric suffix of the finding ID. `39` means `C86-39`. Never reuse a
removed number for a different defect.

### `title`

Format:

```text
C86-N — Severity: concise statement of the observable defect
```

The title should describe what fails, not merely name the component. Put
qualifiers such as `test gap` or `flaky test` here when they materially change
the finding.

### `class`

One of `high`, `medium`, or `low`. This is the normalized severity used for
sorting and filtering; keep qualifiers in `title`.

- `high`: can lose work, merge or close incorrect state, violate ownership, or
  prevent the main workflow from completing/reporting correctly.
- `medium`: breaks a supported path or important contract but has a narrower
  impact or a practical workaround.
- `low`: localized correctness, maintainability, or test-coverage defect with
  limited immediate runtime impact.

### `cause`

One cohesive paragraph describing the current causal chain:

1. What the code currently does.
2. Why that behavior violates the intended contract.
3. What user-visible or state-visible failure follows.

Name the current files/functions and distinguish already-resolved portions from
the remaining defect. Do not put the proposed implementation here. Re-check the
paragraph whenever relevant staged or unstaged code changes.

### `locations`

An array of current broken-code evidence. Each item has:

- `path`: repo-relative path that exists in the audited worktree.
- `lines`: current line number or comma-separated ranges, as a string.
- `role`: one sentence explaining how this location causes, propagates, masks,
  or fails to test the defect.

Locations answer “where is the remaining problem?” They are not the place for
correct neighboring code; use `resolvedBoundaryReference` for that. Update
renamed paths and line anchors before handing off the audit.

### `provingTest`

A deterministic reproduction written as an executable test scenario. State:

- the fixture or initial state;
- the production-shaped entry point to invoke;
- the observation that fails today;
- the corrected observation;
- important negative controls or interleavings.

Avoid timing assumptions, mocked-away integration steps, and tests that perform
operations forbidden by the production contract. A command transcript is
useful when the failure has already been reproduced.

### `suggestedFixApproach`

An ordered array of implementation guidance. Describe the smallest coherent
architecture that satisfies the proving test and acceptance criteria. Explicitly
mention state that must survive retries, normalization boundaries, transaction
boundaries, or ordering constraints. Do not prescribe a shortcut that weakens a
valid guard elsewhere.

### `resolvedBoundaryReference`

An array naming current, already-correct boundaries that the eventual fix must
preserve or extend. Each item has:

- `file`: preferably a repo-relative current path. An absolute path is acceptable
  only when the reference intentionally points at a separate checkout or design
  exemplar.
- `role`: what is already correct there and why it constrains the remaining fix.

This is not another list of defect locations. Typical references include an
existing lock/atomic-write boundary, a normalized result adapter, a sandbox
boundary, a correct sibling stage, or an occurrence-aware primitive that the
broken caller should reuse.

### `acceptanceCriteria`

An array of independently verifiable outcomes that collectively close the
finding. Criteria should cover:

- the corrected positive path;
- the dangerous negative or failure path;
- state/reporting/cleanup behavior where relevant;
- deterministic regression coverage;
- preservation of any resolved boundary.

Write outcomes, not implementation steps. A reviewer should be able to decide
pass/fail without inferring intent from `suggestedFixApproach`.

### `resolvedBoundaryExample`

An array of concrete examples from code that is correct today. Each item has:

- `file`: the current file containing the example.
- `code`: the smallest relevant snippet showing the boundary or invariant to
  preserve.

Prefer verbatim current code. Light elision is allowed when marked by a comment
and when it cannot change the meaning. This field answers “what working pattern
should the fix follow?” It must not contain the proposed fix.

### `remainingMinimalExample`

An array of minimal prospective implementation or regression-test sketches.
Each item has:

- `file`: the file expected to change; it may be a proposed new file.
- `code`: a focused sketch of the remaining change.

The example must align with `cause`, `provingTest`, `suggestedFixApproach`, and
`acceptanceCriteria`. It need not be drop-in complete, but it should show the
critical state, ordering, or API shape rather than restating the fix in prose.
Include a test sketch when the missing regression is not obvious from the
implementation example.

### `existingOpenTask`

State the result of checking authoritative open tasks against this exact
finding. Use one of these forms:

- `Exact match: open task N ...`
- `Related: open task N ...; it does not cover ...`
- `No matching open task.`
- `No open item. Task N is completed, but ... was not delivered.`

Do not call a broad or superseded task an exact match. Re-check this field when
tasks are created, closed, split, or rewritten.

## Optional legacy field

### `codeChange`

Older entries may contain:

```json
{
  "old": {
    "path": "path/to/current-file.ts",
    "lines": "10-20",
    "code": "current code"
  },
  "new": {
    "code": "proposed code"
  }
}
```

Preserve an existing `codeChange` when updating an entry, but new findings
should use `resolvedBoundaryExample` and `remainingMinimalExample`, which make
the current-correct versus proposed-remaining distinction explicit.

## Canonical issue template

```json
{
  "number": 40,
  "title": "C86-40 — Medium: concise observable defect",
  "class": "medium",
  "cause": "Current causal chain and resulting failure.",
  "locations": [
    {
      "path": "scripts/example.ts",
      "lines": "10-24",
      "role": "How this current location creates or masks the defect."
    }
  ],
  "provingTest": "Production-shaped deterministic reproduction, current failure, and corrected assertion.",
  "suggestedFixApproach": [
    "Smallest coherent implementation direction.",
    "Required state, ordering, normalization, or regression coverage."
  ],
  "resolvedBoundaryReference": [
    {
      "file": "scripts/alreadyCorrect.ts",
      "role": "Existing invariant or boundary the fix must preserve."
    }
  ],
  "acceptanceCriteria": [
    "Corrected positive path is observable.",
    "Dangerous negative path is rejected or reported.",
    "Deterministic focused regression coverage passes."
  ],
  "resolvedBoundaryExample": [
    {
      "file": "scripts/alreadyCorrect.ts",
      "code": "const currentInvariant = preserveThisBoundary()"
    }
  ],
  "remainingMinimalExample": [
    {
      "file": "scripts/example.ts",
      "code": "const result = proposedMinimalShape()"
    },
    {
      "file": "tests/example.test.ts",
      "code": "test('proves the corrected contract', () => { /* assertions */ })"
    }
  ],
  "existingOpenTask": "No matching open task."
}
```

## Audit update checklist

1. Inspect committed history and separately inspect relevant staged, unstaged,
   and untracked changes.
2. Reproduce or source-audit the defect before writing it as a finding.
3. Confirm every `locations.path` and `resolvedBoundaryReference.file`, and
   refresh line numbers against the current worktree.
4. Search authoritative open and completed task records for exact or partial
   overlap.
5. Write the proving test before finalizing the proposed fix and acceptance
   criteria.
6. Identify at least one already-correct boundary to preserve. If none exists,
   say so explicitly in the reference role rather than inventing one.
7. Keep current-correct snippets in `resolvedBoundaryExample` and prospective
   snippets in `remainingMinimalExample`; never swap them.
8. Validate the JSON and required evolved fields:

   ```sh
   jq empty plans/task-86-codex-audit.json
   jq -e 'all(.issues[];
     (.resolvedBoundaryReference | type == "array" and length > 0) and
     (.acceptanceCriteria | type == "array" and length > 0) and
     (.resolvedBoundaryExample | type == "array" and length > 0) and
     (.remainingMinimalExample | type == "array" and length > 0)
   )' plans/task-86-codex-audit.json
   git diff --check -- plans/task-86-codex-audit.json plans/task-86-codex-audit-schema.md
   ```

9. Check for duplicate object keys. Many JSON parsers accept duplicates and
   silently keep only the last value, so `jq empty` alone is not sufficient.
10. Run focused tests proportional to the audited change and record exactly
    what ran in `verificationPerformed`.
