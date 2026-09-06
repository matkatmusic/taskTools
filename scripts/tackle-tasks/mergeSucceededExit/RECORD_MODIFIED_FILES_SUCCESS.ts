// RECORD_MODIFIED_FILES_SUCCESS, from pipeline-mergeSucceededExit.mmd. Mutating: records the modified files to tasks.json.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { buildOccurrencePath } from "../shared/occurrences.ts";
import { getCurrentTaskRun, updateCurrentTaskRun } from "../shared/taskRunState.ts";

export type RecordModifiedFilesSuccessInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktree: string;
    branch: string;
};

// The merge already landed, so a branch diff is empty here; the recorded work commits name the files instead.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as RecordModifiedFilesSuccessInput;
    const run = getCurrentTaskRun(packet.taskNumber, packet.projectRoot);
    if (run === null) throw new Error(`task ${packet.taskNumber} has no active run`);
    const modifiedFiles = new Set<string>();
    for (const commit of run.commits) {
        if (commit.kind === "merge") continue;
        const checkoutPath = join(packet.worktree, commit.occurrenceId);
        const changedPaths = execFileSync("git", ["-C", checkoutPath, "show", "--name-only", "--format=", commit.hash], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean);
        for (const path of changedPaths) modifiedFiles.add(buildOccurrencePath(commit.occurrenceId, path));
    }
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { modifiedFiles: [...modifiedFiles] }, packet.projectRoot);
    return {
        box: "RECORD_MODIFIED_FILES_SUCCESS", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, worktree: packet.worktree,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
