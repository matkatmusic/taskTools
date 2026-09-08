// INIT_SUBMODULES_RECURSIVELY, from pipeline-preambleStatusCheck.mmd. Mutating: idempotent submodule init. "init submodules recursively"
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import { initTaskSubmodules } from "../shared/initTaskSubmodules.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    initTaskSubmodules({
        worktreePath: packet.worktree, taskNumber: packet.taskNumber, runId: packet.runId,
        projectRoot: packet.projectRoot, stepId: "init-submodules",
    });
    // Submodules are populated now, so a submodule file is on disk; preflight cannot see it.
    const task = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((entry) => entry.taskNumber === packet.taskNumber);
    if (task === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const createsFiles: string[] = Array.isArray((task as any).createsFiles) ? (task as any).createsFiles : [];
    const missingFiles = modifiableFiles(task).filter((file) => !createsFiles.includes(file) && !existsSync(join(packet.worktree, file)));
    if (missingFiles.length > 0) {
        return {
            ...packet,
            box: "INIT_SUBMODULES_RECURSIVELY",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            exitType: "owned-file-missing",
            exitNote: `task ${packet.taskNumber}: modifiableFiles names ${missingFiles.join(", ")} but ${missingFiles.length === 1 ? "that file is" : "those files are"} not in the worktree at ${packet.worktree}; list each in "createsFiles" if this task creates it, or run the task that creates it first`,
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    return { ...packet, box: "INIT_SUBMODULES_RECURSIVELY", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "DOCUMENT_GENERATION" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
