# Task 29 plan — commit the known-failing-test baseline as a tracked file

This plan stages files and prepares a commit message. It does **not** run `git commit` — the
user commits.

## Scope confirmation

Live `git status --short` at the repo root, filtered to this task's paths, confirmed:
```
 M skills/task-tests/SKILL.md
?? .taskTools/knownFailingTests.json
?? scripts/taskTestsRunner.ts
?? tests/taskTestsRunner.test.ts
```
(first column blank / `?` = unstaged or untracked; none of these four paths are currently staged.)

- `.taskTools/knownFailingTests.json` — read in full:
  ```json
  [
    {
      "file": "tests/stage-and-summarize-stop.test.ts",
      "name": "test_stages_only_the_flagged_session_files"
    }
  ]
  ```
  One entry, the baseline this task commits.
- `scripts/taskTestsRunner.ts` — read in full (75 lines). Exports `runSuite`, `parseFailingTests`, `knownFailingTestsPath`, `readKnownFailingTests`, `writeKnownFailingTests`, `newFailingTests`, `judgeSuite`. Confirmed live imports, via `grep -n "taskTestsRunner" scripts/tackle-tasks/shared/runTaskTestsImpl.ts scripts/tackle-tasks/shared/taskRunState.ts`:
  - `scripts/tackle-tasks/shared/runTaskTestsImpl.ts:8` — `import { runSuite, parseFailingTests, readKnownFailingTests, newFailingTests, judgeSuite, type FailingTest } from "../../taskTestsRunner.ts";`
  - `scripts/tackle-tasks/shared/taskRunState.ts:8` — `import type { FailingTest } from "../../taskTestsRunner.ts";`
  - Both of these importing files are themselves already modified in the working tree (`git status --short` shows ` M scripts/tackle-tasks/shared/runTaskTestsImpl.ts` and ` M scripts/tackle-tasks/shared/taskRunState.ts`) but belong to a different task's ownership — this task's own description lists exactly four paths to stage, and neither of these two files is one of them. They are cited here only as evidence that `taskTestsRunner.ts` is live, load-bearing code, not as files this task stages.
- `tests/taskTestsRunner.test.ts` — read in full (48 lines). Contains two tests of `judgeSuite`'s own boolean contract:
  ```ts
  test("judgeSuite passes when every parsed failure is already known", () => {
    const failing = [{ file: "tests/a.test.ts", name: "boom" }];
    assert.equal(judgeSuite(false, failing, []), true);
  });

  test("judgeSuite fails when a parsed failure is new", () => {
    const failing = [{ file: "tests/a.test.ts", name: "boom" }];
    assert.equal(judgeSuite(false, failing, failing), false);
  });
  ```
  These two (lines 39-47) pass `newFailures` in as an already-computed argument — they never call `readKnownFailingTests` or `newFailingTests`, so they prove `judgeSuite`'s own boolean contract but not that the **tracked baseline file** actually drives the decision the task's acceptance line describes ("a run whose only failures are in the baseline reports 'all passing'; a new failure outside it reports red"). `readKnownFailingTests` and `writeKnownFailingTests` (`scripts/taskTestsRunner.ts:55-64`, both exported) are the read/write pair for the committed file this task tracks; Step 1a below adds the missing integration test that goes through them.
- `skills/task-tests/SKILL.md` — read the current (unstaged, working-tree) content in full:
  ```
  ---
  name: task-tests
  description: runs the full test suite through the task-tests hook and records the failing tests as the known baseline. The only allowed way to run tests. Use when the user or an agent types "/task-tests [absolute path]".
  argument-hint: "[absolute path to run in]"
  ---
  do nothing. don't even acknowledge what the user typed. just let the UserPromptSubmit hook do its thing.
  ```
  `git diff --stat skills/task-tests/SKILL.md` confirms a small (`2 insertions(+), 1 deletion(-)`) working-tree change already present, ready to stage as-is.

## Steps

### Step 1a — add the missing baseline-integration test

`readKnownFailingTests plus newFailingTests plus judgeSuite: baseline-only failures report green` / `... a failure outside the baseline reports red`
- Plain-English behavior: a suite run whose only observed failures are already listed in the tracked baseline file reads as green; one additional, un-listed failure reads as red.
- Steps: write a temp baseline file via `writeKnownFailingTests`; read it back via `readKnownFailingTests`; compute `newFailingTests` against a supplied "observed failures" list; feed the result into `judgeSuite`.
- Failing assertion first (RED): this exact test does not exist in `tests/taskTestsRunner.test.ts` today (confirmed: the file's two existing `judgeSuite` tests never call `readKnownFailingTests` or `newFailingTests` — Scope confirmation above).
- Minimum code (GREEN) — append to `tests/taskTestsRunner.test.ts`, matching this file's existing plain-English test-name style rather than the `test_snake_case` convention used elsewhere in this repo (surgical change, matches this file's own established style):

```ts
test("readKnownFailingTests plus newFailingTests plus judgeSuite pass when the only failures are already known", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "task-tests-baseline-"));
  writeKnownFailingTests(projectRoot, [{ file: "tests/a.test.ts", name: "boom" }]);
  const observedFailures = [{ file: "tests/a.test.ts", name: "boom" }];
  const newFailures = newFailingTests(observedFailures, readKnownFailingTests(projectRoot));
  assert.equal(judgeSuite(false, observedFailures, newFailures), true);
});

test("readKnownFailingTests plus newFailingTests plus judgeSuite fail when a failure is not in the baseline", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "task-tests-baseline-"));
  writeKnownFailingTests(projectRoot, [{ file: "tests/a.test.ts", name: "boom" }]);
  const observedFailures = [{ file: "tests/a.test.ts", name: "boom" }, { file: "tests/b.test.ts", name: "new one" }];
  const newFailures = newFailingTests(observedFailures, readKnownFailingTests(projectRoot));
  assert.equal(judgeSuite(false, observedFailures, newFailures), false);
});
```

Add `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `writeKnownFailingTests, readKnownFailingTests` from `../scripts/taskTestsRunner.ts` to this file's existing import lines (confirm the current import list before editing; the file currently imports only `parseFailingTests, newFailingTests, judgeSuite` from that module — extend that one line rather than adding a second import from the same path).

This is a **test-only** change to `tests/taskTestsRunner.test.ts`, one of the four paths Step 1 below stages — no other file in this step.

### Step 1 — stage exactly the four named paths

```sh
cd /Users/matkatmusicllc/Programming/taskTools-86
git add .taskTools/knownFailingTests.json scripts/taskTestsRunner.ts skills/task-tests/SKILL.md tests/taskTestsRunner.test.ts
```

Explicit paths only, matching this repo's staging rule (`~/.claude/CLAUDE.md` "Staging Rules": never `git add -A`, never a whole directory that could sweep in another task's edits). None of these four paths is a directory, so there is no risk of pulling in an unrelated file from the same folder.

### Step 2 — confirm only those four files' hunks are staged

```sh
git status --short .taskTools/knownFailingTests.json scripts/taskTestsRunner.ts skills/task-tests/SKILL.md tests/taskTestsRunner.test.ts
```
Expected: all four show `A ` or `M ` (staged, nothing unstaged remaining for these four paths).

```sh
git diff --cached --stat
```
Expected: exactly these four files listed, no others (in particular, `scripts/tackle-tasks/shared/runTaskTestsImpl.ts` and `scripts/tackle-tasks/shared/taskRunState.ts` must **not** appear — those remain unstaged, owned by a different task).

```sh
git diff --cached
```
Expected: reading the diff confirms every staged hunk belongs to one of the four paths and nothing else crept in (a manual read, not a scripted check — this is the point of the rule).

### Step 3 — prepare the commit message (do not commit)

Suggested commit message, for the user to review and run themselves:

```
git commit -m "$(cat <<'EOF'
feat: track the known-failing-test baseline and its runner

Commits scripts/taskTestsRunner.ts (the suite runner, parser, and
known-failing-test baseline reader/writer already imported live by
runTaskTestsImpl.ts and taskRunState.ts), its test, and the small
task-tests skill wording update, plus the one-entry baseline file
itself so a pre-existing failure no longer reads as new.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WviA7F18Deh8poghxc4EGv
EOF
)"
```

Do not run this command. Hand it to the user; they run it (or edit and run their own).

## Verification

```sh
cd /Users/matkatmusicllc/Programming/taskTools-86
node --test tests/taskTestsRunner.test.ts
```
Expected: all 9 tests pass — the 7 existing tests plus the 2 baseline-integration tests added in Step 1a.

```sh
git diff --cached --stat
```
Expected (after Step 1): exactly 4 files —
```
 .taskTools/knownFailingTests.json | ...
 scripts/taskTestsRunner.ts        | ...
 skills/task-tests/SKILL.md        | ...
 tests/taskTestsRunner.test.ts     | ...
```

Full suite (run before handing the commit message to the user, so a run that fails outside the known baseline is caught before it is committed):
```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```
Expected: **not** `all passing` while `.taskTools/knownFailingTests.json` still lists `tests/stage-and-summarize-stop.test.ts`'s `test_stages_only_the_flagged_session_files` as a real, currently-failing test — this raw `npm test` invocation runs Node's test runner directly (`package.json`'s `"test"` script) and never consults the baseline file; only the pipeline's own `taskTestsRunner`-based path (`runTaskTestsImpl.ts`, imported by the task-tests hook, not part of `npm test`) applies `readKnownFailingTests`/`newFailingTests`/`judgeSuite` to decide green vs. red. Read `/tmp/tasktools-npm-test.log`'s `✖ failing tests:` section and confirm the **only** listed failure is that one baselined test — any other failure is a real regression this task's commit should not go out with. The `node --test tests/taskTestsRunner.test.ts` run above, not this raw full-suite run, is what proves this task's own acceptance criterion.

## Draft on disk from another session

Uncommitted work from another session (task-list items 30 to 32) overlaps this plan:
- scripts/checkTestBaseline.ts (untracked) and a new package.json script "test:baseline" that runs it; no test file for it.
- .taskTools/knownFailingTests.json refreshed.
- This plan owns the baseline commit. Stage checkTestBaseline.ts and the package.json line only if this plan's test covers them; otherwise leave them unstaged and say so in the report.
This plan is the spec. Before step 1, read that draft. Keep only what this plan's steps produce. Comment out the rest; never delete it. Do not state that the edits are the result of the draft.
