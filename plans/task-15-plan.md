# Task 15 Plan: `scripts/occurrenceTreeDelta.ts`

Phase 2 of the recursive repository-discovery redesign. New module only, no
production call sites yet.

## Ladder check

- Reimplement a diff/status engine? No — git already computes exactly this
  (`git diff --raw`, `git ls-files`, `git hash-object`). Shell out to the git
  binary that's already a hard dependency of this repo. Rung 4/5.
- Reimplement `.gitignore` matching? No — `--exclude-standard` on
  `git ls-files` already does it natively.
- Reimplement glob-exclude for "generated output"? No — git pathspec magic
  (`:(exclude)pattern`) does this natively for both tracked and untracked
  listings; pass caller-supplied patterns straight through as pathspecs.
- Bake in a default list of "generated" dirs (`dist/`, `node_modules/`, …)?
  No — this module has no idea what any given occurrence generates. Take
  `excludePatterns` as a caller-supplied option, default `[]`. Don't guess.
- Discover nested occurrence paths itself? No — that's phase-1 discovery's
  job. Take `nestedOccurrencePaths` as a caller-supplied option.

## Interface

```ts
export interface ComputeOccurrenceTreeDeltaOptions {
  occurrencePath: string;        // absolute path to the occurrence's working tree
  baseRef: string;                // git ref/sha the delta is measured against
  nestedOccurrencePaths?: string[]; // paths (relative to occurrencePath) to exclude
  excludePatterns?: string[];     // extra git pathspec exclude patterns (e.g. "dist/**")
}

export type TreeChangeKind =
  | 'added' | 'modified' | 'deleted' | 'renamed'
  | 'mode-changed' | 'symlink' | 'untracked';

export interface TreeChange {
  path: string;
  kind: TreeChangeKind;
  oldPath?: string;   // renames only
  oldMode?: string;
  newMode?: string;
}

export interface OccurrenceTreeDelta {
  occurrencePath: string;
  baseRef: string;
  changes: TreeChange[];
  digest: string;      // sha256 hex, order-independent identity of the tree
}

export async function computeOccurrenceTreeDelta(
  options: ComputeOccurrenceTreeDeltaOptions
): Promise<OccurrenceTreeDelta>;
```

## Approach

All git calls run with `cwd: occurrencePath` via `Bun.$`. Pathspec suffix
built once from options:

```
const excludeSpec = [...nestedOccurrencePaths, ...excludePatterns]
  .map(p => `:(exclude)${p}`);
```

Passed as trailing args to every `git diff` / `git ls-files` call so nested
occurrences and caller-declared generated paths never appear in either the
change list or the digest input. `.git` itself is never listed by these git
commands, so no explicit exclusion is needed there.

### 1. Tracked changes — `git diff --raw -M <baseRef> -- . <excludeSpec>`

Comparing a commit (no `--cached`) to the working tree picks up both staged
and unstaged changes, but not untracked files — exactly the "tracked"
half of the brief.

Parse each raw line `:<oldMode> <newMode> <oldSha> <newSha> <status>\t<path>`
(rename lines carry two path fields). Classify with this priority:

1. `oldMode === '120000' || newMode === '120000'` → `symlink`
   (git stores a symlink's target as the blob content, so this single git
   feature already covers "symlink added", "symlink modified", and "target
   changed" — no separate cases to write).
2. status starts with `R` → `renamed` (`oldPath`/`path` both set).
3. `oldSha === newSha && oldMode !== newMode` → `mode-changed`
   (content byte-identical, only the mode bit moved — this is git's own
   signal for "content unchanged but chmod'd", including the exec bit).
4. status `A` → `added`.
5. status `D` → `deleted`.
6. otherwise (`M`, `T`, …) → `modified`.

### 2. Untracked additions — `git ls-files --others --exclude-standard -- . <excludeSpec>`

`--exclude-standard` applies `.gitignore`/`.git/info/exclude` natively, so
ignored files are already absent — no extra "ignored" filtering to write.
Each listed path becomes a `TreeChange` with `kind: 'untracked'`.

### 3. Digest

Build the current inclusion set the same way (tracked, via
`git ls-files -s -- . <excludeSpec>`, which yields `<mode> <sha> <path>`
directly; plus untracked, hashed with `git hash-object <path>` — same blob
sha algorithm git would use if the file were added, so a byte, a mode, or
(for symlinks, since git blobs a symlink's target string) a symlink target
all change the sha deterministically). Sort by `path`, join as
`${mode} ${sha} ${path}\n`, sha256 the result → `digest`. No custom hashing
of file bytes needed anywhere; git's own blob sha does it.

## Implementation steps

1. Write `scripts/occurrenceTreeDelta.ts` with the types above and
   `computeOccurrenceTreeDelta`, using `Bun.$` for all git invocations.
2. Small private helpers: `buildExcludeSpec()`, `parseRawDiffLine()`,
   `classify()`, `buildDigest()`. Keep the file under ~150 lines; split
   parsing into a sibling module only if it grows past the 250-line cap.
3. No changes to any existing file — this is a net-new module.

## Tests — `tests/occurrenceTreeDelta.test.ts`

Each test creates a throwaway git repo in `mkdtempSync(os.tmpdir())`,
`git init`, an initial commit as `baseRef`, then mutates the working tree
before calling `computeOccurrenceTreeDelta`. Use `bun:test`
(`beforeEach`/`afterEach` for tmp dir setup/teardown — matches existing
project test style, no new dependency).

- **added**: stage a new file (`git add`, uncommitted) → one change,
  `kind: 'added'`.
- **modified**: edit an existing tracked file's bytes, unstaged → one
  change, `kind: 'modified'`.
- **deleted**: remove a tracked file → one change, `kind: 'deleted'`.
- **renamed**: `git mv` a tracked file and stage it → one change,
  `kind: 'renamed'`, `oldPath` set.
- **mode-changed**: `chmod +x` a tracked file with no byte change →
  `kind: 'mode-changed'`, old/new mode differ, sha unchanged.
- **symlink**: add a tracked symlink → `kind: 'symlink'`.
- **untracked**: create a new file, do not `git add` → `kind: 'untracked'`.
- **nested occurrence exclusion**: add/modify files under a subdirectory
  passed in `nestedOccurrencePaths` → absent from `changes` and absent from
  the digest input.
- **ignored exclusion**: `.gitignore` a pattern, create a matching
  untracked file → absent from `changes`.
- **generated-output exclusion**: pass `excludePatterns: ['dist/**']`,
  modify a *tracked* file under `dist/` → absent from `changes` (proves
  `excludePatterns` works independently of `.gitignore`, which can't hide
  tracked files).
- **digest equality**: two separate tmp repos with byte-identical trees
  (same paths, content, modes) → equal `digest`.
- **digest inequality — mode**: same content, one occurrence has a file
  `chmod +x` → digests differ.
- **digest inequality — symlink target**: same symlink path, different
  target string → digests differ.
- **digest inequality — byte**: one byte differs in one file → digests
  differ.

## Open questions / assumptions (flag, don't block)

- "Recorded base" is treated as an opaque `baseRef` string supplied by the
  caller; this module doesn't read or resolve where it's stored — that's
  whichever phase records it (not this task, no file for it exists yet).
- No default `excludePatterns` — brief doesn't name specific generated
  paths for this codebase, so nothing is guessed. Add one only when a real
  call site needs it.
