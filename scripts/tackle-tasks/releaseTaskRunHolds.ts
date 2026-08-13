// "release the worktree lease and the source lock if held" — pipeline.mmd, exit chain only.
// Clean-up already releases both on the success path, which is why that chain has no such box.
import { readFileSync } from "node:fs";
import { readTaskWorktreeLeaseOwner, releaseTaskWorktreeLease, taskWorktreeLeasePath } from "../prepareTasks.ts";
import { buildLockOwner, releaseSourceRepoLock } from "./sourceRepoLock.ts";

export type ReleaseTaskRunHoldsInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string | null;
};

export type ReleaseTaskRunHoldsOutput = { leaseReleased: boolean; lockReleased: boolean };

// Releases only what runId/taskNumber owns; a hold belonging to another owner is left alone.
export function releaseTaskRunHolds(input: ReleaseTaskRunHoldsInput): ReleaseTaskRunHoldsOutput {
    let leaseReleased = false;
    if (input.worktree !== null) {
        const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(input.worktree));
        if (owner !== null && owner.runId === input.runId) {
            releaseTaskWorktreeLease({ worktreePath: input.worktree, runId: input.runId });
            leaseReleased = true;
        }
    }
    const { released: lockReleased } = releaseSourceRepoLock(
        input.projectRoot,
        buildLockOwner(input.runId, input.taskNumber),
    );
    return { leaseReleased, lockReleased };
}

if (process.argv[1]?.endsWith("releaseTaskRunHolds.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ReleaseTaskRunHoldsInput;
    const output = releaseTaskRunHolds(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
