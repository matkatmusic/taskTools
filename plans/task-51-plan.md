# Task 51 Plan: Route legacy manifests to a non-destructive refusal with recovery instructions

## Why (context, not instructions)

`scripts/legacyManifest.ts` and `tests/legacyManifest.test.ts` already exist — their
current on-disk content is byte-for-byte what the brief quotes. `checkLegacyManifest()`
is already implemented and already tested in isolation (5 passing tests, verified
below), but its `recoveryCommands` are generic — they never name the specific
worktree(s) the refused manifest points at. The brief's test requirement ("its
recovery instructions name the affected worktree") is not yet met. This plan makes
`recoveryCommands` include the manifest's own `checkoutPath`(s), and wires
`scripts/mergeTaskWorktrees.ts`'s `runAsCli()` to call `checkLegacyManifest` (nothing
in `runAsCli()` calls it today).

`runAsCli()` has four branches: `--discover` (builds fresh discovery data, no
manifest input), `--merge <worktreePath>` (takes a bare path string, no manifest),
`--run <preparedFile> [outcomesFile]` (parses a manifest JSON file from disk), and
the fallback/default branch (parses a manifest JSON string from `process.argv[2]`).
Only the last two branches consume a manifest-shaped object before handing it to
`runMergePipeline`, so only those two get a `checkLegacyManifest` gate.

Confirmed safe against regressions: git history (`git log --follow -- scripts/prepareTasks.ts`)
shows commit `06f616e` "task 48: thread real repository manifest through prepareTasks
...", meaning the manifest objects `prepareTasks.ts` already produces — and that
`mergeTaskWorktrees.ts --run`/default already receive — carry the current
`REPOSITORY_MANIFEST_VERSION`-stamped shape from `repositoryManifest.ts` (commit
`853a757`, "task 2: add repositoryManifest.ts data module"). So `checkLegacyManifest`
will return `{ ok: true }` (pass-through, per `test_currentVersionManifestPassesThroughUnchanged`)
for every manifest the current pipeline already produces, and the 18 currently-passing
tests in `tests/mergeTaskWorktrees.test.ts` (baseline run below) are unaffected.

Refusal reporting mirrors the file's own existing error-reporting convention at the
bottom of the file (`process.stderr.write(...); process.exitCode = 1;` inside the
`runAsCli().catch(...)` handler) rather than inventing a new convention.

## File-by-file plan

### scripts/legacyManifest.ts — one edit

**Replace the fixed `RECOVERY_COMMANDS` constant with a function that names the
manifest's own worktree checkout paths.**

Current text (lines 1-58, the full file):
```
// Detects flat-model (pre-version) run manifests and refuses to proceed, non-destructively.
import { REPOSITORY_MANIFEST_VERSION } from "./repositoryManifest.ts";

export interface LegacyManifestRefusal {
    ok: false;
    detectedVersion: number | undefined; // undefined = versionless manifest
    reason: string;
    recoveryCommands: string[];
}

export interface LegacyManifestPass {
    ok: true;
}

export type LegacyManifestCheck = LegacyManifestRefusal | LegacyManifestPass;

const RECOVERY_COMMANDS = [
    "inspect the worktrees listed in this manifest manually before rerunning",
    "run `git worktree list` in the repository to see what checkouts still exist",
    "run `git branch --list` to see what operation branches still exist",
];

export function checkLegacyManifest(manifest: unknown): LegacyManifestCheck {
    const version = (manifest as { version?: number } | null | undefined)?.version;

    if (version === undefined || version === null) {
        return {
            ok: false,
            detectedVersion: undefined,
            reason: "manifest predates version tracking (flat repository-path model)",
            recoveryCommands: RECOVERY_COMMANDS,
        };
    }

    if (version < REPOSITORY_MANIFEST_VERSION) {
        return {
            ok: false,
            detectedVersion: version,
            reason: `manifest version ${version} is older than current version ${REPOSITORY_MANIFEST_VERSION}`,
            recoveryCommands: RECOVERY_COMMANDS,
        };
    }

    return { ok: true };
}
```

Becomes:
```
// Detects flat-model (pre-version) run manifests and refuses to proceed, non-destructively.
import { REPOSITORY_MANIFEST_VERSION } from "./repositoryManifest.ts";

export interface LegacyManifestRefusal {
    ok: false;
    detectedVersion: number | undefined; // undefined = versionless manifest
    reason: string;
    recoveryCommands: string[];
}

export interface LegacyManifestPass {
    ok: true;
}

export type LegacyManifestCheck = LegacyManifestRefusal | LegacyManifestPass;

function checkoutPathsOf(manifest: unknown): string[] {
    const repositories = (manifest as { repositories?: Array<{ checkoutPath?: unknown }> } | null | undefined)?.repositories;
    if (!Array.isArray(repositories)) return [];
    return repositories
        .map((repository) => repository?.checkoutPath)
        .filter((checkoutPath): checkoutPath is string => typeof checkoutPath === "string");
}

function recoveryCommandsFor(manifest: unknown): string[] {
    const worktreeCommands = checkoutPathsOf(manifest).map(
        (checkoutPath) => `inspect the worktree at ${checkoutPath} manually before rerunning`,
    );
    return [
        ...worktreeCommands,
        "run `git worktree list` in the repository to see what checkouts still exist",
        "run `git branch --list` to see what operation branches still exist",
    ];
}

export function checkLegacyManifest(manifest: unknown): LegacyManifestCheck {
    const version = (manifest as { version?: number } | null | undefined)?.version;

    if (version === undefined || version === null) {
        return {
            ok: false,
            detectedVersion: undefined,
            reason: "manifest predates version tracking (flat repository-path model)",
            recoveryCommands: recoveryCommandsFor(manifest),
        };
    }

    if (version < REPOSITORY_MANIFEST_VERSION) {
        return {
            ok: false,
            detectedVersion: version,
            reason: `manifest version ${version} is older than current version ${REPOSITORY_MANIFEST_VERSION}`,
            recoveryCommands: recoveryCommandsFor(manifest),
        };
    }

    return { ok: true };
}
```

Notes for the implementer, already resolved:
- The legacy manifest shape is `{ repositories: [{ checkoutPath, operationBranch }, ...] }`
  (this is exactly the shape `tests/legacyManifest.test.ts`'s existing
  `test_refusalDoesNotDeleteWorktreeOrBranch` already constructs). `checkoutPathsOf`
  reads `manifest.repositories[].checkoutPath` and silently skips anything that
  isn't an array or isn't a string — malformed/absent `repositories` just yields no
  worktree-specific lines, falling back to the two generic commands, which keeps
  `test_rejectionResultNamesRecoveryCommands` (which passes `{ occurrences: [] }`,
  no `repositories` field) passing unchanged.
- Do not change the two `reason` strings or either `detectedVersion` value — only
  `recoveryCommands` changes.

### tests/legacyManifest.test.ts — two edits

**Edit 1 — add the imports the new test needs.**

Current text (lines 1-8):
```
// Behavioral checks for legacyManifest.ts: refusal of pre-version manifests, non-destructive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLegacyManifest } from "../scripts/legacyManifest.ts";
```

Becomes:
```
// Behavioral checks for legacyManifest.ts: refusal of pre-version manifests, non-destructive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLegacyManifest } from "../scripts/legacyManifest.ts";
```

**Edit 2 — append a new end-to-end CLI test, after `test_refusalDoesNotDeleteWorktreeOrBranch`
and before `test_currentVersionManifestPassesThroughUnchanged`.**

Current text (the boundary between the two existing tests):
```
    assert.equal(result.ok, false);
    assert.equal(existsSync(worktreePath), true);
    const branches = git(repoRoot, "branch", "--list", "task-group-1");
    assert.ok(branches.includes("task-group-1"));
});

test("test_currentVersionManifestPassesThroughUnchanged", () => {
```

Becomes:
```
    assert.equal(result.ok, false);
    assert.equal(existsSync(worktreePath), true);
    const branches = git(repoRoot, "branch", "--list", "task-group-1");
    assert.ok(branches.includes("task-group-1"));
});

test("test_cliRefusalNamesAffectedWorktreeAndSurvivesOnDisk", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "legacy-manifest-cli-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    git(repoRoot, "commit", "-q", "--allow-empty", "-m", "seed");
    const worktreePath = join(repoRoot, "worktree-1");
    git(repoRoot, "worktree", "add", "-q", "-b", "task-group-1", worktreePath);

    const manifestPath = join(repoRoot, "manifest.json");
    writeFileSync(
        manifestPath,
        JSON.stringify({ repositories: [{ checkoutPath: worktreePath, operationBranch: "task-group-1" }] }),
    );

    const scriptPath = join(process.cwd(), "scripts", "mergeTaskWorktrees.ts");
    const result = spawnSync("bun", [scriptPath, "--run", manifestPath], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(worktreePath));
    assert.equal(existsSync(worktreePath), true);
    const branches = git(repoRoot, "branch", "--list", "task-group-1");
    assert.ok(branches.includes("task-group-1"));
    const worktrees = git(repoRoot, "worktree", "list");
    assert.ok(worktrees.includes(worktreePath));
});

test("test_currentVersionManifestPassesThroughUnchanged", () => {
```

Notes for the implementer, already resolved:
- `scriptPath` is built from `process.cwd()`, not from `repoRoot` — the spawned
  `bun` process's own cwd stays the test runner's cwd (the taskTools repo root, per
  the "Run from" line at the top of Verification below), so `bun`'s module resolver
  finds the real `scripts/mergeTaskWorktrees.ts`. The manifest still points at the
  tmp-repo worktree via `checkoutPath`, and `--run` in `mergeTaskWorktrees.ts` never
  changes its own working directory, so this is independent of `repoRoot`.
- `result.stderr` is asserted to contain the literal `worktreePath` string — this is
  what proves the brief's "recovery instructions name the affected worktree"
  requirement end to end through the actual CLI, not just through
  `checkLegacyManifest` in isolation.
- `result.status` (not `result.error`) is asserted non-zero: `spawnSync` only sets
  `.error` when the subprocess itself fails to launch; a normal exit with
  `process.exitCode = 1` shows up as `status: 1`.

### scripts/mergeTaskWorktrees.ts — two edits

**Edit 1 — add the import.**

Current text (lines 6-7):
```
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
```

Becomes:
```
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { checkLegacyManifest, type LegacyManifestRefusal } from "./legacyManifest.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
```

(`WorkflowArguments` stays exactly as it already is — it is a pre-existing unused
import, out of this task's scope, and is not touched or newly used by this plan.)

**Edit 2 — insert the reporting helper, immediately before `runAsCli`.**

Current text (lines 186-190):
```
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

async function runAsCli(): Promise<void> {
```

Becomes:
```
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

function reportLegacyManifestRefusal(refusal: LegacyManifestRefusal): void {
    process.stderr.write(`${refusal.reason}\n`);
    for (const command of refusal.recoveryCommands) process.stderr.write(`  - ${command}\n`);
    process.exitCode = 1;
}

async function runAsCli(): Promise<void> {
```

**Edit 3 — gate the `--run` branch and the fallback branch on `checkLegacyManifest`.**

Current text (lines 200-208, the full remaining body of `runAsCli`):
```
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        await runMergePipeline({ ...prepared, ...outcomes });
        return;
    }
    await runMergePipeline(JSON.parse(process.argv[2]));
}
```

Becomes:
```
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const legacyCheck = checkLegacyManifest(prepared);
        if (!legacyCheck.ok) {
            reportLegacyManifestRefusal(legacyCheck);
            return;
        }
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        await runMergePipeline({ ...prepared, ...outcomes });
        return;
    }
    const manifest = JSON.parse(process.argv[2]);
    const legacyCheck = checkLegacyManifest(manifest);
    if (!legacyCheck.ok) {
        reportLegacyManifestRefusal(legacyCheck);
        return;
    }
    await runMergePipeline(manifest);
}
```

Notes for the implementer, already resolved (no further judgment needed):
- `prepared` and `manifest` stay untyped (implicit `any` from `JSON.parse`), exactly
  as they already are today — do not add a `WorkflowArguments` cast; `checkLegacyManifest`
  takes `unknown` and `any` satisfies that with no cast required.
- The two `const legacyCheck` declarations do not collide: the first is scoped
  inside the `if (mode === "--run") { ... }` block and that block always `return`s
  before control reaches the second declaration.
- Do not touch `--discover` or `--merge` — neither consumes a manifest object.
- On refusal, `runMergePipeline` is never called and no `git` command runs on that
  path — this is what makes the refusal non-destructive (worktrees/branches referenced
  by a refused manifest are left completely alone).
- Do not remove or otherwise touch the unused `rmSync` import in the `node:fs`
  import line — it is out of this task's scope.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `bun test tests/legacyManifest.test.ts`
   Baseline (already measured, pre-edit): `5 pass`, `0 fail`.
   Expected after the edit: `6 pass`, `0 fail` — the 5 existing tests still pass
   (the new `recoveryCommandsFor` still returns non-empty commands for
   `{ occurrences: [] }`, and the existing worktree-survival test is unaffected),
   plus the new `test_cliRefusalNamesAffectedWorktreeAndSurvivesOnDisk`.

2. `bun test tests/mergeTaskWorktrees.test.ts`
   Baseline (already measured, pre-edit): `18 pass`, `0 fail`.
   Expected after the edit: unchanged — `18 pass`, `0 fail` (the manifests these
   tests exercise already carry the current `version`, so `checkLegacyManifest`
   passes them through per the reasoning above).

3. `bunx tsc --noEmit -p tsconfig.json`
   Baseline (already measured, pre-edit): no output, exit code 0.
   Expected after the edit: no output, exit code 0 (the new code only calls
   already-exported, already-typed functions: `checkLegacyManifest`, and the new
   `reportLegacyManifestRefusal` helper typed against the already-exported
   `LegacyManifestRefusal` interface).

4. Manual non-destructive-refusal smoke check (optional cross-check; step 1's new
   `test_cliRefusalNamesAffectedWorktreeAndSurvivesOnDisk` already covers this
   automatically):
   ```
   tmp=$(mktemp -d)
   git init -q "$tmp"
   git -C "$tmp" config user.email test@example.com
   git -C "$tmp" config user.name Test
   git -C "$tmp" commit -q --allow-empty -m seed
   git -C "$tmp" worktree add -q -b task-group-1 "$tmp/worktree-1"
   echo '{"repositories":[{"checkoutPath":"'"$tmp"'/worktree-1","operationBranch":"task-group-1"}]}' > "$tmp/manifest.json"
   bun scripts/mergeTaskWorktrees.ts --run "$tmp/manifest.json"; echo "exit:$?"
   test -d "$tmp/worktree-1" && echo "worktree still present"
   git -C "$tmp" branch --list task-group-1
   ```
   Expected: the command prints the refusal reason
   (`manifest predates version tracking (flat repository-path model)`) to stderr,
   followed by a recovery-command line naming `$tmp/worktree-1` and the two generic
   recovery-command lines, `exit:1`, `worktree still present` is printed, and
   `git branch --list task-group-1` still shows `task-group-1` — nothing was
   removed, reset, or force-checked-out.
