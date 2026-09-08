// INIT_SUBMODULES_RECURSIVELY, from pipeline-worktreeCheck.mmd. Mutating: idempotent submodule init.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { initTaskSubmodules } from "../../tackle-tasks/initTaskSubmodules.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket {
    // The incoming packet may carry a decision predecessor's `next`; this box has one successor.
    const { next: _next, ...packet } = JSON.parse(input) as WorktreeCheckPacket & { next?: string };
    initTaskSubmodules({
        worktreePath: packet.worktree, taskNumber: packet.taskNumber, runId: packet.runId,
        projectRoot: packet.projectRoot, stepId: "init-submodules",
    });
    return { ...packet, box: "INIT_SUBMODULES_RECURSIVELY", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
