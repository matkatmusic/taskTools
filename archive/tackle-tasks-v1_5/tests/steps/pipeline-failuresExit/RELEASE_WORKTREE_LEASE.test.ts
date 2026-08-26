// Behavioral checks for scripts/steps/pipeline-failuresExit/RELEASE_WORKTREE_LEASE.ts.  Ported from tests/releaseTaskRunHolds.test.ts. Run: node --test tests/steps/pipeline-failuresExit/RELEASE_WORKTREE_LEASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-failuresExit/RELEASE_WORKTREE_LEASE.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../../scripts/prepareTasks.ts";
import { git, makeCommittedRepo } from "../../support/gitFixtures.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-failuresExit/RELEASE_WORKTREE_LEASE.template.json");

function packet(projectRoot: string, worktree: string) {
    return JSON.stringify({
        box: "DOES_RUN_HOLD_LEASE", scriptSignal: "continue", next: "RELEASE_WORKTREE_LEASE",
        taskNumber: 1, runId: "run-a", projectRoot, worktree, sourceBranch: "master",
        exitType: "run-failed", exitNote: "boom", publicationState: "NONE LANDED", modifiedFiles: [],
        active: false, endedAt: "2026-08-01T00:00:00-07:00", leaseReleased: false, leaseRetained: false,
    });
}

test("test_RELEASE_WORKTREE_LEASE_retainsTheLeaseWhileTheWorktreeRemains", () => {
    const root = mkdtempSync(join(tmpdir(), "releaseWorktreeLease-"));
    const worktreePath = join(root, "worktree-1");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "run-a", pid: 1, createdAt: 0 }));

    const output = main(packet(root, worktreePath));

    assert.equal(output.leaseReleased, false);
    assert.equal(output.leaseRetained, true);
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath))?.runId, "run-a");
});

test("test_RELEASE_WORKTREE_LEASE_releasesTheLeaseOnceNothingRemains", () => {
    const root = makeCommittedRepo("releaseWorktreeLease-clean-");
    const worktreePath = join(root, "gone-worktree");
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "run-a", pid: 1, createdAt: 0 }));

    const output = main(packet(root, worktreePath));

    assert.equal(output.leaseReleased, true);
    assert.equal(output.leaseRetained, false);
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_RELEASE_WORKTREE_LEASE_retainsTheLeaseWhileARetainedTaskBranchRemains", () => {
    const root = makeCommittedRepo("releaseWorktreeLease-branch-");
    git(root, "branch", "task-1");
    const worktreePath = join(root, "gone-worktree");
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "run-a", pid: 1, createdAt: 0 }));

    const output = main(packet(root, worktreePath));

    assert.equal(output.leaseReleased, false);
    assert.equal(output.leaseRetained, true);
});
