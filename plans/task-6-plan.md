# Task 6 Plan: Base-branch candidate matching by exact tip OID

## Source
Brief: `plans/brief-6.md`. Phase 1 of the recursive repository-discovery redesign.
Both target files are confirmed missing from disk — this is pure new-module creation, no existing code to reconcile.

## Assumptions (stated because this plan was written without reading the rest of the repo)
- Runtime is `bun` (per user's global CLAUDE.md preference: "bun is installed — prefer over node/npm"). Test file uses `bun:test`. If the implementer finds the repo's other files under `tests/` use a different runner, swap only the import line in the test file — the test bodies and production module are runner-agnostic.
- "Branch refs" means local branches (`refs/heads/*`), not remote-tracking branches — the brief's own language ("every branch whose tip OID...") and the phase's framing (a repo "checked out at a recorded OID") both point at local branches, not `refs/remotes/*`.
- No git library dependency exists/is needed — shelling out to `git for-each-ref` via Node's stdlib `child_process` (works identically under bun) is the whole implementation. This satisfies ponytail rung 5 (already-installed capability, not a new dependency) and rung 3 (stdlib process spawning).
- OID comparison is exact full-string equality. No abbreviation/short-OID resolution — brief explicitly forbids fuzzy matching.

## Behavior, in plain English
Given a repository directory and a single recorded commit OID:
1. List every local branch in that repo together with the OID its tip currently points at.
2. Keep only the branches whose tip OID is byte-for-byte equal to the recorded OID. A branch whose tip is a **descendant** of the recorded OID (i.e. merely contains it in history) is not kept — there is no ancestry check anywhere in this function.
3. Report exactly one of three outcomes:
   - exactly one branch kept → `{ kind: "single", baseBranch: <name> }`
   - zero branches kept → `{ kind: "none", candidates: [] }`
   - two or more branches kept → `{ kind: "multiple", candidates: <names, deterministic order> }`
4. Zero and multiple are not thrown errors — both are valid return values for a downstream resolution-request module to turn into a question later (not part of this task).

Determinism for the `multiple` case comes for free by asking git for refs pre-sorted by refname (`--sort=refname`), so branch order in the result is always alphabetical by branch name.

## Identifiers
- Module: `scripts/baseBranchResolution.ts`
- Exported type: `BaseBranchResolution`
- Exported function: `resolveBaseBranchCandidates(repoPath: string, recordedOid: string): BaseBranchResolution`
- Internal helper: `listLocalBranchTips(repoPath: string): { branchName: string; tipOid: string }[]`
- Test file: `tests/baseBranchResolution.test.ts`
- Test helpers (test file only, self-contained — do not import from production code or other test files): `createTempGitRepo`, `runGitCommand`, `commitNewFile`, `createBranchAtCurrentHead`

## Order of implementation (strict red-green TDD)

### Step 1 — RED: write the failing test file first
Create `tests/baseBranchResolution.test.ts` with the full content in the "Test file content" section below. Run it once to confirm it fails only because `scripts/baseBranchResolution.ts` does not exist yet (import error), not because of a typo in the test itself.

### Step 2 — GREEN: write the minimum production code
Create `scripts/baseBranchResolution.ts` with the full content in the "Production file content" section below. Re-run the test file; all four tests must pass with zero modification to the test file.

### Step 3 — Verify
Run `bun test tests/baseBranchResolution.test.ts` and confirm 4 passing tests, 0 failing. Do not wire this module into any other call site — the brief is explicit that this task stops at "new module only."

## Test file content
Each test creates its own throwaway git repo under the OS temp dir and removes it in `afterEach`, so tests do not share state and can run in any order.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBaseBranchCandidates } from "../scripts/baseBranchResolution";

function runGitCommand(repoPath: string, args: string[]): string {
    const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function createTempGitRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "base-branch-resolution-"));
    runGitCommand(repoPath, ["init", "--initial-branch=main"]);
    runGitCommand(repoPath, ["config", "user.email", "test@example.com"]);
    runGitCommand(repoPath, ["config", "user.name", "Test"]);
    return repoPath;
}

function commitNewFile(repoPath: string, fileName: string): string {
    runGitCommand(repoPath, ["commit", "--allow-empty", "-m", fileName]);
    return runGitCommand(repoPath, ["rev-parse", "HEAD"]);
}

function createBranchAtCurrentHead(repoPath: string, branchName: string): void {
    runGitCommand(repoPath, ["branch", branchName]);
}

describe("resolveBaseBranchCandidates", () => {
    let repoPath: string;

    beforeEach(() => {
        repoPath = createTempGitRepo();
    });

    afterEach(() => {
        rmSync(repoPath, { recursive: true, force: true });
    });

    test("test_singleBranchTipMatchingRecordedOidYieldsSoleMatch", () => {
        // Scenario: exactly one branch tip equals the recorded OID.  Steps: a repo has one commit on "main".
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // no other branch is created.  resolving candidates against that commit's OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report exactly one match: "main".
        expect(result).toEqual({ kind: "single", baseBranch: "main" });
    });

    test("test_twoBranchesAtSameCommitYieldBothInDeterministicOrder", () => {
        // Scenario: two branches point at the same commit.  Steps: a repo has one commit on "main".
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // a second branch "release" is created pointing at that same commit.
        createBranchAtCurrentHead(repoPath, "release");
        // resolving candidates against that shared OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report both branches, sorted by name.
        expect(result).toEqual({ kind: "multiple", candidates: ["main", "release"] });
    });

    test("test_ancestorOidNotAnyBranchTipYieldsZeroMatches", () => {
        // Ancestor OID, not any branch tip, must yield zero matches.  a repo has a first commit (the recorded OID).
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // a second commit is made on "main", moving its tip past the recorded OID.
        commitNewFile(repoPath, "second.txt");
        // resolving candidates against the ancestor OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report zero matches, since no branch tip equals the recorded OID.
        expect(result).toEqual({ kind: "none", candidates: [] });
    });

    test("test_branchContainingButNotAtRecordedOidIsExcludedFromMatches", () => {
        // "base" tip equals recorded OID; "main" merely contains it, further ahead.
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // a "base" branch is created pointing at that exact commit.
        createBranchAtCurrentHead(repoPath, "base");
        // "main" then advances past it with a second commit.
        commitNewFile(repoPath, "second.txt");
        // resolving candidates against the recorded OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report only "base" as the sole match.
        expect(result).toEqual({ kind: "single", baseBranch: "base" });
        // "main" must never appear, even though it contains the recorded commit in its history.
        if (result.kind === "single") {
            expect(result.baseBranch).not.toBe("main");
        }
    });
});
```

## Production file content

```ts
import { spawnSync } from "node:child_process";

export type BaseBranchResolution =
    | { kind: "single"; baseBranch: string }
    | { kind: "none"; candidates: [] }
    | { kind: "multiple"; candidates: string[] };

function listLocalBranchTips(repoPath: string): { branchName: string; tipOid: string }[] {
    const result = spawnSync(
        "git",
        ["for-each-ref", "--format=%(refname:short) %(objectname)", "--sort=refname", "refs/heads/"],
        { cwd: repoPath, encoding: "utf8" }
    );
    if (result.status !== 0) {
        throw new Error(`git for-each-ref failed in ${repoPath}: ${result.stderr}`);
    }
    return result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
            const [branchName, tipOid] = line.split(" ");
            return { branchName, tipOid };
        });
}

export function resolveBaseBranchCandidates(repoPath: string, recordedOid: string): BaseBranchResolution {
    const branchTips = listLocalBranchTips(repoPath);
    const matchingBranchNames = branchTips
        .filter((branch) => branch.tipOid === recordedOid)
        .map((branch) => branch.branchName);

    if (matchingBranchNames.length === 1) {
        return { kind: "single", baseBranch: matchingBranchNames[0] };
    }
    if (matchingBranchNames.length === 0) {
        return { kind: "none", candidates: [] };
    }
    return { kind: "multiple", candidates: matchingBranchNames };
}
```

## Why this shape (answerable per-line if asked)
- `for-each-ref --sort=refname` instead of `git branch`: plumbing output is script-stable (porcelain `git branch` output format is not guaranteed across git versions); `--sort=refname` is what makes the `multiple` case's order deterministic without any extra sorting code.
- No `git merge-base` / `--is-ancestor` call anywhere: the brief explicitly forbids ancestry-based matching. Comparing tip OID strings directly is the only comparison in the module, which is also why the "ancestor but not tip" and "contains but doesn't equal" test cases pass with zero special-case code — they're just not equal to `recordedOid`.
- `refs/heads/` scope: restricts to local branches only, per the "Assumptions" section above.
- Three-variant discriminated union (`kind: "single" | "none" | "multiple"`) instead of throwing on 0 or 2+: brief states zero/multiple "are not errors here" and must be returned as candidate sets for a separate resolution-request module (out of scope for this task).
- No git library dependency: `child_process.spawnSync` is stdlib and sufficient for one read-only git call; adding a library would violate ponytail rung 5 for a problem stdlib already solves.

## Explicit non-goals (do not implement in this task)
- No fuzzy/ancestry matching of any kind.
- No preference logic for picking among multiple candidates.
- No call sites wiring this into the resolution-request module or any workflow script.
- No remote-branch (`refs/remotes/*`) handling.
