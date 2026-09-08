# Task 119: Investigate why the merge phase leaves a staged revert of the just-merged code in the main repo index and working tree

## User request

Investigate why the merge phase leaves a staged REVERT of the just-merged code in the main repo working tree and index. This has happened more than once. Do not fix yet - the deliverable is a diagnosis naming the exact line that writes the index and the exact line that rewrites the working tree.

OBSERVED RUN: runId msjg9ajc-tx9rtcb8kmn, 2026-08-07, task 111, base branch new-usage-graph pinned at 8e431bb47fa271b45dc85dec4edbc4f2086b0283.

ORDER OF EVENTS, each verified in this session rather than inferred:

1. 21:21:20Z prepareTasks.ts ran, printed "Reset branch task-group-1", pinned baseOid 8e431bb. Git status captured at session start showed plans/brief-112.md and plans/task-112-plan.md as UNTRACKED with the ?? marker, and .taskTools/tasks.json as modified-but-unstaged. Record this - it matters at step 7.
2. Plan and verify workflows wrote plans/task-111-plan.md. Codex reviewed twice.
3. Implement workflow committed cd6e064 on branch task-group-1 in the worktree at taskTools-wt/taskTools/group-1.
4. A follow-up commit d0931c8 in the same worktree removed two dead type imports from scripts/mergePipeline.ts. Test workflow reported green.
5. Worktree inspected directly - HEAD d0931c8, clean except untracked plans/p.md, base still 8e431bb, no drift. Backup branch task-111-backup force-created at d0931c8.
6. .taskTools/run-steps.json written, then the merge ran as node scripts/runMergePhase.ts. It printed status merged, publicationTargets targetOid 08780dc1980b2a34f99b1888b261d51c6d89f956, recordedBaseOid 8e431bb, approval.recordedAt 2026-08-07T21:45:05.234Z, conflicts empty, abortReason null.
7. Immediately after the merge, git status --porcelain in the MAIN repo showed scripts/mergePipeline.ts, scripts/operationBranches.ts, scripts/prepareTasks.ts, scripts/runMergePhase.ts and tests/runMergePhase.test.ts all with the staged marker, AND plans/brief-112.md plus plans/task-112-plan.md with the staged-add marker. Those last two were UNTRACKED at step 1 and nothing in this session staged them, so the merge phase itself staged files it did not own.
8. git diff --cached proved the DIRECTION of the staged change was a revert - the index held the PRE-task-111 content. It removed the buildOperationPushOccurrences import and its call from prepareTasks.ts, removed resolveMergeVerdict from runMergePhase.ts, and reverted the new imports in tests/runMergePhase.test.ts. The working tree files on disk matched the index, also lacking the fix. Meanwhile git show HEAD on each of the five files confirmed the merged commit 08780dc DID contain the fix. So HEAD was correct while index and worktree were both rolled back.
9. Recovery that worked - git checkout HEAD -- on the five files restored index and worktree together. Typecheck clean and the 9 tests in tests/runMergePhase.test.ts passed afterwards.

CRITICAL AMBIGUITY THE INVESTIGATION MUST RESOLVE FIRST. Between the merge and step 7 a full npx tsc --noEmit plus npm test run reported 1150 pass and 0 fail, which was read at the time as proof the worktree was still correct. That reading is probably WRONG. The previous session on this branch reported 1161 tests with 1 failure. The count dropped by 11. A reverted tests/runMergePhase.test.ts holds 7 tests instead of 9, and a reverted tree would drop other tests too, so a smaller all-passing suite is exactly what a reverted tree produces. Determine whether the revert landed during the merge subprocess or after it. The test-count delta is the strongest available evidence and points at during. Do not trust a green suite as proof the tree is intact - compare test COUNTS against the previous run.

LEADS ALREADY GATHERED, to save the next agent the grep:
- scripts/runFinalizer.ts lines 52-61, function stageChange, runs git add on the REAL index of repoRoot with no GIT_INDEX_FILE isolation. This is the only code path found that stages arbitrary paths into the main repo index. It stages whatever change.path lists, so if the working tree holds older content at that moment, git add snapshots the OLD bytes into the index. Prime suspect for the staging half.
- scripts/mergeTaskWorktrees.ts line 179 runs git checkout sourceBranch in repoRoot, and line 216 does the same in mainSubmodulePath. A branch checkout rewrites the working tree. Prime suspect for the disk-revert half. Line 204 runs git add on conflicted paths, but this run had zero conflicts so that path did not execute.
- scripts/recoveryRefs.ts line 29 runs git add -A but appears to pass a GIT_INDEX_FILE env - verify that the env is actually applied before ruling it out.
- ALREADY RULED OUT - scripts/repositoryIntegration.ts lines 39-60, substituteGitlink, correctly isolates its read-tree and update-index behind a scratch GIT_INDEX_FILE and removes it in a finally block. Do not spend time here.
- Only scripts/recoveryRefs.ts and scripts/repositoryIntegration.ts use GIT_INDEX_FILE at all, so every other git add, checkout, read-tree or update-index in scripts/ touches the real index or the real worktree.

WHY IT MATTERS: if the staged revert is committed by the user or by a later automated step, the merged task is silently undone while tasks.json already records it as completed with the commit hash. Also note the merge phase archived task 111 into completedTasks.json with commitHashes 08780dc but wrote no closureNote, which is a separate small gap in the same post-merge code path and worth confirming during recon.

Files to investigate: scripts/runFinalizer.ts, scripts/mergeTaskWorktrees.ts, scripts/mergePipeline.ts, scripts/runMergePhase.ts, scripts/recoveryRefs.ts, scripts/runConsolidation.ts, scripts/repositoryIntegration.ts

Suggested verification: run a full tackle-tasks cycle on a scratch task in a temp clone, snapshot git status --porcelain and git diff --cached before and after the merge subprocess, and assert the index contains no entry whose content is older than HEAD.

Difficulty around 6.

Diagnosis-only task: name the exact line that writes the main repo index and the exact line that rewrites the main repo working tree after a successful merge. Do not ship a fix under this task.

Recon already performed while filing this task, so the next agent does not repeat it:

- scripts/runFinalizer.ts lines 52-61 define stageChange, which calls git(repoRoot, "add", "--", change.path) (and the two-path form for renames) against the REAL index of repoRoot. Its local git() helper at lines 48-50 is a plain execFileSync with no GIT_INDEX_FILE in env. Because git add snapshots whatever bytes are on disk at call time, a working tree already rolled back would be committed into the index as a revert. Prime suspect for the staging half of the symptom.
- scripts/mergeTaskWorktrees.ts line 179 calls git(repoRoot, "checkout", sourceBranch) in the main checkout, and line 216 does the same against mainSubmodulePath. A branch checkout rewrites tracked files on disk. Prime suspect for the disk-revert half. Line 204 (git add of conflictedPaths) did not execute in the observed run because conflicts was empty.
- scripts/recoveryRefs.ts line 29 runs git add -A with an env argument that appears to carry GIT_INDEX_FILE; confirm the env is actually threaded through before ruling it out.
- RULED OUT: scripts/repositoryIntegration.ts substituteGitlink, lines 34-61. It allocates a scratch index path under tmpdir(), passes it as GIT_INDEX_FILE to both read-tree (line 42) and update-index (lines 43-47), and rmSync's it in a finally block (lines 58-60). Correctly isolated. Do not spend time here.
- A repo-wide grep showed only scripts/recoveryRefs.ts and scripts/repositoryIntegration.ts reference GIT_INDEX_FILE at all, so every other git add / checkout / read-tree / update-index under scripts/ mutates the real index or the real worktree.

Evidence from the observed run (runId msjg9ajc-tx9rtcb8kmn, task 111, base new-usage-graph at 8e431bb47fa271b45dc85dec4edbc4f2086b0283):

- Merge printed status merged, publicationTargets targetOid 08780dc1980b2a34f99b1888b261d51c6d89f956, recordedBaseOid 8e431bb, conflicts empty, abortReason null, approval.recordedAt 2026-08-07T21:45:05.234Z.
- Afterwards git show HEAD on each of scripts/mergePipeline.ts, scripts/operationBranches.ts, scripts/prepareTasks.ts, scripts/runMergePhase.ts and tests/runMergePhase.test.ts confirmed commit 08780dc contained the task 111 fix, while both the index and the on-disk files held the PRE-fix content. HEAD correct, index and worktree rolled back.
- git diff --cached direction was verified explicitly: it removed the buildOperationPushOccurrences import and its manifest.occurrences call from prepareTasks.ts, removed resolveMergeVerdict from runMergePhase.ts, and reverted the new type imports in tests/runMergePhase.test.ts.
- Scope evidence that the merge phase stages files it does not own: plans/brief-112.md and plans/task-112-plan.md were untracked (?? in git status) at session start and appeared as staged adds (A) after the merge, with no command in the session having staged them.
- git checkout HEAD -- on the five files restored index and worktree together; typecheck was clean and the 9 tests in tests/runMergePhase.test.ts passed after restoration.

Open question that must be settled first: a full npx tsc --noEmit plus npm test run between the merge and the git status inspection reported 1150 pass / 0 fail and was initially read as proof the tree was still intact. That reading is probably wrong. The prior session on this branch reported 1161 tests with 1 failure, an 11-test drop, and a reverted tests/runMergePhase.test.ts carries 7 tests instead of 9. A shrunken but fully green suite is exactly the signature of a tree that was already reverted, which places the revert inside the merge subprocess rather than after it. Compare test COUNTS, not pass/fail, when reproducing.

Separate small gap in the same post-merge code path, worth confirming during recon: the merge phase archived task 111 into completedTasks.json with commitHashes [08780dc] but wrote no closureNote field.

Stakes: tasks.json already records the task as completed with its commit hash, so if the staged revert is later committed by a human or an automated step, the merged work is silently undone while the bookkeeping still claims success. Reported to have happened more than once.

SECOND OCCURRENCE, task 112, runId msjm112r-taskonetwelve, base new-usage-graph at 54a60c40fe9b1af6b62e5d4ca950ff5eeb1345b0, merged as 7c28efbc48e2262b947beeb6a6d71c20837ea14c. Same symptom, and it supplies a leading hypothesis: the staged revert is caused by the merge phase moving the ref without updating the working tree. Under that explanation nothing actively writes a revert - the branch ref advances to the new merge commit while the index and the on-disk files are simply left at the pre-merge base, and git diff --cached then renders that staleness as deletions of everything the merge added.

Evidence from the task 112 run that discriminates this hypothesis from an active-revert one, all checked rather than inferred:
- git diff 54a60c4 -- scripts/ tests/ was EMPTY, and git diff --cached 54a60c4 -- scripts/ tests/ was EMPTY. Index and working tree were byte-identical to the pre-merge base, not to some third intermediate state. An active revert written by stageChange from stale disk bytes would be expected to reproduce the base content too, so this does not by itself rule out runFinalizer.ts, but it does confirm the reverted state is exactly the base tree with nothing else mixed in.
- git diff --cached against HEAD showed 42 insertions and 482 deletions across 6 files, with tests/mergePipeline.test.ts staged as a deletion (D). That file is new in the merged commit, so its absence from index and disk is consistent with the tree never having been advanced.
- HEAD was correct throughout: git show HEAD:scripts/runMergePhase.ts contained archiveIfMerged twice, while the on-disk copy contained it zero times and tests/mergePipeline.test.ts did not exist on disk.
- Recovery: git checkout HEAD -- scripts/ tests/ restored index and worktree together, after which typecheck was clean and the suite was 1165 pass / 0 fail.

The test-count trap this task warns about was hit again, which independently corroborates the warning. A full npm test run against the un-restored tree reported 1152 pass / 0 fail and was briefly read as a successful post-merge verification. It was not - it was testing the pre-merge code. After git checkout HEAD -- scripts/ tests/ the same command reported 1165 pass / 0 fail. The 13-test delta is exactly the 13 tests in the new tests/mergePipeline.test.ts, which did not exist on disk. So once again a smaller, fully green suite was the signature of a stale tree. Any reproduction must compare test COUNTS across the merge boundary, never pass/fail alone.

Note for whoever investigates: task 112 shipped findTaskArchivalValidationFailure, which verifies declared files exist in the recorded commit before archiving. That gate reads the COMMIT, not the working tree, so it passed correctly here and is not affected by this bug - but it also means this bug cannot be detected by that gate. A tree-level check would be needed.

### scripts/runFinalizer.ts

```
// Finalizes an occurrence graph bottom-up: per-occurrence own-files commit, durable tip ref, and a bump-commit assembly branch for parents.
import { execFileSync } from "node:child_process";
import { readDirectGitlinks } from "./gitlinkReader.ts";
import { substituteGitlink } from "./repositoryIntegration.ts";
import { runFinalization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";
import type { Change } from "./ownershipSnapshots.ts";

export type ChildOccurrenceEdge = {
    pathInParent: string;
    childOccurrenceId: string;
};

export type OccurrenceFinalizationInput = {
    occurrenceId: string;
    repoRoot: string;
    currentTipOid: string;
    recordedBaseOid: string;
    approvedOwnFileChanges: Change[];
    directChildEdges: ChildOccurrenceEdge[];
};

export type FinalizationRunInput = {
    runId: string;
    occurrences: OccurrenceFinalizationInput[];
};

export type BumpCommit = {
    pathInParent: string;
    childOccurrenceId: string;
    commitOid: string;
};

export type OccurrenceFinalizationResult = {
    occurrenceId: string;
    ownFilesCommitOid: string;
    durableTipRef: string;
    finalizedIntegrationOid: string;
    assemblyBranchRef: string | null;
    bumpCommits: BumpCommit[];
};

export type FinalizationRunResult = {
    runId: string;
    occurrences: OccurrenceFinalizationResult[];
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function stageChange(repoRoot: string, change: Change): void {
    if (change.type === "renamed") {
        if (!change.fromPath) {
            throw new Error(`renamed change for "${change.path}" is missing fromPath`);
        }
        git(repoRoot, "add", "--", change.fromPath, change.path);
        return;
    }
    git(repoRoot, "add", "--", change.path);
}

// Defensive re-check: the caller is expected to have already filtered these to non-gitlink paths.
function assertNoGitlinkChanges(repoRoot: string, currentTipOid: string, changes: Change[]): void {
    const gitlinkPaths = new Set(readDirectGitlinks(repoRoot, currentTipOid).map((entry) => entry.path));
    for (const change of changes) {
        const touchesGitlink = gitlinkPaths.has(change.path) || (change.fromPath !== undefined && gitlinkPaths.has(change.fromPath));
        if (touchesGitlink) {
            throw new Error(`approvedOwnFileChanges includes gitlink path "${change.path}"; own-file commits must never touch a gitlink`);
        }
    }
}

function commitOwnFileChanges(
    repoRoot: string,
    occurrenceId: string,
    runId: string,
    currentTipOid: string,
    changes: Change[],
): string {
    if (changes.length === 0) return currentTipOid;
    assertNoGitlinkChanges(repoRoot, currentTipOid, changes);
    for (const change of changes) stageChange(repoRoot, change);
    const newTreeOid = git(repoRoot, "write-tree").trim();
    return git(
        repoRoot,
        "commit-tree",
        newTreeOid,
        "-p",
        currentTipOid,
        "-m",
        `finalize: own-file changes for ${occurrenceId} (${runId})`,
    ).trim();
}

function readGitlinkOid(repoRoot: string, commitOid: string, pathInParent: string): string | null {
    const line = git(repoRoot, "ls-tree", commitOid, "--", pathInParent).trim();
    if (line === "") return null;
    const [metadata] = line.split("\t");
    return metadata.split(" ")[2] ?? null;
}

// Post-order DFS over directChildEdges: every occurrence appears after all of its direct and transitive children.
function topologicallySortChildFirst(occurrences: OccurrenceFinalizationInput[]): OccurrenceFinalizationInput[] {
    const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const mark = new Map<string, "gray" | "black">();
    const order: OccurrenceFinalizationInput[] = [];

    function visit(occurrence: OccurrenceFinalizationInput, path: string[]): void {
        const currentMark = mark.get(occurrence.occurrenceId);
        if (currentMark === "black") return;
        if (currentMark === "gray") {
            throw new Error(`cycle detected among occurrences: ${[...path, occurrence.occurrenceId].join(" -> ")}`);
        }
        mark.set(occurrence.occurrenceId, "gray");
        for (const edge of occurrence.directChildEdges) {
            const child = byId.get(edge.childOccurrenceId);
            if (!child) {
                throw new Error(
                    `occurrence "${occurrence.occurrenceId}" has directChildEdges entry for unknown childOccurrenceId "${edge.childOccurrenceId}"`,
                );
            }
            visit(child, [...path, occurrence.occurrenceId]);
        }
        mark.set(occurrence.occurrenceId, "black");
        order.push(occurrence);
    }

    for (const occurrence of occurrences) visit(occurrence, []);
    return order;
}

function buildAssemblyBranch(
    occurrence: OccurrenceFinalizationInput,
    runId: string,
    resultsByOccurrenceId: Map<string, OccurrenceFinalizationResult>,
): { finalizedIntegrationOid: string; assemblyBranchRef: string; bumpCommits: BumpCommit[] } {
    const { repoRoot, recordedBaseOid, directChildEdges } = occurrence;
    const sortedEdges = [...directChildEdges].sort((a, b) => a.pathInParent.localeCompare(b.pathInParent));
    const bumpCommits: BumpCommit[] = [];
    let assemblyTip = recordedBaseOid;
    for (const edge of sortedEdges) {
        const childResult = resultsByOccurrenceId.get(edge.childOccurrenceId);
        if (!childResult) {
            throw new Error(`no finalized result for child occurrence "${edge.childOccurrenceId}"`);
        }
        const childOid = childResult.finalizedIntegrationOid;
        const existingGitlinkOid = readGitlinkOid(repoRoot, assemblyTip, edge.pathInParent);
        if (existingGitlinkOid === childOid) continue;
        assemblyTip = substituteGitlink(repoRoot, { parentCommitOid: assemblyTip, pathInParent: edge.pathInParent, childOid });
        bumpCommits.push({ pathInParent: edge.pathInParent, childOccurrenceId: edge.childOccurrenceId, commitOid: assemblyTip });
    }
    const assemblyBranchRef = `refs/finalize/${runId}/assembly/${occurrence.occurrenceId}`;
    git(repoRoot, "update-ref", assemblyBranchRef, assemblyTip);
    return { finalizedIntegrationOid: assemblyTip, assemblyBranchRef, bumpCommits };
}

function finalizeOccurrence(
    occurrence: OccurrenceFinalizationInput,
    runId: string,
    resultsByOccurrenceId: Map<string, OccurrenceFinalizationResult>,
): OccurrenceFinalizationResult {
    const ownFilesCommitOid = commitOwnFileChanges(
        occurrence.repoRoot,
        occurrence.occurrenceId,
        runId,
        occurrence.currentTipOid,
        occurrence.approvedOwnFileChanges,
    );
    const durableTipRef = `refs/finalize/${runId}/tip/${occurrence.occurrenceId}`;
    git(occurrence.repoRoot, "update-ref", durableTipRef, ownFilesCommitOid);

    if (occurrence.directChildEdges.length === 0) {
        return {
            occurrenceId: occurrence.occurrenceId,
            ownFilesCommitOid,
            durableTipRef,
            finalizedIntegrationOid: ownFilesCommitOid,
            assemblyBranchRef: null,
            bumpCommits: [],
        };
    }

    const { finalizedIntegrationOid, assemblyBranchRef, bumpCommits } = buildAssemblyBranch(occurrence, runId, resultsByOccurrenceId);
    return {
        occurrenceId: occurrence.occurrenceId,
        ownFilesCommitOid,
        durableTipRef,
        finalizedIntegrationOid,
        assemblyBranchRef,
        bumpCommits,
    };
}

export function runFinalizer(
    input: FinalizationRunInput,
    token: RunAuthorizationToken,
    currentStateDigest: string,
): FinalizationRunResult {
    return runFinalization(token, currentStateDigest, () => {
        const resultsByOccurrenceId = new Map<string, OccurrenceFinalizationResult>();
        for (const occurrence of topologicallySortChildFirst(input.occurrences)) {
            resultsByOccurrenceId.set(occurrence.occurrenceId, finalizeOccurrence(occurrence, input.runId, resultsByOccurrenceId));
        }
        return {
            runId: input.runId,
            occurrences: input.occurrences.map((occurrence) => resultsByOccurrenceId.get(occurrence.occurrenceId)!),
        };
    });
}

```

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
import type { MergeOutcome, SubmoduleConflict } from "./mergePipeline.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitErrorText(error: unknown): string {
    const failure = error as { stderr?: string; message?: string };
    return (failure.stderr || failure.message || "git merge failed").trim();
}

export type TaskWorktree = { path: string; branch: string };

function parseWorktreeListPorcelain(output: string): TaskWorktree[] {
    const blocks = output.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const worktrees: TaskWorktree[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
        if (!pathLine) continue;
        if (!branchLine) continue;
        worktrees.push({
            path: pathLine.slice("worktree ".length),
            branch: branchLine.slice("branch refs/heads/".length),
        });
    }
    return worktrees;
}

export function listTaskWorktrees(repoRoot: string): TaskWorktree[] {
    const conventionDir = join(tmpdir(), "taskTools-wt", basename(repoRoot));
    // git resolves symlinks in the paths it reports (e.g. macOS /var -> /private/var); match on the resolved form.
    if (!existsSync(conventionDir)) return [];
    const conventionRoot = realpathSync(conventionDir);
    const output = git(repoRoot, "worktree", "list", "--porcelain");
    return parseWorktreeListPorcelain(output).filter((worktree) => {
        if (!worktree.path.startsWith(`${conventionRoot}/`)) return false;
        return /^group-\d+$/.test(basename(worktree.path));
    });
}

function unmergedCommitCount(repoRoot: string, sourceBranch: string, branch: string): number {
    return Number(git(repoRoot, "rev-list", "--count", `${sourceBranch}..${branch}`).trim());
}

function commitChangedFiles(repoRoot: string, sourceBranch: string, branch: string): string[] {
    return git(repoRoot, "diff", "--name-only", `${sourceBranch}...${branch}`).split("\n").filter(Boolean);
}

// Porcelain v1 rename lines read "R  old -> new"; every other status line is "XY path".
function uncommittedChangedFiles(worktreePath: string): string[] {
    return git(worktreePath, "status", "--porcelain").split("\n").filter(Boolean).map((line) => {
        const path = line.slice(3);
        if (!path.includes(" -> ")) return path;
        return path.split(" -> ")[1];
    });
}

export type UnmergedTaskWorktree = {
    worktree: string;
    branch: string;
    unmergedCommitCount: number;
    hasUncommittedChanges: boolean;
    changedFilePaths: string[];
    matchedTaskNumbers: number[];
};

export function findUnmergedTaskWorktrees(
    repoRoot: string,
    sourceBranch: string,
    openTasks: TaskRecord[],
): UnmergedTaskWorktree[] {
    const results = listTaskWorktrees(repoRoot).map((worktree) => {
        const commitChanged = commitChangedFiles(repoRoot, sourceBranch, worktree.branch);
        const uncommittedChanged = uncommittedChangedFiles(worktree.path);
        const changedFilePaths = [...new Set([...commitChanged, ...uncommittedChanged])];
        const matchedTaskNumbers = openTasks
            .filter((task) => declaredFiles(task).some((file) => changedFilePaths.includes(file)))
            .map((task) => task.taskNumber);
        return {
            worktree: worktree.path,
            branch: worktree.branch,
            unmergedCommitCount: unmergedCommitCount(repoRoot, sourceBranch, worktree.branch),
            hasUncommittedChanges: uncommittedChanged.length > 0,
            changedFilePaths,
            matchedTaskNumbers,
        };
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export type RebaseOutcome =
    | { status: "rebased-clean" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string };

function rebaseGitPath(worktreePath: string, relativePath: string): string {
    const output = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    return isAbsolute(output) ? output : join(worktreePath, output);
}

function rebaseInProgress(worktreePath: string): boolean {
    return existsSync(rebaseGitPath(worktreePath, "rebase-merge")) || existsSync(rebaseGitPath(worktreePath, "rebase-apply"));
}

function collectConflictedRebasePaths(worktreePath: string): string[] {
    return git(worktreePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

function abortRebase(worktreePath: string): { aborted: boolean; failureReason: string | null } {
    try {
        git(worktreePath, "rebase", "--abort");
        return { aborted: true, failureReason: null };
    } catch (error) {
        return { aborted: false, failureReason: gitErrorText(error) };
    }
}

function combineFailureReasons(...parts: (string | null)[]): string {
    return parts.filter((part): part is string => part !== null).join("; ");
}

export function rebaseGroupOntoSource(worktreePath: string, sourceBranch: string): RebaseOutcome {
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        const originalReason = gitErrorText(rebaseError);

        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: originalReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(collectionError), abortFailure) };
        }

        const abortResult = abortRebase(worktreePath);
        if (!abortResult.aborted) {
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, `abort also failed: ${abortResult.failureReason}`) };
        }

        if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: originalReason };

        return { status: "conflicted", conflictedFilePaths };
    }
}

export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    git(repoRoot, "checkout", sourceBranch);
    const outcome = { groupId: group.groupId, submoduleConflicts: [], worktree: group.worktree };
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
        const failureReason = resolution.startFailed ? gitErrorText(error) : null;
        return { ...outcome, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, failureReason };
    }
}

export function resolveGitlinkConflicts(
    repoRoot: string,
    submodulePaths: string[],
): { resolved: boolean; unexpectedConflicts: string[]; startFailed: boolean } {
    const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    // No unmerged paths means the merge never started, so there is nothing to abort, stage, or commit.
    if (conflictedPaths.length === 0) return { resolved: false, unexpectedConflicts: [], startFailed: true };
    const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
    if (unexpectedConflicts.length > 0) {
        git(repoRoot, "merge", "--abort");
        return { resolved: false, unexpectedConflicts, startFailed: false };
    }
    for (const path of conflictedPaths) git(repoRoot, "add", path);
    git(repoRoot, "commit", "--no-edit");
    return { resolved: true, unexpectedConflicts: [], startFailed: false };
}

export function mergeSubmoduleBranchIntoRepo(
    mainSubmodulePath: string,
    worktreeSubmodulePath: string,
    sourceBranch: string,
): { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null } {
    const groupBranch = currentBranchName(worktreeSubmodulePath);
    git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
    git(mainSubmodulePath, "checkout", sourceBranch);
    try {
        git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
        return { merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        // Same rule as the parent repo: with no unmerged paths there is no merge in progress to abort.
        if (conflictedFilePaths.length === 0) return { merged: false, conflictedFilePaths, failureReason: gitErrorText(error) };
        git(mainSubmodulePath, "merge", "--abort");
        return { merged: false, conflictedFilePaths, failureReason: null };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runDiscoverCli(): void {
    const repoRoot = process.cwd();
    const sourceBranch = currentBranchName(repoRoot);
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    process.stdout.write(JSON.stringify(results));
}

function runMergeCli(worktreePath: string): void {
    const repoRoot = process.cwd();
    const repositorySources = collectRepositorySources(repoRoot);
    const parentSource = repositorySources.find((source) => source.path === "");
    if (!parentSource) throw new Error(`no recorded source branch for repository path "${repoRoot}"`);
    const submodulePathsDeepestFirst = repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const branch = currentBranchName(worktreePath);
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

async function runAsCli(): Promise<void> {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        await runMergePipeline({ ...prepared, ...outcomes });
        return;
    }
    await runMergePipeline(JSON.parse(process.argv[2]));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    runAsCli().catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}

```

### scripts/mergePipeline.ts

```
// Translates the CLI's flat merge input into the finalize/consolidate/push/publish/archive pipeline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type WorkflowArguments } from "./prepareTasks.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization, finalizeApprovedRun, computeApprovalDigest, type OccurrenceSnapshot, type RunState, type ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { validateRepositoryManifest, type RepositoryManifest } from "./repositoryManifest.ts";
import { buildOperationPushOccurrences, identityKey, sanitizeSegment } from "./operationBranches.ts";
import { normalizeRepositoryIdentity, type RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { LogicalRepository } from "./logicalRepository.ts";
import { prepareNoFfMerge } from "./repositoryIntegration.ts";
import { consolidateRun, type GroupOccurrenceBranch, type LogicalRepositoryConsolidationInput } from "./runConsolidation.ts";
import { pushOperationBranches } from "./operationPush.ts";
import { publishBases, readCurrentRefOid, type PublicationTarget } from "./basePublication.ts";
import { summarizeTaskMergeResults, type RawTaskRepoOutcome, type ArchiveRequest } from "./taskArchival.ts";
import { runFinalization } from "./runAuthorization.ts";
export type CliInput = WorkflowArguments & {
    runId?: string; startTimestamp?: string; doneCount?: number; partialCount?: number; blockedCount?: number;
    needsClarificationCount?: number; requeueCount?: number; testReceipts?: TestReceipt[]; reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};
export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };
export type MergeOutcome = { groupId: number; merged: boolean; conflictedFilePaths: string[]; submoduleConflicts: SubmoduleConflict[]; worktree: string; failureReason: string | null };
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
export type Coordinate = { repoRoot: string; relativePath: string };
export type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
export type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function digestIds(ids: string[]): string { return createHash("sha256").update([...ids].sort().join("\n")).digest("hex"); }
function parseMergeTreeConflicts(stdout: string): string[] {
    const [, ...lines] = (stdout.split("\n\n")[0] ?? "").split("\n");
    return [...new Set(lines.filter(Boolean).map((line) => line.split("\t")[1]))];
}
function occurrenceToLogicalId(groups: LogicalGroup[], occurrenceId: string): string { return groups.find((g) => g.occurrenceIds.includes(occurrenceId))!.logicalId; }
export function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
    const repoResolved = resolve(repo);
    const coordinates = new Map<string, Coordinate>();
    for (const occurrence of manifest.occurrences) {
        const repoRoot = occurrence.checkoutPath.startsWith("/") ? occurrence.checkoutPath : join(repo, occurrence.checkoutPath);
        const relativePath = repoRoot === repoResolved ? "" : relative(repoResolved, repoRoot);
        if (relativePath.startsWith("..")) throw new Error(`occurrence "${occurrence.occurrenceId}" checkout path "${repoRoot}" is outside repo "${repo}"`);
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
// Deepest checkout that's a strict prefix of `path` owns it; an exact checkout match belongs to the parent.
function ownerLogicalIdForPath(path: string, manifest: RepositoryManifest, coordinates: Map<string, Coordinate>, logicalGroups: LogicalGroup[]): { logicalId: string; repoRelativePath: string } {
    let best: { occurrenceId: string; relativePath: string } | null = null;
    for (const occurrence of manifest.occurrences) {
        const relativePath = coordinates.get(occurrence.occurrenceId)!.relativePath;
        if (relativePath !== "" && !path.startsWith(`${relativePath}/`)) continue;
        if (!best || relativePath.length > best.relativePath.length) best = { occurrenceId: occurrence.occurrenceId, relativePath };
    }
    const repoRelativePath = best!.relativePath === "" ? path : path.slice(best!.relativePath.length + 1);
    return { logicalId: occurrenceToLogicalId(logicalGroups, best!.occurrenceId), repoRelativePath };
}
export function taskFilesByLogicalId(files: string[], manifest: RepositoryManifest, coordinates: Map<string, Coordinate>, logicalGroups: LogicalGroup[]): Set<string> {
    return new Set(files.map((path) => ownerLogicalIdForPath(path, manifest, coordinates, logicalGroups).logicalId));
}
function pathExistsInTree(repoRoot: string, commitHash: string, path: string): boolean {
    try {
        execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${commitHash}:${path}`], { stdio: ["ignore", "ignore", "ignore"] });
        return true;
    } catch {
        return false;
    }
}
function consolidationChangedFromBase(repoRoot: string, recordedBaseOid: string, preparedIntegrationOid: string): boolean {
    return git(repoRoot, "rev-parse", `${recordedBaseOid}^{tree}`).trim() !== git(repoRoot, "rev-parse", `${preparedIntegrationOid}^{tree}`).trim();
}
// Returns an abortReason for the first failing task/repository pair, or null if every declared file is verified.
export function findTaskArchivalValidationFailure(
    tasks: { number: number; files: string[] }[],
    manifest: RepositoryManifest,
    coordinates: Map<string, Coordinate>,
    logicalGroups: LogicalGroup[],
    consolidations: Map<string, ConsolidationOutcome>,
): string | null {
    for (const task of tasks) {
        if (task.files.length === 0) return `task ${task.number} declares no files; refusing to archive without a way to verify its code landed`;
        const pathsByLogicalId = new Map<string, string[]>();
        for (const path of task.files) {
            const owned = ownerLogicalIdForPath(path, manifest, coordinates, logicalGroups);
            const paths = pathsByLogicalId.get(owned.logicalId) ?? [];
            paths.push(owned.repoRelativePath);
            pathsByLogicalId.set(owned.logicalId, paths);
        }
        for (const [logicalId, repoRelativePaths] of pathsByLogicalId) {
            const consolidation = consolidations.get(logicalId);
            if (!consolidation || !consolidation.preparedIntegrationOid) return `task ${task.number}: no integration commit recorded for repository "${logicalId}"`;
            if (!consolidationChangedFromBase(consolidation.canonicalRepoRoot, consolidation.recordedBaseOid, consolidation.preparedIntegrationOid)) {
                return `task ${task.number}: consolidation for repository "${logicalId}" produced no changes from its recorded base (empty commit ${consolidation.preparedIntegrationOid})`;
            }
            for (const repoRelativePath of repoRelativePaths) {
                if (!pathExistsInTree(consolidation.canonicalRepoRoot, consolidation.preparedIntegrationOid, repoRelativePath)) {
                    return `task ${task.number}: declared file "${repoRelativePath}" is missing from commit ${consolidation.preparedIntegrationOid} in repository "${logicalId}"`;
                }
            }
        }
    }
    return null;
}
export function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
    const byKey = new Map<string, string[]>();
    for (const occurrence of manifest.occurrences) {
        const key = identityKey(occurrence);
        const existing = byKey.get(key);
        if (existing) existing.push(occurrence.occurrenceId); else byKey.set(key, [occurrence.occurrenceId]);
    }
    return [...byKey.entries()].map(([key, occurrenceIds]) => ({ logicalId: sanitizeSegment(key), occurrenceIds, canonicalOccurrenceId: occurrenceIds[0] }));
}
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
export function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
    const occurrenceToLogical = new Map<string, string>();
    for (const group of groups) for (const id of group.occurrenceIds) occurrenceToLogical.set(id, group.logicalId);
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const byId = new Map(groups.map((g) => [g.logicalId, g]));
    const mark = new Map<string, "gray" | "black">();
    const order: LogicalGroup[] = [];
    function visit(logicalId: string, path: string[]): void {
        if (mark.get(logicalId) === "black") return;
        if (mark.get(logicalId) === "gray") throw new Error(`logical repository dependency cycle: ${[...path, logicalId].join(" -> ")}`);
        mark.set(logicalId, "gray");
        const group = byId.get(logicalId)!;
        for (const occurrenceId of group.occurrenceIds) for (const childId of occurrenceById.get(occurrenceId)!.childOccurrenceIds) {
            const childLogicalId = occurrenceToLogical.get(childId)!;
            if (childLogicalId !== logicalId) visit(childLogicalId, [...path, logicalId]);
        }
        mark.set(logicalId, "black");
        order.push(group);
    }
    for (const group of groups) visit(group.logicalId, []);
    return order;
}
export async function runMergePipeline(input: CliInput): Promise<void> {
    const manifest = input.repositoryManifest;
    if (!manifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const validation = validateRepositoryManifest(manifest);
    if (!validation.valid) throw new Error(`invalid repository manifest: ${validation.errors.join("; ")}`);
    const roots = manifest.occurrences.filter((o) => o.parentOccurrenceId === null);
    if (roots.length !== 1) throw new Error(`repository manifest must have exactly one root occurrence, found ${roots.length}`);
    if (input.groups.length === 0) throw new Error("no groups given in CLI input");
    const rootOccurrence = roots[0];
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const runId = input.runId ?? `merge-${Date.now()}-${process.pid}`;
    execFileSync("git", ["check-ref-format", `refs/heads/${runId}/probe`]);
    const sortedGroups = [...input.groups].sort((a, b) => a.groupId - b.groupId);
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];
    const coordinates = buildCoordinates(input.repo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    const groupRepoRootFor = (groupWorktree: string, occurrenceId: string): string =>
        coordinates.get(occurrenceId)!.relativePath === "" ? groupWorktree : join(groupWorktree, coordinates.get(occurrenceId)!.relativePath);
    const rawTips = new Map<string, Map<number, string>>();
    for (const occurrence of manifest.occurrences) rawTips.set(occurrence.occurrenceId, new Map(sortedGroups.map((group) => [group.groupId, git(groupRepoRootFor(group.worktree, occurrence.occurrenceId), "rev-parse", "HEAD").trim()])));
    const baseMismatch = logicalGroups.find((group) => new Set(group.occurrenceIds.map((id) => occurrenceById.get(id)!.baseOid)).size > 1);
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        let rootConflictedPaths: string[] = [];
        let failed = baseMismatch !== undefined;
        for (const occurrence of manifest.occurrences) {
            const coordinate = coordinates.get(occurrence.occurrenceId)!;
            const groupRepoRoot = groupRepoRootFor(group.worktree, occurrence.occurrenceId);
            const tipOid = rawTips.get(occurrence.occurrenceId)!.get(group.groupId)!;
            try {
                execFileSync("git", ["-C", groupRepoRoot, "merge-tree", "--write-tree", occurrence.baseOid, tipOid], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            } catch (error) {
                failed = true;
                const conflictedPaths = parseMergeTreeConflicts((error as { stdout?: string }).stdout ?? "");
                if (coordinate.relativePath === "") rootConflictedPaths = conflictedPaths;
                else submoduleConflicts.push({ path: coordinate.relativePath, conflictedFilePaths: conflictedPaths, failureReason: null });
            }
        }
        const outcome: MergeOutcome = { groupId: group.groupId, merged: !failed, conflictedFilePaths: failed ? rootConflictedPaths : [], submoduleConflicts, worktree: group.worktree, failureReason: null };
        (failed ? conflicts : merged).push(outcome);
    }
    const allGroupsMerged = conflicts.length === 0;
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => manifest.occurrences.map((occurrence) => ({
        groupId: outcome.groupId, repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath,
        treeListing: git(groupRepoRootFor(outcome.worktree, occurrence.occurrenceId), "ls-tree", "-r", "-z", "HEAD"),
    })));
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
    const operationRef = digestIds(sortedGroups.flatMap((group) => manifest.occurrences.map((o) => `${group.groupId}:${o.occurrenceId}:${rawTips.get(o.occurrenceId)!.get(group.groupId)}`)));
    const readyForApproval = allGroupsMerged && testReceipts.length > 0 && testReceipts.every((receipt) => receipt.status === "green") && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };
    const endMetrics = (conflictCount: number): void => {
        const endTimestamp = new Date().toISOString();
        const workflowArguments: WorkflowArguments = { repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups, repositorySources: input.repositorySources };
        appendRunMetricsRecord(input.repo, {
            runId: input.runId ?? endTimestamp, startTimestamp: input.startTimestamp ?? null, endTimestamp,
            durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
            taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)), groupCount: sortedGroups.length,
            doneCount: input.doneCount ?? 0, partialCount: input.partialCount ?? 0, blockedCount: input.blockedCount ?? 0,
            needsClarificationCount: input.needsClarificationCount ?? 0, requeueCount: input.requeueCount ?? 0,
            conflictCount, argumentsHash: computeArgumentsHash(workflowArguments),
        });
    };
    const printResult = (publicationTargets: PublicationTargetSummary[], abortReason: string | null = null, archiveRequest: ArchiveRequest | null = null): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets, abortReason, archiveRequest })); };
    if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }
    recordApproval(runState);
    const token = issueApprovalAuthorization(runState);
    const digest = computeApprovalDigest(runState.digestInput); let abortReason: string | null = null;
    const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {
        const consolidations = new Map<string, ConsolidationOutcome>();
        for (const logicalGroup of logicalGroups) {
            const canonicalRepoRoot = coordinates.get(logicalGroup.canonicalOccurrenceId)!.repoRoot;
            const canonicalOccurrence = occurrenceById.get(logicalGroup.canonicalOccurrenceId)!;
            const participatingBranches: GroupOccurrenceBranch[] = [];
            for (const occurrenceId of logicalGroup.occurrenceIds) {
                const occurrence = occurrenceById.get(occurrenceId)!;
                const occurrenceSegment = sanitizeSegment(occurrenceId);
                for (const group of sortedGroups) {
                    const repoRoot = groupRepoRootFor(group.worktree, occurrenceId);
                    const proxyId = (childId: string): string => `proxy-${sanitizeSegment(childId)}`;
                    const directChildEdges = occurrence.childOccurrenceIds.map((childId) => ({ pathInParent: occurrenceById.get(childId)!.pathInParent!, childOccurrenceId: proxyId(childId) }));
                    const proxyInputs = occurrence.childOccurrenceIds.map((childId) => {
                        const child = consolidations.get(occurrenceToLogicalId(logicalGroups, childId))!;
                        return { occurrenceId: proxyId(childId), repoRoot: child.canonicalRepoRoot, currentTipOid: child.preparedIntegrationOid, recordedBaseOid: child.preparedIntegrationOid, approvedOwnFileChanges: [], directChildEdges: [] };
                    });
                    const finalizationRunId = `${runId}-finalize-${sanitizeSegment(logicalGroup.logicalId)}-${group.groupId}`;
                    const result = finalizeApprovedRun(runState, {
                        runId: finalizationRunId,
                        occurrences: [{ occurrenceId: occurrenceSegment, repoRoot, currentTipOid: rawTips.get(occurrenceId)!.get(group.groupId)!, recordedBaseOid: rawTips.get(occurrenceId)!.get(group.groupId)!, approvedOwnFileChanges: [], directChildEdges }, ...proxyInputs],
                    });
                    const finalizedOid = result.occurrences.find((o) => o.occurrenceId === occurrenceSegment)!.finalizedIntegrationOid;
                    const groupSegment = String(group.groupId).padStart(6, "0");
                    if (repoRoot !== canonicalRepoRoot) git(canonicalRepoRoot, "fetch", repoRoot, finalizedOid);
                    git(canonicalRepoRoot, "update-ref", `refs/heads/${groupSegment}/${occurrenceSegment}`, finalizedOid);
                    participatingBranches.push({ groupId: groupSegment, occurrencePath: occurrenceSegment, occurrenceId, branchOid: finalizedOid, sourceRepoRoot: canonicalRepoRoot });
                }
            }
            const sorted = [...participatingBranches].sort((a, b) => a.groupId.localeCompare(b.groupId) || a.occurrencePath.localeCompare(b.occurrencePath));
            let previewOid = sorted[0].branchOid;
            for (let i = 1; i < sorted.length; i++) {
                const foldResult = prepareNoFfMerge(canonicalRepoRoot, previewOid, sorted[i].branchOid, `preview fold ${runId}`);
                if (!foldResult.merged) return true; else previewOid = foldResult.commitOid;
            }
            const approvedConvergedTreeOid = git(canonicalRepoRoot, "rev-parse", `${previewOid}^{tree}`).trim();
            const consolidationInput: LogicalRepositoryConsolidationInput = {
                logicalRepositoryId: logicalGroup.logicalId, canonicalRepoRoot, canonicalOccurrenceBranchName: sanitizeSegment(logicalGroup.logicalId),
                participatingBranches, approvedConvergedTreeOid, finalizedChildGitlinks: [],
                recordedBaseOid: canonicalOccurrence.baseOid, baseBranchRef: `refs/heads/${canonicalOccurrence.baseBranch}`,
            };
            const [result] = consolidateRun(runId, [consolidationInput], token, digest);
            if ("aborted" in result) return true;
            const integrationRef = `refs/finalize/${runId}/integration/${sanitizeSegment(logicalGroup.logicalId)}`;
            git(canonicalRepoRoot, "update-ref", integrationRef, result.preparedIntegrationOid);
            consolidations.set(logicalGroup.logicalId, { preparedIntegrationOid: result.preparedIntegrationOid, canonicalRepoRoot, canonicalRefName: `refs/heads/${canonicalOccurrence.baseBranch}`, recordedBaseOid: canonicalOccurrence.baseOid, integrationRef });
        }
        const operationPushOccurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
        const operationPushLogicalRepositories: LogicalRepository[] = logicalGroups.map((group) => ({
            normalizedIdentity: normalizeRepositoryIdentity(occurrenceById.get(group.canonicalOccurrenceId)!.originUrl) ?? ({ host: "opaque", owner: "opaque", repository: group.logicalId } as RepositoryIdentity),
            occurrenceIds: group.occurrenceIds, selectedBaseOccurrenceId: group.canonicalOccurrenceId, canonicalOccurrenceId: group.canonicalOccurrenceId,
            lastWriterOccurrenceId: group.occurrenceIds[group.occurrenceIds.length - 1], convergenceDigest: digestIds(group.occurrenceIds),
            consolidationState: group.occurrenceIds.length === 1 ? "single" : "grouped",
        }));
        await pushOperationBranches({ logicalRepositories: operationPushLogicalRepositories, occurrences: operationPushOccurrences }, token, digest);
        for (const occurrence of manifest.occurrences) { const liveOid = readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`); if (liveOid !== occurrence.baseOid) { abortReason = `the source branch moved past the pinned baseOid (pinned ${occurrence.baseOid}, now ${liveOid})`; return true; } }
        const tasksForValidation = sortedGroups.flatMap((group) => group.tasks.map((task) => ({ number: task.number, files: task.files })));
        const validationFailure = findTaskArchivalValidationFailure(tasksForValidation, manifest, coordinates, logicalGroups, consolidations);
        if (validationFailure !== null) { abortReason = validationFailure; return true; }
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
            const consolidation = consolidations.get(group.logicalId)!;
            return {
                name: group.logicalId, canonicalOccurrencePath: consolidation.canonicalRepoRoot, canonicalRefName: consolidation.canonicalRefName,
                otherOccurrences: group.occurrenceIds.filter((id) => id !== group.canonicalOccurrenceId).map((id) => ({ path: coordinates.get(id)!.repoRoot, refName: `refs/heads/${occurrenceById.get(id)!.baseBranch}` })),
                recordedBaseOid: consolidation.recordedBaseOid, targetOid: consolidation.preparedIntegrationOid,
            };
        });
        const rootConsolidation = consolidations.get(logicalGroups.find((g) => g.occurrenceIds.includes(rootOccurrence.occurrenceId))!.logicalId)!;
        const publicationResult = publishBases(publicationTargets, runState, { repoPath: rootConsolidation.canonicalRepoRoot, refName: rootConsolidation.integrationRef });
        if (!publicationResult.published) return true;
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => {
            const owningLogicalIds = taskFilesByLogicalId(task.files, manifest, coordinates, logicalGroups);
            return [...owningLogicalIds].map((logicalId) => ({
                taskNumber: task.number, repo: { repoName: logicalId, status: "published" as const, commitHash: consolidations.get(logicalId)!.preparedIntegrationOid },
            }));
        }));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        const archiveRequest: ArchiveRequest = { publishedTaskNumbers: sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults };
        endMetrics(0);
        printResult(summaryTargets, null, archiveRequest);
        return false;
    });
    if (aborted) { endMetrics(conflicts.length + 1); printResult([], abortReason); }
}

```

### scripts/runMergePhase.ts

```
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readCurrentRefOid } from "./basePublication.ts";
import type { CliInput } from "./mergePipeline.ts";
import { archivePublishedTasks, type ArchiveRequest, type TaskMergeResult } from "./taskArchival.ts";
import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";

export type StepOutputs = {
    done?: unknown[];
    partial?: unknown[];
    blocked?: unknown[];
    needsClarification?: unknown[];
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};

export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

export function buildMergeOutcomes(steps: StepOutputs) {
    return {
        doneCount: steps.done?.length ?? 0,
        partialCount: steps.partial?.length ?? 0,
        blockedCount: steps.blocked?.length ?? 0,
        needsClarificationCount: steps.needsClarification?.length ?? 0,
        requeueCount: steps.requeueCount ?? 0,
        testReceipts: steps.testReceipts ?? [],
        reviewHandoffs: steps.reviewHandoffs ?? [],
    };
}

type ScriptRun = { exitCode: number; stdout: string; stderr: string };

export function judgeMergeRun(run: ScriptRun, repo: string, failedCommand: string): MergePhaseVerdict {
    const blocked = (error: string, conflicts: unknown[], result: unknown): MergePhaseVerdict =>
        ({ status: "blocked", result, failure: { repo, failedCommand, conflicts, error } });
    if (run.exitCode !== 0) return blocked(`${run.exitCode}: ${run.stderr || run.stdout}`, [], null);
    let output: { conflicts?: unknown[]; publicationTargets?: unknown[] };
    try {
        output = JSON.parse(run.stdout);
    } catch {
        return blocked(`merge script printed output that is not JSON: ${run.stdout.slice(0, 500)}`, [], null);
    }
    if ((output.conflicts?.length ?? 0) > 0) return blocked("", output.conflicts!, output);
    if ((output.publicationTargets?.length ?? 0) === 0)
        return blocked("merge script exited clean but published nothing (publicationTargets is empty): the run was not ready for approval, or the source branch moved past its pinned baseOid before publish", [], output);
    return { status: "merged", result: output, failure: null };
}

function runScript(command: string[], cwd?: string): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}

function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}

function isArchiveRequest(value: unknown): value is ArchiveRequest {
    const request = value as Partial<ArchiveRequest> | null | undefined;
    return !!request && Array.isArray(request.publishedTaskNumbers) && Array.isArray(request.mergeResults);
}

// Requires the flag, at least one repo, and every repo published with a commit hash.
function isFullyPublishable(result: TaskMergeResult | undefined): result is TaskMergeResult {
    return !!result
        && result.fullyPublished
        && result.repos.length > 0
        && result.repos.every((repo) => repo.status === "published" && !!repo.commitHash);
}

// Every uniquely-requested task must resolve to exactly one fully-publishable mergeResult before archival is even attempted.
function archiveRequestIsComplete(request: ArchiveRequest): boolean {
    for (const taskNumber of new Set(request.publishedTaskNumbers)) {
        const matches = request.mergeResults.filter((result) => result.taskNumber === taskNumber);
        if (matches.length !== 1 || !isFullyPublishable(matches[0])) return false;
    }
    return true;
}

export function archiveIfMerged(
    verdict: MergePhaseVerdict,
    repo: string,
    failedCommand: string,
    archive: typeof archivePublishedTasks,
): MergePhaseVerdict {
    if (verdict.status !== "merged") return verdict;
    const archiveRequest = (verdict.result as { archiveRequest?: unknown } | null)?.archiveRequest;
    if (!isArchiveRequest(archiveRequest) || !archiveRequestIsComplete(archiveRequest)) {
        return blockedVerdict(repo, failedCommand, "merge script reported a merged verdict with no valid, complete archiveRequest; refusing to archive");
    }
    try {
        const { archived, leftOpen } = archive(archiveRequest.publishedTaskNumbers, archiveRequest.mergeResults, repo);
        const requested = new Set(archiveRequest.publishedTaskNumbers);
        const archivedSet = new Set(archived);
        const archivedEverything = requested.size === archivedSet.size && [...requested].every((taskNumber) => archivedSet.has(taskNumber));
        const noneLeftOpen = [...requested].every((taskNumber) => !leftOpen.includes(taskNumber));
        if (!archivedEverything || !noneLeftOpen) {
            return blockedVerdict(repo, failedCommand, `archival reported an incomplete result: archived [${archived.join(", ")}], leftOpen [${leftOpen.join(", ")}], requested [${[...requested].join(", ")}]`);
        }
        return verdict;
    } catch (error) {
        return blockedVerdict(repo, failedCommand, `archival failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean {
    const result = verdict.result as { abortReason?: string | null } | null;
    return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid");
}

function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean {
    return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict);
}

function describeRebaseFailure(outcome: RebaseOutcome): string {
    if (outcome.status === "conflicted") return `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`;
    if (outcome.status === "cleanup-failed") return outcome.failureReason;
    return "rebase reported unexpected clean status while being treated as a failure";
}

function occurrencePathInWorktree(repoRoot: string, worktree: string, checkoutPath: string): string {
    const absoluteCheckout = isAbsolute(checkoutPath) ? checkoutPath : join(repoRoot, checkoutPath);
    const relativePath = relative(resolve(repoRoot), absoluteCheckout);
    return relativePath === "" || relativePath === "." ? worktree : join(worktree, relativePath);
}

function mintFreshRunId(generate: () => string, oldRunId: string): string {
    const candidate = generate();
    return candidate === oldRunId ? `${candidate}-retry` : candidate;
}

function rewriteOperationBranches(
    occurrences: RepositoryOccurrence[],
    oldRunId: string,
    newRunId: string,
): RepositoryOccurrence[] | null {
    const oldPrefix = `operations/${oldRunId}/`;
    const rewritten: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        if (!occurrence.operationBranch.startsWith(oldPrefix)) return null;
        rewritten.push({ ...occurrence, operationBranch: `operations/${newRunId}/${occurrence.operationBranch.slice(oldPrefix.length)}` });
    }
    return rewritten;
}

function refreshBaseOids(
    repoRoot: string,
    occurrences: RepositoryOccurrence[],
    readRefOid: (repoRoot: string, ref: string) => string | null,
): RepositoryOccurrence[] | null {
    const refreshed: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        const checkoutRoot = isAbsolute(occurrence.checkoutPath) ? occurrence.checkoutPath : join(repoRoot, occurrence.checkoutPath);
        const oid = readRefOid(checkoutRoot, `refs/heads/${occurrence.baseBranch}`);
        if (oid === null) return null;
        refreshed.push({ ...occurrence, baseOid: oid });
    }
    return refreshed;
}

export type MergeRetryDeps = {
    runScript: (command: string[], cwd?: string) => ScriptRun;
    generateRunId: () => string;
    readRefOid: (repoRoot: string, ref: string) => string | null;
    writeRunArguments: (data: unknown) => void;
    rebaseGroupOntoSource: (worktreePath: string, sourceBranch: string) => RebaseOutcome;
    discoverTestPolicy: (occurrenceId: string, checkoutPath: string, resolutionManifest: ResolutionManifest) => TestPolicyResult;
};

export function coordinateMergeRetry(
    runArguments: CliInput,
    mergeCommand: string[],
    deps: MergeRetryDeps,
): MergePhaseVerdict {
    const sourceBranch = runArguments.repositorySources.find((source) => source.path === "")?.sourceBranch;
    if (!sourceBranch) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "no recorded source branch for repository root");

    for (const group of runArguments.groups) {
        const rebaseOutcome = deps.rebaseGroupOntoSource(group.worktree, sourceBranch);
        if (rebaseOutcome.status !== "rebased-clean") {
            return blockedVerdict(runArguments.repo, mergeCommand.join(" "), describeRebaseFailure(rebaseOutcome));
        }
        for (const occurrence of runArguments.repositoryManifest.occurrences) {
            const occurrencePath = occurrencePathInWorktree(runArguments.repo, group.worktree, occurrence.checkoutPath);
            const policyResult = deps.discoverTestPolicy(occurrence.occurrenceId, occurrencePath, createEmptyResolutionManifest());
            if (policyResult.status !== "resolved") {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `test policy unresolved for occurrence "${occurrence.occurrenceId}"`);
            }
            const testRun = deps.runScript(["sh", "-c", policyResult.policy.completeSuiteCommand], occurrencePath);
            if (testRun.exitCode !== 0) {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `post-rebase tests failed for occurrence "${occurrence.occurrenceId}": ${testRun.stderr || testRun.stdout}`);
            }
        }
    }

    const oldRunId = runArguments.runId;
    if (!oldRunId) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "run arguments carry no runId to retry from");
    const newRunId = mintFreshRunId(deps.generateRunId, oldRunId);
    const rewrittenOccurrences = rewriteOperationBranches(runArguments.repositoryManifest.occurrences, oldRunId, newRunId);
    if (rewrittenOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `an occurrence operationBranch does not carry the expected prefix "operations/${oldRunId}/"`);
    }
    const refreshedOccurrences = refreshBaseOids(runArguments.repo, rewrittenOccurrences, deps.readRefOid);
    if (refreshedOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "failed to read a refreshed base OID for an occurrence");
    }

    const updatedArguments: CliInput = {
        ...runArguments,
        runId: newRunId,
        repositoryManifest: { ...runArguments.repositoryManifest, occurrences: refreshedOccurrences },
    };
    deps.writeRunArguments(updatedArguments);

    const retryVerdict = judgeMergeRun(deps.runScript(mergeCommand), runArguments.repo, mergeCommand.join(" "));
    if (resultIndicatesBaseDrift(retryVerdict)) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "retry hit a second base-drift result; no further attempt");
    }
    return retryVerdict;
}

export function resolveMergeVerdict(
    initialVerdict: MergePhaseVerdict,
    readRunArguments: () => CliInput,
    mergeCommand: string[],
    deps: MergeRetryDeps,
): MergePhaseVerdict {
    if (!confirmedBaseDrift(initialVerdict)) return initialVerdict;
    // Re-read only here: a successful merge deletes run-arguments.json, so an unconditional read would throw.
    return coordinateMergeRetry(readRunArguments(), mergeCommand, deps);
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
    const runArgumentsPath = resolveRunArgumentsPath(repoRoot);
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile];
    const deps: MergeRetryDeps = {
        runScript,
        generateRunId,
        readRefOid: readCurrentRefOid,
        writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)),
        rebaseGroupOntoSource,
        discoverTestPolicy,
    };
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = resolveMergeVerdict(
        initialVerdict,
        () => JSON.parse(readFileSync(runArgumentsPath, "utf8")),
        command,
        deps,
    );
    const finalVerdict = archiveIfMerged(verdict, repoRoot, command.join(" "), archivePublishedTasks);
    process.stdout.write(JSON.stringify(finalVerdict));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/recoveryRefs.ts

```
// Run-scoped recovery snapshots under refs/recovery/..., without moving any branch or touching the real index.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readDirectGitlinks } from "./gitlinkReader.ts";
import { substituteGitlink } from "./repositoryIntegration.ts";

export type RecoverySnapshotKind = "worker" | "sync";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

export function recoveryRefName(runId: string, kind: RecoverySnapshotKind, snapshotId: string): string {
    return `refs/recovery/${runId}/${kind}/${snapshotId}`;
}

function resolveGitDir(repoPath: string): string {
    const gitDir = git(repoPath, "rev-parse", "--git-dir").trim();
    return isAbsolute(gitDir) ? gitDir : join(repoPath, gitDir);
}

// Throwaway index via GIT_INDEX_FILE so write-tree sees uncommitted changes, real index untouched.
function snapshotWorkingTreeToTree(repoPath: string): string {
    const indexPath = join(resolveGitDir(repoPath), `recovery-${randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
        execFileSync("git", ["-C", repoPath, "add", "-A"], { env });
        return execFileSync("git", ["-C", repoPath, "write-tree"], { encoding: "utf8", env }).trim();
    } finally {
        rmSync(indexPath, { force: true });
    }
}

// Snapshots repoPath, then substitutes each direct gitlink with a recursive snapshot of its own state.
function snapshotRepoRecursively(repoPath: string, message: string): string {
    const rawTreeSha = snapshotWorkingTreeToTree(repoPath);
    let commitSha = git(repoPath, "commit-tree", rawTreeSha, "-m", message).trim();
    for (const entry of readDirectGitlinks(repoPath, rawTreeSha)) {
        const nestedCommitSha = snapshotRepoRecursively(join(repoPath, entry.path), message);
        commitSha = substituteGitlink(repoPath, {
            parentCommitOid: commitSha,
            pathInParent: entry.path,
            childOid: nestedCommitSha,
        });
    }
    return commitSha;
}

function writeRecoverySnapshot(
    repoPath: string,
    runId: string,
    kind: RecoverySnapshotKind,
    snapshotId: string,
): Promise<string> {
    const commitSha = snapshotRepoRecursively(repoPath, `recovery: ${kind} ${snapshotId} (${runId})`);
    git(repoPath, "update-ref", recoveryRefName(runId, kind, snapshotId), commitSha);
    return Promise.resolve(commitSha);
}

export function snapshotWorkerRecovery(repoPath: string, runId: string, snapshotId: string): Promise<string> {
    return writeRecoverySnapshot(repoPath, runId, "worker", snapshotId);
}

export function snapshotSyncRecovery(repoPath: string, runId: string, snapshotId: string): Promise<string> {
    return writeRecoverySnapshot(repoPath, runId, "sync", snapshotId);
}

```

### scripts/runConsolidation.ts

```
// Phase 3 consolidation: fold occurrence branches into one operation branch per logical repository.
import { execFileSync } from "node:child_process";
import {
    prepareNoFfMerge,
    substituteGitlinksRecursively,
} from "./repositoryIntegration.ts";
import type { GitlinkChainLink, RepositoryQualifiedConflict } from "./repositoryIntegration.ts";
import { runFinalization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";

export interface GroupOccurrenceBranch {
    groupId: string;
    occurrencePath: string;
    occurrenceId: string;
    branchOid: string;
    sourceRepoRoot: string;
}

export interface LogicalRepositoryConsolidationInput {
    logicalRepositoryId: string;
    canonicalRepoRoot: string;
    canonicalOccurrenceBranchName: string;
    participatingBranches: GroupOccurrenceBranch[];
    approvedConvergedTreeOid: string;
    finalizedChildGitlinks: GitlinkChainLink[];
    recordedBaseOid: string;
    baseBranchRef: string;
}

export interface FastForwardedBranch {
    occurrenceId: string;
    branchRef: string;
    oid: string;
}

export interface RunConsolidationSuccess {
    logicalRepositoryId: string;
    operationBranchRef: string;
    operationOid: string;
    fastForwardedOccurrenceBranches: FastForwardedBranch[];
    preparedIntegrationOid: string;
}

export interface RunConsolidationAbort {
    logicalRepositoryId: string;
    aborted: {
        reason: "conflict" | "tree-mismatch";
        conflicts?: RepositoryQualifiedConflict[];
        preservedRefs: string[];
    };
}

export type RunConsolidationResult = RunConsolidationSuccess | RunConsolidationAbort;

function runGit(repoRoot: string, args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

export function sortParticipatingBranches(branches: GroupOccurrenceBranch[]): GroupOccurrenceBranch[] {
    return [...branches].sort((a, b) => {
        const groupCompare = a.groupId.localeCompare(b.groupId);
        if (groupCompare !== 0) return groupCompare;
        return a.occurrencePath.localeCompare(b.occurrencePath);
    });
}

// ponytail: branch ref = groupId/occurrencePath, the only fields that jointly identify a branch here.
function branchRefFor(branch: GroupOccurrenceBranch): string {
    return `refs/heads/${branch.groupId}/${branch.occurrencePath}`;
}

function fetchBranchIntoCanonicalRepo(canonicalRepoRoot: string, branch: GroupOccurrenceBranch): void {
    if (branch.sourceRepoRoot === canonicalRepoRoot) return;
    runGit(canonicalRepoRoot, ["fetch", branch.sourceRepoRoot, branch.branchOid]);
}

function foldMergeParticipatingBranches(
    canonicalRepoRoot: string,
    sorted: GroupOccurrenceBranch[],
    runId: string,
): { merged: true; assemblyOid: string } | { merged: false; conflict: RepositoryQualifiedConflict } {
    let assemblyOid = sorted[0].branchOid;
    for (let i = 1; i < sorted.length; i++) {
        const branch = sorted[i];
        fetchBranchIntoCanonicalRepo(canonicalRepoRoot, branch);
        const result = prepareNoFfMerge(
            canonicalRepoRoot,
            assemblyOid,
            branch.branchOid,
            `runConsolidation ${runId}: fold ${branch.groupId}/${branch.occurrencePath}`,
        );
        if (!result.merged) return result;
        assemblyOid = result.commitOid;
    }
    return { merged: true, assemblyOid };
}

function getTreeOidForCommit(repoRoot: string, commitOid: string): string {
    return runGit(repoRoot, ["rev-parse", `${commitOid}^{tree}`]);
}

function computeExpectedTreeOid(approvedConvergedTreeOid: string, finalizedChildGitlinks: GitlinkChainLink[]): string {
    if (finalizedChildGitlinks.length === 0) return approvedConvergedTreeOid;
    const { rootCommitOid } = substituteGitlinksRecursively(finalizedChildGitlinks, approvedConvergedTreeOid);
    return getTreeOidForCommit(finalizedChildGitlinks[0].repoRoot, rootCommitOid);
}

function buildOperationBranchRef(runId: string, canonicalOccurrenceBranchName: string): string {
    return `refs/heads/operations/${runId}/${canonicalOccurrenceBranchName}`;
}

function moveRefFastForward(repoRoot: string, refName: string, newOid: string, expectedOldOid?: string): void {
    const args = expectedOldOid === undefined ? [refName, newOid] : [refName, newOid, expectedOldOid];
    runGit(repoRoot, ["update-ref", ...args]);
}

export function consolidateLogicalRepository(
    input: LogicalRepositoryConsolidationInput,
    runId: string,
): RunConsolidationResult {
    const { logicalRepositoryId, canonicalRepoRoot, canonicalOccurrenceBranchName, baseBranchRef, recordedBaseOid } =
        input;
    const sorted = sortParticipatingBranches(input.participatingBranches);
    const preservedRefs = [baseBranchRef, ...sorted.map(branchRefFor)];

    const foldResult = foldMergeParticipatingBranches(canonicalRepoRoot, sorted, runId);
    if (!foldResult.merged) {
        return {
            logicalRepositoryId,
            aborted: { reason: "conflict", conflicts: [foldResult.conflict], preservedRefs },
        };
    }
    const { assemblyOid } = foldResult;

    const actualTreeOid = getTreeOidForCommit(canonicalRepoRoot, assemblyOid);
    const expectedTreeOid = computeExpectedTreeOid(input.approvedConvergedTreeOid, input.finalizedChildGitlinks);
    if (actualTreeOid !== expectedTreeOid) {
        return { logicalRepositoryId, aborted: { reason: "tree-mismatch", preservedRefs } };
    }

    const integrationResult = prepareNoFfMerge(
        canonicalRepoRoot,
        recordedBaseOid,
        assemblyOid,
        `runConsolidation ${runId}: integrate ${logicalRepositoryId}`,
    );
    if (!integrationResult.merged) {
        return {
            logicalRepositoryId,
            aborted: { reason: "conflict", conflicts: [integrationResult.conflict], preservedRefs },
        };
    }

    const operationBranchRef = buildOperationBranchRef(runId, canonicalOccurrenceBranchName);
    moveRefFastForward(canonicalRepoRoot, operationBranchRef, assemblyOid);

    const fastForwardedOccurrenceBranches: FastForwardedBranch[] = sorted.map((branch) => {
        const branchRef = branchRefFor(branch);
        moveRefFastForward(canonicalRepoRoot, branchRef, assemblyOid, branch.branchOid);
        return { occurrenceId: branch.occurrenceId, branchRef, oid: assemblyOid };
    });

    return {
        logicalRepositoryId,
        operationBranchRef,
        operationOid: assemblyOid,
        fastForwardedOccurrenceBranches,
        preparedIntegrationOid: integrationResult.commitOid,
    };
}

function validateRunAuthorization(token: RunAuthorizationToken, currentStateDigest: string): void {
    runFinalization(token, currentStateDigest, () => undefined);
}

export function consolidateRun(
    runId: string,
    logicalRepositories: LogicalRepositoryConsolidationInput[],
    token: RunAuthorizationToken,
    currentStateDigest: string,
): RunConsolidationResult[] {
    validateRunAuthorization(token, currentStateDigest);
    return logicalRepositories.map((input) => consolidateLogicalRepository(input, runId));
}

```

### scripts/repositoryIntegration.ts

```
// Gitlink substitution and prepared no-ff merge primitives. Neither moves a branch or touches a base ref.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitlinkSubstitution = {
    parentCommitOid: string;
    pathInParent: string;
    childOid: string;
};

export type RepositoryQualifiedConflict = {
    repoRoot: string;
    conflictedPaths: string[];
};

export type PrepareMergeResult =
    | { merged: true; commitOid: string }
    | { merged: false; conflict: RepositoryQualifiedConflict };

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function gitlinkModeAtPath(repoRoot: string, commitOid: string, path: string): string | null {
    const line = git(repoRoot, "ls-tree", commitOid, "--", path).trim();
    if (line === "") return null;
    return line.split(" ")[0];
}

// Replaces one gitlink entry via scratch-index tree surgery, then commits the new tree. No ref touched.
export function substituteGitlink(repoRoot: string, substitution: GitlinkSubstitution): string {
    const { parentCommitOid, pathInParent, childOid } = substitution;
    if (gitlinkModeAtPath(repoRoot, parentCommitOid, pathInParent) !== "160000") {
        throw new Error(`"${pathInParent}" is not a gitlink in commit ${parentCommitOid}`);
    }
    const scratchIndex = join(tmpdir(), `repo-integration-${randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    try {
        execFileSync("git", ["-C", repoRoot, "read-tree", parentCommitOid], { env });
        execFileSync(
            "git",
            ["-C", repoRoot, "update-index", "--add", "--cacheinfo", `160000,${childOid},${pathInParent}`],
            { env },
        );
        const newTreeOid = execFileSync("git", ["-C", repoRoot, "write-tree"], { encoding: "utf8", env }).trim();
        return git(
            repoRoot,
            "commit-tree",
            newTreeOid,
            "-p",
            parentCommitOid,
            "-m",
            `substitute gitlink at ${pathInParent} -> ${childOid}`,
        ).trim();
    } finally {
        rmSync(scratchIndex, { force: true });
    }
}

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

// Parses merge-tree conflict output: skip the tree-OID line, take the path from each remaining line.
function parseConflictedPaths(mergeTreeOutput: string): string[] {
    const [fileInfoBlock = ""] = mergeTreeOutput.split("\n\n");
    const [, ...fileInfoLines] = fileInfoBlock.split("\n");
    const paths = fileInfoLines.filter(Boolean).map((line) => line.split("\t")[1]);
    return [...new Set(paths)];
}

// Prepares a --no-ff merge commit via merge-tree plumbing. Returns the commit OID or conflict info.
export function prepareNoFfMerge(
    repoRoot: string,
    baseOid: string,
    tipOid: string,
    message: string,
): PrepareMergeResult {
    try {
        const treeOid = git(repoRoot, "merge-tree", "--write-tree", baseOid, tipOid).trim();
        const commitOid = git(repoRoot, "commit-tree", treeOid, "-p", baseOid, "-p", tipOid, "-m", message).trim();
        return { merged: true, commitOid };
    } catch (error) {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        return { merged: false, conflict: { repoRoot, conflictedPaths: parseConflictedPaths(stdout) } };
    }
}

```

### scripts/basePublication.ts

```
// basePublication.ts: local base publication with CAS, whole-run rollback, and recovery reporting.  Phase 4 of the recursive repository-discovery redesign.
import { spawnSync } from "node:child_process";
import { checkAuthorizationDrift } from "./approvalGate.ts";
import type { RunState } from "./approvalGate.ts";

export type PublicationTarget = {
    name: string;
    canonicalOccurrencePath: string;
    canonicalRefName: string;
    otherOccurrences: { path: string; refName: string }[];
    recordedBaseOid: string;
    targetOid: string;
};

export type UpdatedRef = {
    repoName: string;
    occurrencePath: string;
    refName: string;
    recordedOid: string;
    newOid: string;
};

export type RollbackOutcome = {
    ref: UpdatedRef;
    rolledBack: boolean;
    recoveryCommand: string;
};

export type PublicationResult = {
    published: boolean;
    rollback: RollbackOutcome[];
};

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
    const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
    return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

export function readCurrentRefOid(repoPath: string, refName: string): string | null {
    const result = runGit(repoPath, ["rev-parse", "--verify", "--quiet", refName]);
    return result.ok ? result.stdout.trim() : null;
}

export function checkRootIntegrationOidExists(repoPath: string, rootIntegrationRef: string): boolean {
    return readCurrentRefOid(repoPath, rootIntegrationRef) !== null;
}

export function revalidateRecordedBaseOids(repos: PublicationTarget[]): { ok: boolean; moved: PublicationTarget[] } {
    const moved = repos.filter(
        (repo) => readCurrentRefOid(repo.canonicalOccurrencePath, repo.canonicalRefName) !== repo.recordedBaseOid,
    );
    return { ok: moved.length === 0, moved };
}

export function revalidateApprovalInputs(approvalState: RunState): boolean {
    return checkAuthorizationDrift(approvalState);
}

export function publishCanonicalRef(repo: PublicationTarget): { ok: boolean; updated?: UpdatedRef } {
    const result = runGit(repo.canonicalOccurrencePath, [
        "update-ref",
        repo.canonicalRefName,
        repo.targetOid,
        repo.recordedBaseOid,
    ]);
    if (!result.ok) return { ok: false };
    return {
        ok: true,
        updated: {
            repoName: repo.name,
            occurrencePath: repo.canonicalOccurrencePath,
            refName: repo.canonicalRefName,
            recordedOid: repo.recordedBaseOid,
            newOid: repo.targetOid,
        },
    };
}

export function fastForwardOtherOccurrences(
    repo: PublicationTarget,
): { ok: boolean; updated: UpdatedRef[]; failedAt?: string } {
    const updated: UpdatedRef[] = [];
    for (const occurrence of repo.otherOccurrences) {
        // No --force: a plain "src:dst" fetch refspec already refuses a non-fast-forward move.
        const result = runGit(occurrence.path, [
            "fetch",
            repo.canonicalOccurrencePath,
            `${repo.canonicalRefName}:${occurrence.refName}`,
        ]);
        if (!result.ok) {
            return { ok: false, updated, failedAt: occurrence.path };
        }
        updated.push({
            repoName: repo.name,
            occurrencePath: occurrence.path,
            refName: occurrence.refName,
            recordedOid: repo.recordedBaseOid,
            newOid: repo.targetOid,
        });
    }
    return { ok: true, updated };
}

export function formatRecoveryCommand(ref: UpdatedRef): string {
    return `git -C ${ref.occurrencePath} update-ref ${ref.refName} ${ref.recordedOid}`;
}

export function rollbackUpdatedRefs(updated: UpdatedRef[]): RollbackOutcome[] {
    return updated.map((ref) => {
        const result = runGit(ref.occurrencePath, ["update-ref", ref.refName, ref.recordedOid, ref.newOid]);
        return { ref, rolledBack: result.ok, recoveryCommand: formatRecoveryCommand(ref) };
    });
}

export function publishBases(
    repos: PublicationTarget[],
    approvalState: RunState,
    rootIntegration: { repoPath: string; refName: string },
): PublicationResult {
    if (!checkRootIntegrationOidExists(rootIntegration.repoPath, rootIntegration.refName)) {
        return { published: false, rollback: [] };
    }
    if (!revalidateApprovalInputs(approvalState)) {
        return { published: false, rollback: [] };
    }
    if (!revalidateRecordedBaseOids(repos).ok) {
        return { published: false, rollback: [] };
    }

    const updatedSoFar: UpdatedRef[] = [];
    let pass2Failed = false;
    for (const repo of repos) {
        const canonicalResult = publishCanonicalRef(repo);
        if (!canonicalResult.ok) {
            pass2Failed = true;
            break;
        }
        updatedSoFar.push(canonicalResult.updated!);

        const fastForwardResult = fastForwardOtherOccurrences(repo);
        updatedSoFar.push(...fastForwardResult.updated);
        if (!fastForwardResult.ok) {
            pass2Failed = true;
            break;
        }
    }

    if (!pass2Failed) {
        return { published: true, rollback: [] };
    }
    return { published: false, rollback: rollbackUpdatedRefs(updatedSoFar) };
}

```

### tests/basePublication.test.ts

```
// Behavioral checks for basePublication.ts: local base publication with CAS, rollback, recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    publishBases,
    publishCanonicalRef,
    rollbackUpdatedRefs,
} from "../scripts/basePublication.ts";
import type { PublicationTarget, UpdatedRef } from "../scripts/basePublication.ts";
import type { RunState } from "../scripts/approvalGate.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "base-publication-"));
    git(repoRoot, "init", "-q", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    return repoRoot;
}

function commitFile(repoPath: string, fileName: string, content: string): string {
    writeFileSync(join(repoPath, fileName), content);
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-q", "-m", fileName);
    return git(repoPath, "rev-parse", "HEAD");
}

function approvedRunState(): RunState {
    return {
        readyForApproval: true,
        status: "approved",
        digestInput: {
            manifest: { version: 1, occurrences: [] },
            files: [],
            operationRef: "refs/operation/1",
            baseRef: "refs/heads/main",
            occurrenceDigests: [],
            testReceipts: [],
            reviewHandoffs: [],
        },
    };
}

function makeRootIntegration(exists: boolean): { repoPath: string; refName: string } {
    const repoPath = makeRepo();
    const refName = "refs/finalize/run-1/tip/root";
    if (exists) {
        const oid = commitFile(repoPath, "root.txt", "root");
        git(repoPath, "update-ref", refName, oid);
    }
    return { repoPath, refName };
}

// Canonical repo: recordedBaseOid on canonicalRefName, later commit as targetOid on "main".
function makeLogicalRepoFixture(name: string): { repo: PublicationTarget; otherPath: string } {
    const canonicalPath = makeRepo();
    const recordedBaseOid = commitFile(canonicalPath, "seed.txt", "seed");
    git(canonicalPath, "update-ref", "refs/heads/base", recordedBaseOid);
    const targetOid = commitFile(canonicalPath, "update.txt", "update");

    const otherPath = makeRepo();
    git(otherPath, "fetch", canonicalPath, "refs/heads/base:refs/heads/base");

    return {
        otherPath,
        repo: {
            name,
            canonicalOccurrencePath: canonicalPath,
            canonicalRefName: "refs/heads/base",
            otherOccurrences: [{ path: otherPath, refName: "refs/heads/base" }],
            recordedBaseOid,
            targetOid,
        },
    };
}

test("test_nothingPublishesBeforeRootIntegrationOidExists", () => {
    const { repo } = makeLogicalRepoFixture("repo-a");
    const rootIntegration = makeRootIntegration(false);

    const result = publishBases([repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 0);
    assert.equal(git(repo.canonicalOccurrencePath, "rev-parse", repo.canonicalRefName), repo.recordedBaseOid);
});

test("test_baseRefMovedSinceApprovalBlocksPublicationEntirely", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");
    const rootIntegration = makeRootIntegration(true);

    // Simulate a concurrent mover advancing repo A's canonical ref before publication runs.
    git(fixtureA.repo.canonicalOccurrencePath, "update-ref", "refs/heads/base", fixtureA.repo.targetOid);

    const result = publishBases([fixtureA.repo, fixtureB.repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 0);
    assert.equal(
        git(fixtureB.repo.canonicalOccurrencePath, "rev-parse", fixtureB.repo.canonicalRefName),
        fixtureB.repo.recordedBaseOid,
    );
});

test("test_compareAndSwapPreventsClobberingConcurrentUpdate", () => {
    const { repo } = makeLogicalRepoFixture("repo-a");
    const concurrentOid = commitFile(repo.canonicalOccurrencePath, "concurrent.txt", "concurrent");
    // A concurrent mover sets the canonical ref to concurrentOid; repo.recordedBaseOid is now stale.
    git(repo.canonicalOccurrencePath, "update-ref", repo.canonicalRefName, concurrentOid);

    const result = publishCanonicalRef(repo);

    assert.equal(result.ok, false);
    assert.equal(git(repo.canonicalOccurrencePath, "rev-parse", repo.canonicalRefName), concurrentOid);
});

test("test_midSequenceFailureRollsBackEveryAlreadyUpdatedRefToRecordedOid", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");
    const fixtureC = makeLogicalRepoFixture("repo-c");
    const rootIntegration = makeRootIntegration(true);

    // Force repo C's canonical CAS to fail without tripping pass-1: recordedBaseOid still matches, but targetOid is nonexistent.
    const failingRepoC: PublicationTarget = { ...fixtureC.repo, targetOid: "a".repeat(40) };

    const result = publishBases([fixtureA.repo, fixtureB.repo, failingRepoC], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    for (const fixture of [fixtureA, fixtureB]) {
        assert.equal(
            git(fixture.repo.canonicalOccurrencePath, "rev-parse", fixture.repo.canonicalRefName),
            fixture.repo.recordedBaseOid,
        );
        assert.equal(git(fixture.otherPath, "rev-parse", fixture.repo.otherOccurrences[0].refName), fixture.repo.recordedBaseOid);
    }
});

test("test_failingRollbackPreservesIntegrationAndRecoveryRefsAndReportsExactCommandPerRepository", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");

    const integrationRepo = makeRepo();
    const integrationRef = "refs/finalize/run-9/tip/root";
    git(integrationRepo, "update-ref", integrationRef, commitFile(integrationRepo, "root.txt", "root"));
    const recoveryRef = "refs/recovery/run-9/worker/w1";
    git(integrationRepo, "update-ref", recoveryRef, git(integrationRepo, "rev-parse", "HEAD"));
    const integrationOidBefore = git(integrationRepo, "rev-parse", integrationRef);
    const recoveryOidBefore = git(integrationRepo, "rev-parse", recoveryRef);

    // Simulate what a successful pass-2 would have collected for repos A and B.
    const updatedSoFar: UpdatedRef[] = [];
    for (const fixture of [fixtureA, fixtureB]) {
        const canonicalResult = publishCanonicalRef(fixture.repo);
        assert.equal(canonicalResult.ok, true);
        updatedSoFar.push(canonicalResult.updated!);
        git(
            fixture.otherPath,
            "fetch",
            fixture.repo.canonicalOccurrencePath,
            `${fixture.repo.canonicalRefName}:${fixture.repo.otherOccurrences[0].refName}`,
        );
        updatedSoFar.push({
            repoName: fixture.repo.name,
            occurrencePath: fixture.otherPath,
            refName: fixture.repo.otherOccurrences[0].refName,
            recordedOid: fixture.repo.recordedBaseOid,
            newOid: fixture.repo.targetOid,
        });
    }

    // A concurrent actor moves repo A's canonical ref again, after publish but before rollback.
    const concurrentOid = commitFile(fixtureA.repo.canonicalOccurrencePath, "concurrent.txt", "concurrent");
    git(fixtureA.repo.canonicalOccurrencePath, "update-ref", fixtureA.repo.canonicalRefName, concurrentOid);

    const outcomes = rollbackUpdatedRefs(updatedSoFar);

    const repoAOutcome = outcomes.find(
        (outcome) => outcome.ref.repoName === "repo-a" && outcome.ref.occurrencePath === fixtureA.repo.canonicalOccurrencePath,
    )!;
    const repoBOutcome = outcomes.find(
        (outcome) => outcome.ref.repoName === "repo-b" && outcome.ref.occurrencePath === fixtureB.repo.canonicalOccurrencePath,
    )!;

    assert.equal(repoBOutcome.rolledBack, true);
    assert.equal(repoAOutcome.rolledBack, false);
    assert.equal(
        repoAOutcome.recoveryCommand,
        `git -C ${fixtureA.repo.canonicalOccurrencePath} update-ref ${fixtureA.repo.canonicalRefName} ${fixtureA.repo.recordedBaseOid}`,
    );
    assert.equal(git(integrationRepo, "rev-parse", integrationRef), integrationOidBefore);
    assert.equal(git(integrationRepo, "rev-parse", recoveryRef), recoveryOidBefore);
});

test("test_otherOccurrencesFastForwardLocallyWithoutRemotePush", () => {
    const { repo, otherPath } = makeLogicalRepoFixture("repo-a");
    const rootIntegration = makeRootIntegration(true);

    const result = publishBases([repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, true);
    assert.equal(git(otherPath, "rev-parse", repo.otherOccurrences[0].refName), repo.targetOid);
    assert.equal(git(otherPath, "remote"), "");
});

```
