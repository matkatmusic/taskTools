// Behavioral checks for RELEASE_WORKTREE_LEASE.ts. Ported from tests/releaseTaskRunHolds.test.ts.  Run: node --test scripts/tackle-tasks/failuresExit/RELEASE_WORKTREE_LEASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./RELEASE_WORKTREE_LEASE.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import { git, makeCommittedRepo } from "../../../tests/support/gitFixtures.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";

const TEMPLATE_PATH = join(import.meta.dirname, "RELEASE_WORKTREE_LEASE.template.json");

function packet(projectRoot: string, worktree: string) {
    return JSON.stringify({
        box: "DOES_RUN_HOLD_LEASE_Q", scriptSignal: "continue", next: "RELEASE_WORKTREE_LEASE",
        taskNumber: 1, runId: "run-a", projectRoot, worktree, branch: "task-1",
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

test("test_RELEASE_WORKTREE_LEASE_runsTwiceWithTheSameInput", () => {
    const root = makeCommittedRepo("releaseWorktreeLease-twice-");
    const worktreePath = join(root, "gone-worktree");
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "run-a", pid: 1, createdAt: 0 }));
    const input = packet(root, worktreePath);

    const first = main(input);
    const leaseAfterFirst = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
    const second = main(input);
    const leaseAfterSecond = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));

    assert.equal(first.leaseReleased, true);
    assert.equal(second.leaseReleased, false);
    assert.deepEqual(second, { ...first, leaseReleased: false });
    assert.deepEqual(leaseAfterSecond, leaseAfterFirst);
});
