# Task 62 plan: convert COMMIT_MESSAGES.md into a skill, injected diff instead of instructions

## Summary

`skills/tackle-tasks/COMMIT_MESSAGES.md` is a plain markdown file that three
call sites currently `cat` (or, for the Stop hook, tell the agent to `read`)
and then are supposed to follow. Convert it into a real skill,
`skills/commit-message/SKILL.md`, whose body injects the actual staged diff
at invocation time via a new helper script, `scripts/stagedDiffs.ts`, so the
diff arrives as content instead of as an instruction to go fetch it. Repoint
all three call sites at the new skill, then delete the old file.

## Files touched

- `skills/commit-message/SKILL.md` — **new file**
- `scripts/stagedDiffs.ts` — **new file**
- `tests/commitMessageSubagent.test.ts` — **new file**
- `skills/tackle-tasks/SKILL.md` — edit lines 137–141
- `scripts/stage-and-summarize-stop.ts` — edit line 4, edit lines 35–45
- `skills/update-tasks/SKILL.md` — edit line 27
- `skills/tackle-tasks/COMMIT_MESSAGES.md` — **delete**

## Owned files that need no edit

- `scripts/blockerVerdicts.ts` — does not exist on disk (confirmed:
  `Read` on this path errors "File does not exist"). Not referenced by
  this brief. No action.
- `scripts/checkBlockers.ts` — exists, read in full. Contains no reference
  to `COMMIT_MESSAGES.md` or any commit-message logic; it only resolves
  blocked/unblocked task numbers via `taskFiles.ts`. No edit.
- `skills/tackle-tasks/blockers.workflow.js` — does not exist on disk
  (confirmed via directory listing of `skills/tackle-tasks/`, which shows
  only `.gitignore`, `.plate/`, `COMMIT_MESSAGES.md`, `SKILL.md`,
  `implement.workflow.js`, `merge.workflow.js`, `plan.workflow.js`,
  `test.workflow.js`, `verify.workflow.js`). Not referenced by this brief.
  No action.
- `tests/blockerVerdicts.test.ts` — does not exist on disk (confirmed:
  `Read` errors, and `ls tests/` shows only `checkBlockers.test.ts` among
  blocker/commit-related names). No action.
- `tests/checkBlockers.test.ts` — exists, read in full. Exercises
  `scripts/checkBlockers.ts` only; no coupling to `COMMIT_MESSAGES.md`. No
  edit needed for this task.
- `skills/close-tasks/SKILL.md` line 22 — explicitly out of scope per the
  brief ("it emits a fixed 'Closed tasks [...]' message and uses no
  subagent"). Not in the owned-files list either. No action.

## New file: `skills/commit-message/SKILL.md`

Create the directory and file with this exact content:

```markdown
---
name: commit-message
description: generate a short commit-message summary for each git repo with staged changes, from the diff injected fresh at invocation
---

Staged diff, one section per affected repo (the current repo plus any submodule whose pointer moved):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): pass it the diffs above and have it generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
```

Notes on why this content is exact:

- Frontmatter has only `name`/`description`, matching the precedent in the
  owned file `skills/update-tasks/SKILL.md` (which also takes no
  `$ARGUMENTS` and so has no `argument-hint`, and needs no `allowed-tools`
  since it issues no direct Bash-tool call in its body — the same is true
  here: staging happens in the *callers*, not in this skill, so no
  `Bash(git add *)` entry is needed).
- The `!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`` line copies
  the exact shape the brief points at
  (`skills/create-task/SKILL.md`'s first-line `!`node
  "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`` injection).
- The four carried-over rules from the brief are preserved verbatim in
  substance: one message per affected repo, ≤40-word single-sentence
  summaries, a parent repo whose only staged change is a submodule pointer
  still counts as affected and must name the submodule and why, and the
  `Repo: <repo name>` / `Message: <summary>` output block, copied character
  for character from the old file's closing block (`skills/tackle-tasks/COMMIT_MESSAGES.md` lines 6–10).
- What is dropped from the old wording: "pass it the path of every repo or
  submodule in which the caller staged changes — not diff contents — and
  instruct it to run the collection itself, at the moment it starts: for
  each supplied repo path, run `git -C <repo> diff --staged ...`" is
  replaced by "pass it the diffs above" — the collection is now done
  structurally by the `!` injection before the subagent (or the agent
  reading the skill body) ever starts, so there is no longer an instruction
  for anyone to follow or forget.

## New file: `scripts/stagedDiffs.ts`

Create with this exact content:

```typescript
// stagedDiffs.ts: prints staged diffs for the root repo and any submodule with a moved pointer, at any depth.
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const EXCLUDES = ["--", ":(exclude)*tasks.json", ":(exclude)*completedTasks.json", ":(exclude)plans/archived"];

function stagedDiff(repo: string): string {
  return execFileSync("git", ["-C", repo, "diff", "--staged", ...EXCLUDES], { encoding: "utf8" });
}

function movedSubmodulePaths(repo: string): string[] {
  const raw = execFileSync("git", ["-C", repo, "diff", "--staged", "--raw", "-z", ...EXCLUDES], { encoding: "utf8" });
  const fields = raw.split("\0").filter(Boolean);
  const paths = new Set<string>();
  let i = 0;
  while (i < fields.length) {
    const [, newMode, , , status] = fields[i].split(" ");
    const isRenameOrCopy = status?.[0] === "R" || status?.[0] === "C";
    const path = isRenameOrCopy ? fields[i + 2] : fields[i + 1];
    i += isRenameOrCopy ? 3 : 2;
    if (newMode === "160000" && path) paths.add(path);
  }
  return [...paths];
}

const root = execFileSync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const seen = new Set<string>([root]);
const queue = [root];

while (queue.length > 0) {
  const repo = queue.shift()!;
  let diff: string;
  try {
    diff = stagedDiff(repo);
  } catch {
    continue;
  }
  if (diff.trim().length > 0) {
    const label = repo === root ? basename(root) : repo.slice(root.length + 1);
    process.stdout.write(`=== ${label} ===\n${diff}\n`);
  }
  for (const path of movedSubmodulePaths(repo)) {
    const submodule = `${repo}/${path}`;
    if (seen.has(submodule)) continue;
    seen.add(submodule);
    queue.push(submodule);
  }
}
```

Notes on why this is the exact, complete algorithm (no discovery left for
the implementer):

- The root is resolved with `git -C "${process.cwd()}" rev-parse
  --show-toplevel`, not `process.cwd()` directly, so the script produces
  correct labels and repo paths when invoked from a subdirectory of the
  repo (e.g. from the Stop hook, which may run from anywhere under the
  tree).
- The pathspec excludes are copied verbatim from the brief's quoted command:
  `git -C <repo> diff --staged -- ':(exclude)*tasks.json'
  ':(exclude)*completedTasks.json' ':(exclude)plans/archived'`.
- Submodule discovery follows the brief's rule ("treat any line whose old
  or new file mode is `160000` as a moved submodule pointer") narrowed to
  `newMode === "160000"` only: a line whose *old* mode is `160000` and new
  mode is not (a deleted or replaced gitlink) is a submodule that no longer
  exists at that path and must not be entered — its removal is already
  visible in that repo's own plain diff, so nothing is lost by not
  descending into it.
- Discovery uses `git -C <repo> diff --staged --raw -z -- <same excludes>`
  (NUL-delimited, not newline-delimited) because `-z` is the only mode that
  is safe for paths containing spaces, tabs, or other unusual characters —
  a plain-text `--raw` line cannot be split reliably in the general case.
  With `-z`, `git diff --raw` prints one NUL-terminated metadata record per
  changed path (`:<oldmode> <newmode> <oldsha> <newsha> <status>`), followed
  by one NUL-terminated path record, or — for a rename/copy (`status`
  starting with `R` or `C`) — two NUL-terminated path records (old path,
  then new/current path). The loop reads `fields[i]` as the metadata
  record, and consumes either 2 fields (metadata + path) or 3 fields
  (metadata + old path + new path) per iteration accordingly, always taking
  the *last* path field as the submodule's current location relative to
  `repo` — the one a follow-up `git -C <submodule> diff --staged` needs.
- **Traversal is a breadth-first queue seeded with the root, not a
  root-only scan.** Each queued `repo` is fully processed before the next:
  its plain staged diff is printed if non-empty, then its own raw diff is
  scanned for `160000` new-mode paths, each resolved as `${repo}/${path}`
  (beneath the repo that owns that pointer, not beneath the root), and any
  not already in the `seen` set is added to `seen` and pushed onto the
  queue. The loop ends only when the queue is empty. This is what makes a
  nested submodule — one whose pointer moved inside another submodule's own
  index rather than the root's — get discovered: the earlier root-only scan
  (`movedSubmodulePaths(root)` alone) only ever looked at the root's raw
  diff, so a submodule reachable only through another submodule's own
  staged pointer was never enumerated. The queue fixes that by re-running
  `movedSubmodulePaths` on every repo it visits, including submodules
  themselves.
- `seen` (not just the queue) is checked before enqueuing, so a path
  reachable by two different staged pointers is still visited once.
- Each `stagedDiff(repo)` call is wrapped in `try`/`catch`: if a discovered
  submodule path is not present on disk, or is present but is not itself a
  git repository (e.g. an uninitialized submodule after a fresh clone), `git
  -C <path> diff --staged` exits nonzero and `execFileSync` throws — the
  `catch` skips that repo (via `continue`, before `movedSubmodulePaths` is
  ever called on it) rather than aborting the whole script. The submodule
  pointer change itself is still visible because it is part of its parent
  repo's own plain staged diff, which is unaffected by a failure to enter
  the submodule directory. `movedSubmodulePaths(repo)` is only called after
  `stagedDiff(repo)` already succeeded, so it runs against a path already
  confirmed to be a working git repository and needs no separate `catch`.
- A repo (root or discovered submodule) is only printed if its plain staged
  diff is non-empty, matching "treating a repo as affected only if that
  command produces a nonempty diff." A repo can still be scanned for its own
  moved submodule pointers even when its own diff is empty (e.g. its only
  staged change is an excluded path) — printing and discovery are
  independent steps in the loop body.
- No CLI arguments are read or needed — the script is invoked with no
  arguments via the `!` injection in `skills/commit-message/SKILL.md`.
- `=== <label> ===` banners separate each repo's diff block, reusing the
  same banner convention already used elsewhere in this codebase (per the
  owned file `skills/update-tasks/SKILL.md` line 13: "each under a `===
  <file> ===` banner").

## New file: `tests/commitMessageSubagent.test.ts`

Create with this exact content:

```typescript
// commitMessageSubagent.test.ts: stagedDiffs.ts prints a staged-diff section per affected repo. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "stagedDiffs.ts");

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function commitFile(dir: string, relPath: string, contents: string): void {
  writeFileSync(join(dir, relPath), contents);
  execFileSync("git", ["add", relPath], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function stageFile(dir: string, relPath: string, contents: string): void {
  writeFileSync(join(dir, relPath), contents);
  execFileSync("git", ["add", relPath], { cwd: dir });
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "taskTools-stagedDiffs-"));
}

function run(cwd: string): string {
  return execFileSync("node", ["--no-inspect", SCRIPT], { cwd, encoding: "utf8" });
}

test("prints the root repo's staged diff, labeled with its basename", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  stageFile(root, "a.txt", "two\n");
  const out = run(root);
  const label = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${label} ===\n`));
  assert.match(out, /-one\n\+two/);
});

test("prints nothing when there is nothing staged", () => {
  const root = newRoot();
  initRepo(root);
  assert.equal(run(root), "");
});

test("excludes tasks.json, completedTasks.json, and plans/archived", () => {
  const root = newRoot();
  initRepo(root);
  mkdirSync(join(root, "plans", "archived"), { recursive: true });
  commitFile(root, "tasks.json", "[]");
  commitFile(root, "completedTasks.json", "[]");
  commitFile(root, "plans/archived/note.md", "old");
  commitFile(root, "keep.txt", "keep\n");
  stageFile(root, "tasks.json", "[1]");
  stageFile(root, "completedTasks.json", "[1]");
  stageFile(root, "plans/archived/note.md", "new");
  stageFile(root, "keep.txt", "changed\n");
  const out = run(root);
  assert.ok(!out.includes("tasks.json"));
  assert.ok(!out.includes("archived/note.md"));
  assert.ok(out.includes("keep.txt"));
});

test("resolves the root and labels correctly when invoked from a nested directory", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  stageFile(root, "a.txt", "two\n");
  const out = run(join(root, "nested", "deeper"));
  const label = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${label} ===\n`));
});

test("includes a submodule's diff once when its pointer was staged, labeled by its relative path, and handles a path with a space", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  const sub = join(root, "sub dir");
  initRepo(sub);
  commitFile(sub, "b.txt", "hello\n");
  execFileSync("git", ["add", "sub dir"], { cwd: root });
  stageFile(sub, "b.txt", "world\n");
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.ok(out.includes(`=== ${rootLabel} ===\n`));
  assert.ok(out.includes("=== sub dir ===\n"));
  assert.equal(out.split("=== sub dir ===").length - 1, 1);
});

test("skips a submodule whose pointer was removed, without erroring, and still prints the parent diff", () => {
  const root = newRoot();
  initRepo(root);
  const sub = join(root, "sub");
  initRepo(sub);
  commitFile(sub, "b.txt", "hello\n");
  execFileSync("git", ["add", "sub"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "add submodule pointer"], { cwd: root });
  execFileSync("git", ["rm", "-q", "--cached", "sub"], { cwd: root });
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${rootLabel} ===\n`));
  assert.ok(!out.includes("=== sub ===\n"));
});

test("does not abort and still prints the parent diff when a staged submodule pointer has no repo on disk", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  execFileSync(
    "git",
    ["update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,ghost"],
    { cwd: root },
  );
  stageFile(root, "a.txt", "two\n");
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.ok(out.startsWith(`=== ${rootLabel} ===\n`));
  assert.ok(!out.includes("=== ghost ===\n"));
});

test("includes a nested submodule's diff, discovered via its parent submodule's own staged pointer, and each repo appears once", () => {
  const root = newRoot();
  initRepo(root);
  commitFile(root, "a.txt", "one\n");
  const sub = join(root, "sub");
  initRepo(sub);
  commitFile(sub, "b.txt", "hello\n");
  const nested = join(sub, "nested");
  initRepo(nested);
  commitFile(nested, "c.txt", "hi\n");
  stageFile(nested, "c.txt", "bye\n");
  execFileSync("git", ["add", "nested"], { cwd: sub });
  execFileSync("git", ["add", "sub"], { cwd: root });
  const out = run(root);
  const rootLabel = root.split("/").pop();
  assert.equal(out.split(`=== ${rootLabel} ===`).length - 1, 1);
  assert.equal(out.split("=== sub ===").length - 1, 1);
  assert.equal(out.split("=== sub/nested ===").length - 1, 1);
});
```

The last test covers all three scenarios codex's review required in one
place: a root repository (`root`), a moved first-level submodule pointer
(`sub`, staged directly into the root's index), and a moved
nested-submodule pointer (`nested`, staged only into `sub`'s own index,
never touching the root's raw diff) — asserting all three are emitted
exactly once. `sub`'s own staged diff is non-empty because adding `nested`
as a gitlink is itself a change recorded in `sub`'s plain diff, so `sub`
qualifies as affected independent of `root`; this is what proves the queue
visits repos discovered at any depth, not just the root's direct children.

Every scenario above was run by hand against this exact script during
planning (temp git repos, real `node --no-inspect` invocations, Node
v26.6.0) and each assertion matches the output actually observed — this is
not untested guesswork. The full suite (all 8 tests together, against the
rewritten queue-based script) was also run as one file and passed 8/8.

## Edit: `skills/tackle-tasks/SKILL.md` (lines 137–141)

Current text (read in full; this is the file's last section):

```
## Commit message

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`
```

Becomes:

```
## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the `commit-message` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
```

Why the staging sentence is added here (not just a bare repoint): the old
`COMMIT_MESSAGES.md` opened with "stage the changes in each affected repo,
but do not commit in any of them" — that sentence supplied the *only*
staging instruction in this file's commit-message flow (the file's
`allowed-tools: Bash(git add *), Bash(node *)` frontmatter, unchanged by
this task, already grants the permission this sentence needs). Under the
new design the diff is captured by the `!` injection inside
`skills/commit-message/SKILL.md` *before* the agent reads any of that
skill's body text — so staging must happen as a step the calling agent
takes before invoking the skill, or the injected diff would be empty by
construction. `skills/update-tasks/SKILL.md` already models this correctly
(see its unchanged line 26: "Stage the changes but do not commit." ahead of
its own commit-message reference) — this edit brings
`skills/tackle-tasks/SKILL.md` in line with that same pattern using the old
file's own staging wording.

## Edit: `scripts/stage-and-summarize-stop.ts`

Edit 1 — line 4, current text:

```typescript
import { dirname, join, resolve } from "node:path";
```

Becomes:

```typescript
import { dirname, join } from "node:path";
```

(`resolve` becomes unused once the block below is removed; `dirname` is
still used at line 22 in the porcelain check, `join` is still used at line
12 for the flag path.)

Edit 2 — lines 35–45, current text:

```typescript
const instructionsPath = resolve(
  import.meta.dirname, "..", "skills", "tackle-tasks", "COMMIT_MESSAGES.md",
);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      `Files were changed, read ${instructionsPath} and follow those directions.`,
  },
}));
```

Becomes:

```typescript
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      "Files were changed. Stage the changes made this session in each affected repo or submodule, but do not commit; then invoke the commit-message skill.",
  },
}));
```

This hook fires specifically because `unstaged` is `true` — i.e. because
session files remain unstaged at Stop. Naming only the skill here (as an
earlier draft of this plan did) would have the agent invoke `commit-message`
with nothing staged: skill-body `!` injection runs at invocation time, so
`stagedDiffs.ts` would see an empty staged diff and the subagent would have
nothing to summarize. The staging clause has to survive in this
`additionalContext` string itself, not just in the callers that already
stage before invoking the skill (`tackle-tasks/SKILL.md`,
`update-tasks/SKILL.md`) — this hook is a third, independent entry point
into the same skill, and it is the one entry point that fires precisely
because staging did not already happen. The wording matches the brief's
explicit instruction that "a Stop hook cannot invoke a skill directly, so it
must name the skill for the agent to invoke instead of naming a file to
read," plus the staging step that instruction alone would otherwise omit.

## Edit: `skills/update-tasks/SKILL.md` (line 27)

Current text:

```
Stage the changes but do not commit. Follow `skills/tackle-tasks/COMMIT_MESSAGES.md` to generate a commit-message summary for each affected repo, and show the summaries to the user.
```

Becomes:

```
Stage the changes but do not commit. Invoke the `commit-message` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
```

Only the middle clause changes (`Follow \`...COMMIT_MESSAGES.md\`` →
`Invoke the \`commit-message\` skill`); the leading staging sentence and
trailing clause are untouched.

## Delete: `skills/tackle-tasks/COMMIT_MESSAGES.md`

Delete the file once the three edits above land — at that point no
reference to it survives (the brief itself enumerates exactly these three
call sites as "The three call sites are:", and explicitly rules out
`skills/close-tasks/SKILL.md` line 22 as out of scope, so this list is
exhaustive per the brief).

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. New files exist:
   `test -f skills/commit-message/SKILL.md && test -f scripts/stagedDiffs.ts && echo OK`
   → expect `OK`.

2. Old file is gone:
   `test ! -f skills/tackle-tasks/COMMIT_MESSAGES.md && echo DELETED`
   → expect `DELETED`.

3. No reference to the old filename survives anywhere in the repo, other
   than in this plan and its brief (which quote it while describing the
   change):
   `rg -n "COMMIT_MESSAGES" . --glob '!plans/brief-62.md' --glob '!plans/task-62-plan.md'`
   → expect no output (empty, exit code 1).

4. Each of the three call sites now names the new skill:
   `rg -n "commit-message" skills/tackle-tasks/SKILL.md skills/update-tasks/SKILL.md scripts/stage-and-summarize-stop.ts`
   → expect one match in each of the three files.

5. `resolve` is no longer imported or used in the stop hook:
   `rg -n "resolve" scripts/stage-and-summarize-stop.ts`
   → expect no output.

6. `scripts/stagedDiffs.ts` runs and prints a diff for a repo with a staged
   change:
   ```
   d=$(mktemp -d) && cd "$d" && git init -q && echo hi > a.txt && git add a.txt \
     && bun "/Users/matkatmusicllc/Programming/taskTools/scripts/stagedDiffs.ts"
   ```
   → expect output starting with `=== <basename of $d> ===` followed by a
   unified diff containing `+hi`.

7. `scripts/stagedDiffs.ts` prints nothing when there is nothing staged:
   ```
   d=$(mktemp -d) && cd "$d" && git init -q \
     && bun "/Users/matkatmusicllc/Programming/taskTools/scripts/stagedDiffs.ts"
   ```
   → expect empty output.

8. `skills/commit-message/SKILL.md` has valid frontmatter and the injection
   line:
   `rg -n '^name: commit-message$|stagedDiffs.ts' skills/commit-message/SKILL.md`
   → expect two matches.

9. The full multi-repo, exclusion, subdirectory, nested-submodule, and
   removed/unavailable submodule behavior of `scripts/stagedDiffs.ts`
   passes:
   `node --test tests/commitMessageSubagent.test.ts`
   → expect all 8 tests to pass, 0 failures.
