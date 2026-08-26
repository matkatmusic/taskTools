// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/MERGE_RECEIPT_INPUT.ts.  Never trusts the payload's assertion: verifies against the real layer merge refs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/MERGE_RECEIPT_INPUT.ts";
import { taskBranchName } from "../../../scripts/tackle-tasks/createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "../../../scripts/tackle-tasks/occurrences.ts";
import { git, makeCommittedRepo, makeLinkedWorktree } from "../../support/gitFixtures.ts";

const TASK = 4343;

function packet(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        projectRoot: "/tmp/example-project", taskNumber: TASK, runId: "run-1",
        worktreePath: "/tmp/example-project/.worktrees/task-1", rootSourceBranch: "main",
        ...overrides,
    });
}

// Writes the merge ref exactly as mergeTaskWorktrees.ts does when a layer lands.
function landRootLayer(worktreePath: string, projectRoot: string): void {
    const branch = taskBranchName(TASK);
    const occurrence = buildWorktreeOccurrences(worktreePath, projectRoot)[0]!;
    const oid = git(occurrence.sourceCheckoutPath, "rev-parse", "HEAD");
    git(occurrence.sourceCheckoutPath, "update-ref", `refs/taskTools/merged-commits/${branch}`, oid);
}

test("test_MERGE_RECEIPT_INPUT_derivesCommitsAndExitNoteFromTheRealMergeRefWhenAllLanded", () => {
    const rootOrigin = makeCommittedRepo();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    landRootLayer(worktreePath, rootOrigin);

    const output = main(packet({ projectRoot: rootOrigin, worktreePath, rootSourceBranch: "main" }));

    assert.equal(output.box, "MERGE_RECEIPT_INPUT");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.projectRoot, rootOrigin);
    assert.equal(output.worktreePath, worktreePath);
    assert.equal(output.rootSourceBranch, "main");
    assert.equal(output.exitNote, "All layers merged successfully.");
    const commits = output.commits as { occurrenceId: string; kind: string }[];
    assert.deepEqual(commits.map((commit) => commit.occurrenceId), [""]);
    assert.deepEqual(commits.map((commit) => commit.kind), ["merge"]);
});

// E3: a blocked/incomplete merge must never be archived on the payload's say-so alone.
test("test_MERGE_RECEIPT_INPUT_throwsWhenTheRealMergeRefsDoNotConfirmAllLanded", () => {
    const rootOrigin = makeCommittedRepo();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    // No merge ref written: the real state is NONE LANDED, whatever the payload claims.

    assert.throws(
        () => main(packet({ projectRoot: rootOrigin, worktreePath, rootSourceBranch: "main" })),
        /is not ALL LANDED/,
    );
});

test("test_MERGE_RECEIPT_INPUT_throwsWhenProjectRootIsNotAbsolute", () => {
    assert.throws(() => main(packet({ projectRoot: "relative/path" })));
});

test("test_MERGE_RECEIPT_INPUT_throwsWhenWorktreePathIsNotAbsolute", () => {
    assert.throws(() => main(packet({ worktreePath: "relative/path" })));
});
