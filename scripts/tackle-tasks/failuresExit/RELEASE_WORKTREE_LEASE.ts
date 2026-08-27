// RELEASE_WORKTREE_LEASE, from pipeline-failuresExit.mmd
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { releaseTaskWorktreeLease } from "../../prepareTasks.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import type { EntryPacket } from "./_packet.ts";

function taskBranchRemains(projectRoot: string, branchName: string): boolean {
    try {
        execFileSync("git", ["-C", projectRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    } catch (err) {
        if (err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number") return false;
        throw err;
    }
}

// F5: a lease this run owns is retained while its worktree or a retained task branch still exists.
export function main(input: string): Record<string, unknown> {
    const { next: _next, leaseReleased: _lr, leaseRetained: _lt, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const branchName = taskBranchName(packet.taskNumber);
    const worktreeRemains = existsSync(packet.worktree);
    const branchRemains = taskBranchRemains(packet.projectRoot, branchName);

    let leaseReleased = false;
    let leaseRetained = false;
    if (worktreeRemains || branchRemains) {
        leaseRetained = true;
    } else {
        releaseTaskWorktreeLease({ worktreePath: packet.worktree, runId: packet.runId });
        leaseReleased = true;
    }

    return { ...packet, box: "RELEASE_WORKTREE_LEASE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, leaseReleased, leaseRetained };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
