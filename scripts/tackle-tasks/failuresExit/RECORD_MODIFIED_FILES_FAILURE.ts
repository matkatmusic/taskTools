// RECORD_MODIFIED_FILES_FAILURE, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { recordTaskModifiedFiles } from "../shared/recordTaskModifiedFiles.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const sourceBranch = execFileSync("git", ["-C", packet.projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const { modifiedFiles } = recordTaskModifiedFiles({
        taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot,
        worktree: packet.worktree, sourceBranch,
    });
    return { ...packet, box: "RECORD_MODIFIED_FILES_FAILURE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, modifiedFiles };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
