// FIX_CONFLICTS, from pipeline-rebase.mmd. Reuses fixConflictsPrompt, the sole home of this prompt's text.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { fixConflictsPrompt } from "../shared/FixConflictsBodyEmitter.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import type { FixConflictsPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as FixConflictsPacket;
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    const worktree = requireAbsolutePath("worktree", packet.worktree);
    refreshOwnedSourceRepoLockOrThrow(projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    const rootSourceBranch = execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const promptFile = `${worktree.replace(/\/+$/, "")}/plans/FIX_CONFLICTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, fixConflictsPrompt(worktree, packet.taskNumber, projectRoot, packet.runId, rootSourceBranch));
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "FIX_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
