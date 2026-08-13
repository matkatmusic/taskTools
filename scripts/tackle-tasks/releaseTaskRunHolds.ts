// "release the worktree lease and the source lock if held" — pipeline.mmd, exit chain only.
// Clean-up already releases both on the success path, which is why that chain has no such box.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readTaskWorktreeLeaseOwner, releaseTaskWorktreeLease, taskWorktreeLeasePath } from "../prepareTasks.ts";
import { buildLockOwner, releaseSourceRepoLock } from "./sourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { HOLD_NOT_RELEASED, HOLD_RELEASED, type HoldReleaseState } from "./reconciliationOutcomes.ts";

export type ReleaseTaskRunHoldsInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string | null;
    branchName: string | null;
};

export type ReleaseTaskRunHoldsOutput = {
    leaseReleased: HoldReleaseState;
    leaseRetained: boolean;
    lockReleased: HoldReleaseState;
};

function taskBranchRemains(projectRoot: string, branchName: string): boolean {
    try {
        execFileSync("git", ["-C", projectRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    } catch {
        return false;
    }
}

// F5: releasing a lease that cleanup deliberately retained strands the very work the ordering
// was designed to protect. Lease policy — retain the ended run's lease while its worktree or a
// retained task branch still exists, always release the source lock, let the next claimed run
// atomically adopt the lease via adoptWorktreeLease. Only what runId/taskNumber owns is ever
// touched; a hold belonging to another owner is left alone in every case.
export function releaseTaskRunHolds(input: ReleaseTaskRunHoldsInput): ReleaseTaskRunHoldsOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    if (input.worktree !== null) requireAbsolutePath("worktree", input.worktree);

    const { released } = releaseSourceRepoLock(
        input.projectRoot,
        buildLockOwner(input.runId, input.taskNumber),
    );
    const lockReleased: HoldReleaseState = released ? HOLD_RELEASED : HOLD_NOT_RELEASED;

    if (input.worktree === null) {
        return { leaseReleased: HOLD_NOT_RELEASED, leaseRetained: false, lockReleased };
    }

    const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(input.worktree));
    if (owner === null || owner.runId !== input.runId) {
        return { leaseReleased: HOLD_NOT_RELEASED, leaseRetained: false, lockReleased };
    }

    const worktreeRemains = existsSync(input.worktree);
    const branchRemains = input.branchName !== null && taskBranchRemains(input.projectRoot, input.branchName);
    if (worktreeRemains || branchRemains) {
        return { leaseReleased: HOLD_NOT_RELEASED, leaseRetained: true, lockReleased };
    }

    releaseTaskWorktreeLease({ worktreePath: input.worktree, runId: input.runId });
    return { leaseReleased: HOLD_RELEASED, leaseRetained: false, lockReleased };
}

if (process.argv[1]?.endsWith("releaseTaskRunHolds.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ReleaseTaskRunHoldsInput;
    const output = releaseTaskRunHolds(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
