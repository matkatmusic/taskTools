// B_FIX_CATCH_UP_CONFLICTS, from pipeline-preambleStatusCheck.mmd. Reuses fixConflictsPrompt, the sole home of this prompt's text.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { fixConflictsPrompt } from "../shared/FixConflictsBodyEmitter.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

// worktreePath comes from Q_CATCH_UP_STAGING's conflict output; it is not part of EntryPacket.
type Input = EntryPacket & { worktreePath: string };

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", packet.worktreePath);
    // runId is still "" before B_MARK_TASK_ACTIVE, so this is the owner B_LOCK_STAGING_FOR_CATCH_UP took.
    refreshOwnedSourceRepoLockOrThrow(projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    const promptFile = `${worktreePath.replace(/\/+$/, "")}/plans/FIX_CATCH_UP_CONFLICTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, fixConflictsPrompt(worktreePath, packet.taskNumber, projectRoot, packet.runId, "staging"));
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "FIX_CATCH_UP_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
