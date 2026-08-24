// WORKTREE_CHECK_PIPELINE, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    const { taskNumber, tasksFile, runId } = JSON.parse(input) as { taskNumber: number; tasksFile: string; runId: string };
    return { box: "WORKTREE_CHECK_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, taskNumber, tasksFile, runId };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
