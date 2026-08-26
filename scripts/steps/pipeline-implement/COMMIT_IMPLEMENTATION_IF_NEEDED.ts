// COMMIT_IMPLEMENTATION_IF_NEEDED, from pipeline-implement.mmd. Reuses scripts/tackle-tasks/commitTaskWork.ts, unchanged.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { commitTaskWork } from "../../tackle-tasks/commitTaskWork.ts";

export type CommitImplementationIfNeededInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    sourceBranch: string;
};

export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as CommitImplementationIfNeededInput & { next?: string };
    const { commits } = commitTaskWork({ ...packet, rootSourceBranch: packet.sourceBranch, stepId: "implement" });
    return { ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, commits };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
