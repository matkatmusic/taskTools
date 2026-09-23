// B_FIX_RESUMED_REBASE_CONFLICTS, from pipeline-preambleStatusCheck.mmd. Reuses fixConflictsPrompt, the sole home of this prompt's text.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { fixConflictsPrompt } from "../shared/FixConflictsBodyEmitter.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import type { RebaseResumedPacket } from "./REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts";

export function main(input: string): Record<string, unknown> {
  const packet = JSON.parse(input) as RebaseResumedPacket;
  const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
  const worktree = requireAbsolutePath("worktree", packet.worktree);
  // The rebase can stop inside a submodule, so conflicted files are looked up in the checkout it stopped in.
  const stoppedCheckoutPath = requireAbsolutePath("stoppedCheckoutPath", packet.stoppedCheckoutPath);
  refreshOwnedSourceRepoLockOrThrow(projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
  const promptFile = `${worktree.replace(/\/+$/, "")}/plans/FIX_RESUMED_REBASE_CONFLICTS.prompt.md`;
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, fixConflictsPrompt(stoppedCheckoutPath, packet.taskNumber, projectRoot, packet.runId, "staging"));
  const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
  return { box: "B_FIX_RESUMED_REBASE_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
  console.log(JSON.stringify(main(process.argv[2] ?? "")));
