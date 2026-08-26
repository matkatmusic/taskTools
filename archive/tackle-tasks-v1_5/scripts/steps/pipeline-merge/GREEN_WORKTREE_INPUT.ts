// GREEN_WORKTREE_INPUT, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type GreenWorktreeInput = {
    worktreePath: string;
    rootSourceBranch: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
};

export function main(input: string): Record<string, unknown> {
    // The incoming packet may carry a decision predecessor's `next`; this box has one successor.
    const { next: _next, ...packet } = JSON.parse(input) as GreenWorktreeInput & { next?: string };
    return { ...packet, box: "GREEN_WORKTREE_INPUT", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
