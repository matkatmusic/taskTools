# Task 40 Plan: workers run and fix their own tests before reporting complete

## Why (one line each)
- `SKILL.md` line 40 currently bans test suites entirely during implementation, for both the orchestrator and workers.
- `tackle-tasks.workflow.js`'s `workerBrief` template currently tells every worker "do not run test suites."
- Both must instead require: worker runs the tests covering the files it owns, fixes its own failures, and only reports "done" once they pass. A worker whose tests still fail after its best effort reports `partial` or `blocked` (per `WORKER_SCHEMA`'s `status` enum) — never `done`.
- `close-tasks`'s full-suite run stays the final gate; nothing here removes or duplicates it.

This is a text-only change to two prompt/instruction files — no application logic, no branching to unit test. Verification is a grep check (Step 3), not a test file.

## Step 1 — `skills/tackle-tasks/SKILL.md`

Open the file and find this exact paragraph (currently line 40):

```
During implementation, run typecheck only — no test suites or visual checks, by you or by workers. Full verification (typecheck + full suite + the repo's UI verification where relevant) runs once inside `close-tasks`, after the user approves closing.
```

Replace it with:

```
During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside `close-tasks`, after the user approves closing.
```

Rationale for the exact wording: keeps the orchestrator's own scope unchanged (typecheck only, no full-suite duplication of `close-tasks`), states the new worker requirement in the same "status complete" vocabulary the brief uses, and keeps the existing sentence about `close-tasks` being the final gate untouched in meaning.

If the file's current text at this location differs from the quoted paragraph (e.g. it was edited since this plan was written), match on the surrounding "## Verification section" heading two paragraphs above and the "## Commit message" heading immediately below it to relocate the paragraph before editing.

## Step 2 — `skills/tackle-tasks/tackle-tasks.workflow.js`

Open the file and find this block inside the `workerBrief` template literal (currently):

```
When the edits are done, run: ${TYPECHECK_COMMAND}
Fix type errors in the files you own; do not run test suites, visual checks,
or any other verification.
```

Replace it with:

```
When the edits are done, run: ${TYPECHECK_COMMAND}
Fix type errors in the files you own.

Then run the tests covering the files you own and fix any failures — check
for a related-test discovery command in this repo (e.g. scripts/relatedTests.ts)
before falling back to running each owned file's own test file directly. Do
not run the full suite; that is the close-tasks gate, not yours.

If your tests still fail after a reasonable effort, do not commit. Return
status "blocked" (or "partial" if part of the plan is done) and name the
failing tests in "remaining" — never return status "done" with a failing test.
```

Rationale: the brief requires workers to discover and run only the tests scoped to their owned files, not the full suite (`close-tasks` already owns that). This repo added `scripts/relatedTests.ts` in a recent task (per git history) specifically for per-occurrence test-file discovery; the implementing agent should confirm it's present and reference its actual CLI invocation (read the file to get exact usage) rather than inventing a syntax here, since this plan was written without reading source files other than the brief. If no such script exists at implementation time, keep the fallback wording ("running each owned file's own test file directly") as-is.

Leave `WORKER_SCHEMA`, `runWorker`, `implementStage`, and the requeue-on-`partial` loop untouched — the existing `done | partial | blocked` enum and requeue path already support "never done with a failing test" without any schema change.

## Step 3 — Verify (no source edit)

Run:
```
rg -n "do not run test suites|no test suites|run typecheck only" skills/tackle-tasks/SKILL.md skills/tackle-tasks/tackle-tasks.workflow.js
```
Expect zero matches of the old prohibition phrasing, and confirm by eye that both replacement paragraphs from Steps 1–2 are present in full. This is the one runnable check for a text-only change — no test framework needed.

## Out of scope
- Do not touch `close-tasks` or its full-suite run.
- Do not add a new test-discovery script — reuse `scripts/relatedTests.ts` if present; only fall back to plain test-file conventions if it's absent.
- Do not change `WORKER_SCHEMA`'s enum or add a new status value.
