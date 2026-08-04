# Task 42 Plan: Recursive gitlink substitution across a full ancestor chain

## Behavior, in plain English

`substituteGitlink` already rewrites one gitlink entry in one parent commit and
returns the new commit OID, without moving any ref. A nested-submodule chain
(root repo -> gitlink -> mid repo -> gitlink -> ... -> leaf repo) needs the
*whole* chain rewritten at once when the leaf occurrence commit changes: the
deepest gitlink gets the new leaf OID first, which mints a new commit for that
level; that new commit OID becomes the child OID substituted into the level
above; and so on up to the root. The new function folds the existing
`substituteGitlink` primitive over the chain, bottom-up, and hands back every
new commit OID produced (one per chain link) plus the root OID as a named
convenience.

No new git plumbing is needed — this is a loop over the existing primitive.
Validation (non-gitlink path, no-ref-moved) is already enforced inside
`substituteGitlink` for every level it's called on, so the new function does
not re-implement those checks; it only adds the one check `substituteGitlink`
can't do for it: rejecting an empty chain.

## Design

Add to `scripts/repositoryIntegration.ts`, directly after `substituteGitlink`:

```ts
export type GitlinkChainLink = {
    repoRoot: string;
    parentCommitOid: string;
    pathInParent: string;
};

// Folds substituteGitlink bottom-up: leaf OID feeds the deepest link, each new OID feeds the level above. No ref moves.
export function substituteGitlinksRecursively(
    chain: GitlinkChainLink[],
    leafChildOid: string,
): { rootCommitOid: string; commitOidsByLevel: string[] } {
    if (chain.length === 0) {
        throw new Error("substituteGitlinksRecursively requires a non-empty chain");
    }
    const commitOidsByLevel: string[] = new Array(chain.length);
    let childOid = leafChildOid;
    for (let level = chain.length - 1; level >= 0; level--) {
        const { repoRoot, parentCommitOid, pathInParent } = chain[level];
        childOid = substituteGitlink(repoRoot, { parentCommitOid, pathInParent, childOid });
        commitOidsByLevel[level] = childOid;
    }
    return { rootCommitOid: commitOidsByLevel[0], commitOidsByLevel };
}
```

Why this shape:
- `GitlinkChainLink` carries its own `repoRoot` because each level of a
  nested-submodule chain is a physically distinct repository on disk;
  `substituteGitlink` already takes `repoRoot` per call, so the chain link
  must supply one too. (`GitlinkSubstitution` doesn't need this field because
  it's already scoped to a single `substituteGitlink(repoRoot, ...)` call.)
- Chain order is root-to-leaf (matches how the brief and the sibling task 29
  describes the chain, and how a nested submodule path reads top-down), but
  the fold runs leaf-to-root, since that's the direction real gitlink OIDs
  must propagate. Iterating `chain.length - 1` down to `0` gets both right
  without reversing the input array.
- `commitOidsByLevel[level]` lines up index-for-index with the input `chain`,
  so "every intermediate OID is returned" is satisfied by construction, not by
  a second pass.
- `rootCommitOid` is `commitOidsByLevel[0]` restated as a named field purely
  for caller convenience (task 29 / Phase 4 callers want the root OID
  directly); it is not independently computed.
- No new validation function: an out-of-place `pathInParent` at any level
  still throws from inside the delegated `substituteGitlink` call, and no
  level ever moves a ref, because `substituteGitlink` itself never does.
  Duplicating either check here would be dead code with two sources of truth.

## Implementation order (TDD: red, then green)

1. Add the `substituteGitlinksRecursively` import to
   `tests/repositoryIntegration.test.ts`'s existing import line (alongside
   `prepareNoFfMerge, substituteGitlink`).
2. Add the test helper below and the six test cases below to
   `tests/repositoryIntegration.test.ts`. Run `node --test tests/` — confirm
   they fail with "substituteGitlinksRecursively is not a function" (RED；
   `substituteGitlink` and `prepareNoFfMerge` tests must still pass
   unchanged).
3. Add `GitlinkChainLink` and `substituteGitlinksRecursively` to
   `scripts/repositoryIntegration.ts` exactly as shown above.
4. Run `node --test tests/` again — all tests, old and new, pass (GREEN).
5. Do not touch `substituteGitlink` or `prepareNoFfMerge` — this task is
   additive only.

## Test helper to add

Place this near the other builder helpers (after `makeParentWithTwoGitlinks`,
before the first `test(...)` call that will use it). It builds a chain of
`depth` nested submodule hops: `chainRepos[0]` is the root repo,
`chainRepos[depth]` is the innermost ("leaf") repo whose HEAD commit is the
current occurrence commit.

```ts
// Builds a nested submodule chain: chainRepos[0] is root, each has a gitlink at "vendor/next" to the next repo.
function makeNestedGitlinkChain(depth: number): {
    chainRepos: string[];
    chainLinks: { repoRoot: string; parentCommitOid: string; pathInParent: string }[];
    leafCommitOid: string;
} {
    const chainRepos: string[] = [];
    for (let i = 0; i <= depth; i++) {
        chainRepos.push(makeTempRepoWithCommit());
    }
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const chainLinks: { repoRoot: string; parentCommitOid: string; pathInParent: string }[] = [];
    for (let i = depth - 1; i >= 0; i--) {
        git(chainRepos[i], "submodule", "add", "-q", chainRepos[i + 1], "vendor/next");
        git(chainRepos[i], "commit", "-q", "-m", "add nested submodule");
        chainLinks[i] = {
            repoRoot: chainRepos[i],
            parentCommitOid: git(chainRepos[i], "rev-parse", "HEAD").trim(),
            pathInParent: "vendor/next",
        };
    }
    const leafCommitOid = git(chainRepos[depth], "rev-parse", "HEAD").trim();
    return { chainRepos, chainLinks, leafCommitOid };
}
```

Note: `git submodule add` at level `i` must run *after* level `i + 1`'s repo
already has its final seed commit, and must run innermost-first (loop counts
down) so each parent's `git submodule add` records a real, already-existing
child commit.

## Tests to add

Add these six tests after the existing `substituteGitlink` tests (i.e. after
`test_substituteGitlinkThrowsWhenPathInParentIsNotAGitlink`, before
`makeBaseAndTip`).

```ts
test("test_substituteGitlinksRecursivelyResolvesNewLeafThroughTwoGitlinksInATwoLevelChain", () => {
    // Scenario: a two-level chain returns a root OID resolving to the new leaf through both gitlinks.
    const { chainRepos, chainLinks } = makeNestedGitlinkChain(2);
    const [rootRepo, midRepo, leafRepo] = chainRepos;
    writeFileSync(join(leafRepo, "seed.txt"), "seed\nchange\n");
    git(leafRepo, "commit", "-q", "-am", "change");
    const newLeafOid = git(leafRepo, "rev-parse", "HEAD").trim();
    // Test action.
    const { rootCommitOid, commitOidsByLevel } = substituteGitlinksRecursively(chainLinks, newLeafOid);
    // Verification: root -> mid gitlink, then mid -> leaf gitlink, lands on newLeafOid.
    const midOidFromRoot = git(rootRepo, "rev-parse", `${rootCommitOid}:vendor/next`).trim();
    assert.equal(midOidFromRoot, commitOidsByLevel[1]);
    const leafOidFromMid = git(midRepo, "rev-parse", `${commitOidsByLevel[1]}:vendor/next`).trim();
    assert.equal(leafOidFromMid, newLeafOid);
});

test("test_substituteGitlinksRecursivelyResolvesNewLeafThroughThreeGitlinksInAThreeLevelChain", () => {
    // Scenario: a three-level chain resolves the new leaf OID to the root through every gitlink.
    const { chainRepos, chainLinks } = makeNestedGitlinkChain(3);
    const [rootRepo, midRepo, mid2Repo, leafRepo] = chainRepos;
    writeFileSync(join(leafRepo, "seed.txt"), "seed\nchange\n");
    git(leafRepo, "commit", "-q", "-am", "change");
    const newLeafOid = git(leafRepo, "rev-parse", "HEAD").trim();
    // Test action.
    const { rootCommitOid, commitOidsByLevel } = substituteGitlinksRecursively(chainLinks, newLeafOid);
    // Verification: walk all three gitlinks from the returned root OID.
    const midOidFromRoot = git(rootRepo, "rev-parse", `${rootCommitOid}:vendor/next`).trim();
    assert.equal(midOidFromRoot, commitOidsByLevel[1]);
    const mid2OidFromMid = git(midRepo, "rev-parse", `${commitOidsByLevel[1]}:vendor/next`).trim();
    assert.equal(mid2OidFromMid, commitOidsByLevel[2]);
    const leafOidFromMid2 = git(mid2Repo, "rev-parse", `${commitOidsByLevel[2]}:vendor/next`).trim();
    assert.equal(leafOidFromMid2, newLeafOid);
});

test("test_substituteGitlinksRecursivelyReturnsEveryIntermediateOid", () => {
    // Scenario: commitOidsByLevel has one entry per chain link, each a distinct real commit OID.
    const { chainLinks } = makeNestedGitlinkChain(3);
    const leafRepo = makeTempRepoWithCommit();
    const newLeafOid = git(leafRepo, "rev-parse", "HEAD").trim();
    // Test action.
    const { commitOidsByLevel } = substituteGitlinksRecursively(chainLinks, newLeafOid);
    // Verification: one OID per link, all distinct from each other and the original OID.
    assert.equal(commitOidsByLevel.length, chainLinks.length);
    const uniqueOids = new Set(commitOidsByLevel);
    assert.equal(uniqueOids.size, chainLinks.length);
    chainLinks.forEach((link, level) => {
        assert.notEqual(commitOidsByLevel[level], link.parentCommitOid);
    });
});

test("test_substituteGitlinksRecursivelyThrowsWhenAChainLinkPathIsNotAGitlink", () => {
    // Scenario: a chain link naming a non-gitlink path throws instead of corrupting a tree.
    const { chainLinks } = makeNestedGitlinkChain(2);
    chainLinks[1] = { ...chainLinks[1], pathInParent: "seed.txt" };
    const leafRepo = makeTempRepoWithCommit();
    const newLeafOid = git(leafRepo, "rev-parse", "HEAD").trim();
    // Test action + verification.
    assert.throws(() => {
        substituteGitlinksRecursively(chainLinks, newLeafOid);
    });
});

test("test_substituteGitlinksRecursivelyRejectsAnEmptyChain", () => {
    // Scenario: an empty chain has nothing to fold over and must be rejected.
    assert.throws(() => {
        substituteGitlinksRecursively([], "0".repeat(40));
    });
});

test("test_substituteGitlinksRecursivelyDoesNotMoveAnyBranchOrBaseRefAtAnyLevel", () => {
    // Scenario: the no-ref-moved guarantee holds at every level of the chain, not just root.
    const { chainRepos, chainLinks } = makeNestedGitlinkChain(3);
    const branchesBefore = chainRepos.map((repoRoot) => git(repoRoot, "branch", "--show-current").trim());
    const headsBefore = chainRepos.map((repoRoot) => git(repoRoot, "rev-parse", "HEAD").trim());
    const leafRepo = chainRepos[chainRepos.length - 1];
    writeFileSync(join(leafRepo, "seed.txt"), "seed\nchange\n");
    git(leafRepo, "commit", "-q", "-am", "change");
    const newLeafOid = git(leafRepo, "rev-parse", "HEAD").trim();
    // Test action.
    substituteGitlinksRecursively(chainLinks, newLeafOid);
    // Verification: every repo in the chain has the same branch and HEAD as before.
    chainRepos.forEach((repoRoot, i) => {
        assert.equal(git(repoRoot, "branch", "--show-current").trim(), branchesBefore[i]);
        assert.equal(git(repoRoot, "rev-parse", "HEAD").trim(), headsBefore[i]);
    });
});
```

## Import line change

In `tests/repositoryIntegration.test.ts`, change:

```ts
import { prepareNoFfMerge, substituteGitlink } from "../scripts/repositoryIntegration.ts";
```

to:

```ts
import { prepareNoFfMerge, substituteGitlink, substituteGitlinksRecursively } from "../scripts/repositoryIntegration.ts";
```

## Verification

Run `node --test tests/repositoryIntegration.test.ts` after step 4. All 15
tests (9 existing + 6 new) must pass. No other file in the repo references
`substituteGitlink` or `GitlinkSubstitution` in a way this change would break
— `substituteGitlinksRecursively` is purely additive and calls the existing
function unmodified.

## Explicitly out of scope

- Wiring `substituteGitlinksRecursively` into task 29 (recoveryRefs) or any
  Phase 4 finalization caller — this task is the primitive only, per the
  brief.
- Any change to `substituteGitlink` or `prepareNoFfMerge` themselves.
- A batch/parallel variant, a dry-run mode, or any option beyond what the
  brief's six named test scenarios require — add if a real caller needs it.
