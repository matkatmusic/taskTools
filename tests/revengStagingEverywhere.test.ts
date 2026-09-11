// Proves resolveOrCreateStagingTipEverywhere's discovery-gated bug on the deep-nested RevEng graph, then runs the spawn/commit/rebase/merge matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./support/gitFixtures.ts";
import { commitOnStaging, commitTaskWork as sharedCommitTaskWork, refPresent, gitlinkAt } from "./mergeStaging/support.ts";
import { makeRevengGraphFixture, REVENG_OCCURRENCE_IDS } from "./fixtures/revengGraph.ts";
import { resolveOrCreateStagingTipEverywhere } from "../scripts/shared/prepareTasks.ts";
import { claimTask } from "../scripts/tackle-tasks/shared/taskRunState.ts";
import { createTaskWorktree } from "../scripts/tackle-tasks/shared/createTaskWorktree.ts";
import { main as rebaseMain } from "../scripts/tackle-tasks/rebase/REBASE_ONTO_TARGET_BRANCH.ts";
import { main as mergeMain } from "../scripts/tackle-tasks/runFullSuite/MERGE_WORKTREES.ts";

function fixtureTmpRoot(fixture: { rootPath: string }): string {
    return dirname(fixture.rootPath);
}

test("test_stagingEverywhere_createsStagingInEveryRepoWhenASubmoduleTipMovedPastTheRecordedGitlink", () => {
    const fixture = makeRevengGraphFixture();
    try {
        // Root branch "Layer3-9" records jfred at gitlinkA (unchanged: we never re-commit the gitlink).
        git(fixture.rootPath, "checkout", "-q", "-b", "Layer3-9");
        const jfredPath = fixture.occurrencePaths.jfred;
        const gitlinkA = git(jfredPath, "rev-parse", "HEAD");
        git(jfredPath, "branch", "Layer3-9");
        git(jfredPath, "checkout", "-q", "Layer3-9");
        writeFileSync(join(jfredPath, "advance.txt"), "advance\n");
        git(jfredPath, "add", "advance.txt");
        git(jfredPath, "commit", "-q", "-m", "advance past recorded gitlink");
        const gitlinkB = git(jfredPath, "rev-parse", "HEAD");
        assert.notEqual(gitlinkB, gitlinkA, "jfred's tip must move past the recorded gitlink");
        // No jfred branch sits at gitlinkA any more (main was the only other branch there).
        git(jfredPath, "branch", "-D", "main");

        // No repo anywhere has "staging" yet.
        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            const path = fixture.occurrencePaths[occurrenceId];
            assert.throws(() => git(path, "rev-parse", "--verify", "staging"), `${occurrenceId || "root"} must start with no staging branch`);
        }

        const tips = resolveOrCreateStagingTipEverywhere(fixture.rootPath);

        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            assert.ok(tips.has(occurrenceId), `missing tip for "${occurrenceId || "root"}" in the returned map`);
            const path = fixture.occurrencePaths[occurrenceId];
            const stagingTip = git(path, "rev-parse", "--verify", "staging");
            const head = git(path, "rev-parse", "HEAD");
            assert.equal(stagingTip, head, `${occurrenceId || "root"}: staging must be created at that repo's HEAD`);
            assert.equal(tips.get(occurrenceId), stagingTip, `${occurrenceId || "root"}: returned tip must match the created staging tip`);
        }
    } finally {
        rmSync(fixtureTmpRoot(fixture), { recursive: true, force: true });
    }
});

function worktreeCheckoutPath(worktree: string, occurrenceId: string): string {
    return occurrenceId === "" ? worktree : join(worktree, occurrenceId);
}

// Superseded by the shared, depth-generalized commitTaskWork in mergeStaging/support.ts (used below).
// function commitTaskWork(worktree: string, occurrenceId: string, relFile: string, content: string): string {
//     const dir = worktreeCheckoutPath(worktree, occurrenceId);
//     writeFileSync(join(dir, relFile), content);
//     git(dir, "add", relFile);
//     git(dir, "commit", "-q", "-m", `task work: ${relFile}`);
//     const workCommit = git(dir, "rev-parse", "HEAD");
//     if (occurrenceId !== "") {
//         const lastSlash = occurrenceId.lastIndexOf("/");
//         const parentOccurrenceId = lastSlash === -1 ? "" : occurrenceId.slice(0, lastSlash);
//         const pathInParent = lastSlash === -1 ? occurrenceId : occurrenceId.slice(lastSlash + 1);
//         const parentDir = worktreeCheckoutPath(worktree, parentOccurrenceId);
//         git(parentDir, "add", pathInParent);
//         git(parentDir, "commit", "-q", "-m", `bump ${pathInParent} gitlink`);
//     }
//     return workCommit;
// }

// Bridges the two "root" sentinels: shared commitTaskWork uses "root", this file's fixture uses "".
function commitTaskWorkAt(worktree: string, occurrenceId: string, relFile: string, content: string): string {
    sharedCommitTaskWork(worktree, occurrenceId === "" ? "root" : occurrenceId, relFile, content);
    return git(worktreeCheckoutPath(worktree, occurrenceId), "rev-parse", "HEAD");
}

test("test_pipeline_worktreeCommitRebaseMerge_expectationsPerRepo", async () => {
    const TASK_NUMBER = 91;
    const RUN_ID = "run-revengPipeline";
    const BRANCH = `task-${TASK_NUMBER}`;
    const fixture = makeRevengGraphFixture();
    try {
        // a. Spawn the task worktree.
        writeFileSync(
            join(fixture.rootPath, "tasks.json"),
            `${JSON.stringify([{ taskNumber: TASK_NUMBER, title: "t", modifiableFiles: [] }], null, 2)}\n`,
        );
        claimTask(TASK_NUMBER, RUN_ID, fixture.rootPath);
        const { worktree, branch } = createTaskWorktree(TASK_NUMBER, RUN_ID, fixture.rootPath);
        assert.equal(branch, BRANCH);

        const baselineTip = new Map<string, string>();
        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            const sourcePath = fixture.occurrencePaths[occurrenceId];
            const expectedTip = git(sourcePath, "rev-parse", "staging");
            baselineTip.set(occurrenceId, expectedTip);
            assert.equal(git(sourcePath, "rev-parse", BRANCH), expectedTip, `${occurrenceId || "root"}: source task-N tip`);
            assert.equal(
                git(sourcePath, "rev-parse", `refs/taskTools/reset-point/${BRANCH}`),
                expectedTip,
                `${occurrenceId || "root"}: reset-point tip`,
            );
            const worktreeRepoPath = worktreeCheckoutPath(worktree, occurrenceId);
            assert.equal(git(worktreeRepoPath, "branch", "--show-current"), BRANCH, `${occurrenceId || "root"}: worktree branch`);
            assert.equal(git(worktreeRepoPath, "rev-parse", "HEAD"), expectedTip, `${occurrenceId || "root"}: worktree HEAD`);
        }

        // b. Commit work at three levels: root, jfred, jfred/jfredToolsPlugin.
        const touchedIds = ["", "jfred", "jfred/jfredToolsPlugin"];
        const workFile: Record<string, string> = {
            "": "root-work.txt",
            jfred: "jfred-work.txt",
            "jfred/jfredToolsPlugin": "plugin-work.txt",
        };
        const workCommit = new Map<string, string>();
        workCommit.set("", commitTaskWorkAt(worktree, "", workFile[""], "root work\n"));
        workCommit.set("jfred", commitTaskWorkAt(worktree, "jfred", workFile.jfred, "jfred work\n"));
        workCommit.set(
            "jfred/jfredToolsPlugin",
            commitTaskWorkAt(worktree, "jfred/jfredToolsPlugin", workFile["jfred/jfredToolsPlugin"], "plugin work\n"),
        );

        // commitTaskWork walks every ancestor, so root and jfred pick up bump commits from each descendant's call.
        const expectedCommitsAhead: Record<string, number> = { "": 3, jfred: 2, "jfred/jfredToolsPlugin": 1 };
        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            const worktreeRepoPath = worktreeCheckoutPath(worktree, occurrenceId);
            const tipAfterCommits = git(worktreeRepoPath, "rev-parse", "HEAD");
            if (occurrenceId in expectedCommitsAhead) {
                const distance = git(worktreeRepoPath, "rev-list", "--count", `${baselineTip.get(occurrenceId)}..HEAD`);
                assert.equal(distance, String(expectedCommitsAhead[occurrenceId]), `${occurrenceId || "root"}: unexpected commit count ahead of baseline`);
            } else {
                assert.equal(tipAfterCommits, baselineTip.get(occurrenceId), `${occurrenceId}: should be untouched by commitTaskWork`);
            }
        }

        // c. Move staging in the SOURCE root and SOURCE jfred, then rebase.
        commitOnStaging(fixture.rootPath, "staging-move.txt", "root staging moved\n");
        commitOnStaging(fixture.occurrencePaths.jfred, "staging-move.txt", "jfred staging moved\n");
        const movedStagingTip = new Map<string, string>();
        movedStagingTip.set("", git(fixture.rootPath, "rev-parse", "staging"));
        movedStagingTip.set("jfred", git(fixture.occurrencePaths.jfred, "rev-parse", "staging"));

        const rebasePacket = () => JSON.stringify({
            box: "WAS_LOCK_ACQUIRED_Q", scriptSignal: "continue",
            taskNumber: TASK_NUMBER, runId: RUN_ID, projectRoot: fixture.rootPath,
            worktree, branch: BRANCH, exitType: "", exitNote: "",
        });

        // c0. A hand command, not a pipeline block, leaves a tracked file dirty in jfred; not task work.
        const jfredWorktreePath = worktreeCheckoutPath(worktree, "jfred");
        const originalSeedContent = readFileSync(join(jfredWorktreePath, "seed.txt"), "utf8");
        writeFileSync(join(jfredWorktreePath, "seed.txt"), "leftover churn from an earlier run\n");

        await assert.rejects(
            rebaseMain(rebasePacket()),
            (error: Error) => {
                assert.match(error.message, /jfred/, "error must name the occurrence");
                assert.match(error.message, /seed\.txt/, "error must name the dirty path");
                return true;
            },
            "rebase must refuse while an unowned tracked file is dirty, not silently discard it",
        );

        // The pipeline must not have touched it; a human restores it, same as production.
        assert.equal(
            readFileSync(join(jfredWorktreePath, "seed.txt"), "utf8"),
            "leftover churn from an earlier run\n",
            "the pipeline must never discard the dirty file itself",
        );
        writeFileSync(join(jfredWorktreePath, "seed.txt"), originalSeedContent);

        const rebaseResult1 = await rebaseMain(rebasePacket());
        assert.equal(rebaseResult1.conflicted, false, `rebase 1 conflicted: ${JSON.stringify(rebaseResult1)}`);
        assert.equal(rebaseResult1.failureReason, "", "rebase 1 failureReason");

        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            const worktreeRepoPath = worktreeCheckoutPath(worktree, occurrenceId);
            if (movedStagingTip.has(occurrenceId)) {
                assert.doesNotThrow(
                    () => git(worktreeRepoPath, "merge-base", "--is-ancestor", movedStagingTip.get(occurrenceId)!, "HEAD"),
                    `${occurrenceId || "root"}: task-N not rebased onto the moved staging tip`,
                );
            }
            if (touchedIds.includes(occurrenceId)) {
                assert.doesNotThrow(
                    () => readFileSync(join(worktreeRepoPath, workFile[occurrenceId])),
                    `${occurrenceId || "root"}: work file missing after rebase`,
                );
            } else {
                assert.equal(
                    git(worktreeRepoPath, "rev-parse", "HEAD"),
                    baselineTip.get(occurrenceId),
                    `${occurrenceId}: unexpectedly changed by rebase`,
                );
            }
        }

        // Rebase rewrites commit hashes, so re-resolve each work commit by message after rebasing.
        for (const occurrenceId of touchedIds) {
            const worktreeRepoPath = worktreeCheckoutPath(worktree, occurrenceId);
            const rewrittenHash = git(worktreeRepoPath, "log", "--format=%H", `--grep=^task work: ${workFile[occurrenceId]}$`, "-1", "HEAD");
            workCommit.set(occurrenceId, rewrittenHash);
        }

        // d. Merge.
        const mergePacket = () => JSON.stringify({
            box: "DID_CHANGES_STAY_INSIDE_FENCE_Q", scriptSignal: "continue",
            taskNumber: TASK_NUMBER, runId: RUN_ID, projectRoot: fixture.rootPath,
            worktree, branch: BRANCH, exitType: "", exitNote: "",
        });

        const mergeResult1 = mergeMain(mergePacket()) as { merged: boolean; failureReason: string };
        assert.equal(mergeResult1.merged, true, `merge 1 failed: ${JSON.stringify(mergeResult1)}`);

        const stagingAfterMerge = new Map<string, string>();
        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            const sourcePath = fixture.occurrencePaths[occurrenceId];
            const stagingTip = git(sourcePath, "rev-parse", "staging");
            stagingAfterMerge.set(occurrenceId, stagingTip);
            assert.ok(refPresent(sourcePath, `refs/taskTools/merged-commits/${BRANCH}`), `${occurrenceId || "root"}: missing merged-commits ref`);
            if (touchedIds.includes(occurrenceId)) {
                const parents = git(sourcePath, "log", "-1", "--format=%P", stagingTip).split(" ").filter(Boolean);
                assert.equal(parents.length, 2, `${occurrenceId || "root"}: staging tip is not a merge commit`);
                assert.doesNotThrow(
                    () => git(sourcePath, "merge-base", "--is-ancestor", workCommit.get(occurrenceId)!, "staging"),
                    `${occurrenceId || "root"}: work commit not reachable from staging after merge`,
                );
            } else {
                assert.equal(stagingTip, baselineTip.get(occurrenceId), `${occurrenceId}: staging moved despite no task work`);
            }
        }
        assert.equal(
            gitlinkAt(fixture.rootPath, "staging", "jfred"),
            stagingAfterMerge.get("jfred"),
            "root staging's gitlink for jfred must equal jfred's new staging tip",
        );

        // e. Rerun both steps with no new work: idempotent, nothing moves further.
        const rebaseResult2 = await rebaseMain(rebasePacket());
        assert.equal(rebaseResult2.conflicted, false, `rebase rerun conflicted: ${JSON.stringify(rebaseResult2)}`);
        assert.equal(rebaseResult2.failureReason, "", "rebase rerun failureReason");

        const mergeResult2 = mergeMain(mergePacket()) as { merged: boolean; failureReason: string };
        assert.equal(mergeResult2.merged, true, `merge rerun failed: ${JSON.stringify(mergeResult2)}`);

        for (const occurrenceId of REVENG_OCCURRENCE_IDS) {
            const sourcePath = fixture.occurrencePaths[occurrenceId];
            assert.equal(
                git(sourcePath, "rev-parse", "staging"),
                stagingAfterMerge.get(occurrenceId),
                `${occurrenceId || "root"}: staging moved on the rerun`,
            );
        }
    } finally {
        rmSync(fixtureTmpRoot(fixture), { recursive: true, force: true });
    }
});

test("test_rebase_ownedDirtyFileAtRebaseTime_throwsNamingOccurrenceAndPath", async () => {
    const TASK_NUMBER = 92;
    const RUN_ID = "run-ownedDirty";
    const BRANCH = `task-${TASK_NUMBER}`;
    const fixture = makeRevengGraphFixture();
    try {
        writeFileSync(
            join(fixture.rootPath, "tasks.json"),
            `${JSON.stringify([{ taskNumber: TASK_NUMBER, title: "t", modifiableFiles: ["jfred/seed.txt"] }], null, 2)}\n`,
        );
        claimTask(TASK_NUMBER, RUN_ID, fixture.rootPath);
        const { worktree } = createTaskWorktree(TASK_NUMBER, RUN_ID, fixture.rootPath);

        // Move staging in jfred so the rebase actually has to run for that occurrence.
        commitOnStaging(fixture.occurrencePaths.jfred, "staging-move.txt", "jfred staging moved\n");

        // Dirty the OWNED file without committing it: COMMIT_IMPLEMENTATION_IF_NEEDED should have already done that.
        const jfredWorktreePath = worktreeCheckoutPath(worktree, "jfred");
        writeFileSync(join(jfredWorktreePath, "seed.txt"), "uncommitted owned edit\n");

        const rebasePacket = JSON.stringify({
            box: "WAS_LOCK_ACQUIRED_Q", scriptSignal: "continue",
            taskNumber: TASK_NUMBER, runId: RUN_ID, projectRoot: fixture.rootPath,
            worktree, branch: BRANCH, exitType: "", exitNote: "",
        });

        await assert.rejects(
            rebaseMain(rebasePacket),
            (error: Error) => {
                assert.match(error.message, /jfred/, "error must name the occurrence");
                assert.match(error.message, /seed\.txt/, "error must name the dirty path");
                assert.match(error.message, /committed/i, "error must say it should have been committed");
                return true;
            },
            "rebase must refuse while an owned file is dirty and uncommitted",
        );
    } finally {
        rmSync(fixtureTmpRoot(fixture), { recursive: true, force: true });
    }
});
