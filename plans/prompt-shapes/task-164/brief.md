# Task 164: 'changes detected' Stop hook prints the real staged diff

## Goal

**This task is considered done when all of these are true:**

- After a turn that edits and stages a file, the Stop hook's additionalContext contains the actual `git diff --staged` text for that file, not only the generic 'Files were changed' sentence.
- The staged-diff text comes from the same scripts/stagedDiffs.ts code path the commit-message skill uses; no second copy of the diff logic exists in the repo.
- The full diff is emitted, not a file-name-only list.
- Staged changes in a submodule whose pointer moved appear in the hook output, labelled per repo, the same way the commit-message skill labels them.
- `npm test` passes, including an updated tests/stage-and-summarize-stop.test.ts that asserts the staged-diff text is present in additionalContext.

## Not in scope

- NOT in scope: changing the commit-message skill's own output or wording, changing the EXCLUDES list in stagedDiffs.ts, and changing the staging behaviour itself -- the hook still only reports, it never stages.

## problemSolvedByTask

The agent doesn't accurately see what is really staged after the end-of-turn stage-and-summarize-stop.ts hook fires.

## User request

make the 'changes detected' hook print out what changes are actually staged, because the agent's view of staged changes is always stale.  It should use the same code that the commit-message hook uses to provide the list of staged changes.

The 'changes detected' hook is scripts/stage-and-summarize-stop.ts (Stop/SubagentStop), which currently only checks `git status --porcelain` column two per file to decide if anything is unstaged, then emits a generic additionalContext string 'Files were changed. Stage the changes...' with no diff content. The commit-message skill already has the reusable staged-diff code in scripts/stagedDiffs.ts: it resolves the repo root via `git rev-parse --show-toplevel` from `process.cwd()`, runs `git diff --staged` with an EXCLUDES filter, and recurses into any submodule whose pointer moved. Note stagedDiffs.ts is currently a top-level script that writes to stdout, not an exported function -- confirm its actual shape in the source before assuming an export exists; extracting a reusable function is expected. stage-and-summarize-stop.ts must call that shared code and include the actual staged-diff text in the additionalContext payload instead of the generic reminder, so the agent sees what is really staged rather than trusting its stale in-context view. The user chose the FULL staged diff, not a file-name-only list, and chose reuse of the same code over a new lighter implementation. Complication: stage-and-summarize-stop.ts iterates over `paths` that can span multiple repos/submodules (using `dirname(p)` per path), while stagedDiffs.ts resolves only one repo root from cwd with no repo parameter, so this task must either loop the stagedDiffs logic per distinct repo root among the flagged paths, or add a repo-path parameter. tests/stage-and-summarize-stop.test.ts's `run()` helper currently asserts additionalContext matches /commit-message skill/ and does not exercise diff content, so the tests need updating to assert the emitted diff text appears in additionalContext.

## Audit correction (2026-08-31)

scripts/stagedDiffs.ts already exports stagedDiffs() (line 27) with a CLI guard at line 55 — the extraction this description asks to confirm is done. It takes no repo argument and resolves a single root from cwd; the remaining work is the repo-path parameter. 'The hook still only reports, it never stages' means not in scope for this task; task 160 owns staging behavior.

## Files

@scripts/hooks/stage-and-summarize-stop.ts
@scripts/shared/stagedDiffs.ts
@tests/stage-and-summarize-stop.test.ts