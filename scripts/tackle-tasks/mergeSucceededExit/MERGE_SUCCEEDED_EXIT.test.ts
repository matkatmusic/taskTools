// Behavioral checks for MERGE_SUCCEEDED_EXIT.ts. Never trusts the packet's assertion: verifies against the real layer merge refs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./MERGE_SUCCEEDED_EXIT.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "../shared/occurrences.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

const TASK = 4343;

function packet(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        box: "WHAT_IS_PUBLICATION_STATE_Q", scriptSignal: "continue",
        projectRoot: "/tmp/example-project", taskNumber: TASK, runId: "run-1",
        worktree: "/tmp/example-project/.worktrees/task-1", branch: "main",
        exitType: "", exitNote: "",
        ...overrides,
    });
}

// Writes the merge ref exactly as mergeTaskWorktrees.ts does when a layer lands.
function landRootLayer(worktreePath: string, projectRoot: string): void {
    const branch = taskBranchName(TASK);
    const occurrence = buildWorktreeOccurrences(worktreePath, projectRoot, "staging")[0]!;
    const oid = git(occurrence.sourceCheckoutPath, "rev-parse", "HEAD");
    git(occurrence.sourceCheckoutPath, "update-ref", `refs/taskTools/merged-commits/${branch}`, oid);
}

test("test_MERGE_SUCCEEDED_EXIT_derivesCommitsAndExitNoteFromTheRealMergeRefWhenAllLanded", () => {
    const rootOrigin = makeCommittedRepo();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    landRootLayer(worktreePath, rootOrigin);

    const output = main(packet({ projectRoot: rootOrigin, worktree: worktreePath, branch: "main" }));

    assert.equal(output.box, "MERGE_SUCCEEDED_EXIT");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.projectRoot, rootOrigin);
    assert.equal(output.worktree, worktreePath);
    assert.equal(output.branch, "main");
    assert.equal(output.exitNote, "All layers merged successfully.");
    const commits = output.commits as { occurrenceId: string; kind: string }[];
    assert.deepEqual(commits.map((commit) => commit.occurrenceId), [""]);
    assert.deepEqual(commits.map((commit) => commit.kind), ["merge"]);
});

// A blocked/incomplete merge must never be archived on the packet's say-so alone.
test("test_MERGE_SUCCEEDED_EXIT_throwsWhenTheRealMergeRefsDoNotConfirmAllLanded", () => {
    const rootOrigin = makeCommittedRepo();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    // No merge ref written: the real state is NONE LANDED, whatever the packet says.

    assert.throws(
        () => main(packet({ projectRoot: rootOrigin, worktree: worktreePath, branch: "main" })),
        /is not ALL LANDED/,
    );
});

test("test_MERGE_SUCCEEDED_EXIT_throwsWhenProjectRootIsNotAbsolute", () => {
    assert.throws(() => main(packet({ projectRoot: "relative/path" })));
});

test("test_MERGE_SUCCEEDED_EXIT_throwsWhenWorktreeIsNotAbsolute", () => {
    assert.throws(() => main(packet({ worktree: "relative/path" })));
});
