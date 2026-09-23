// Q_CONTINUE_RESUMED_REBASE, from pipeline-preambleStatusCheck.mmd. Mutating: stages the agent's fix, continues the resumed-worktree rebase; releases the source lock once it finishes.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { advanceTaskRebase } from "../shared/advanceTaskRebase.ts";
import { buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { retainedDestination, type RebaseResumedPacket } from "./REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts";

const CONFLICT_MARKER_LINE = /^(<{7}|={7}|>{7})/m;

// B_FIX_RESUMED_REBASE_CONFLICTS's input, with the fixing agent's answer merged over it.
type Input = RebaseResumedPacket & { message: string; additionalData: Record<string, unknown>; next?: string };

export function main(input: string): RebaseResumedPacket & { next: string } {
  const { next: _next, ...packet } = JSON.parse(input) as Input;
  if (typeof packet.additionalData.resolved !== "boolean") {
    throw new Error(`CONTINUE_RESUMED_REBASE: additionalData holds no boolean "resolved"`);
  }
  if (packet.additionalData.resolved) {
    const stillMarked: string[] = [];
    for (const relativePath of packet.conflictedFilePaths) {
      const content = readFileSync(join(packet.stoppedCheckoutPath, relativePath), "utf8");
      const holdsAMarker = CONFLICT_MARKER_LINE.test(content);
      if (holdsAMarker)
        stillMarked.push(relativePath);
    }
    if (stillMarked.length > 0) {
      throw new Error(`CONTINUE_RESUMED_REBASE: resolved: true but ${stillMarked.length} file(s) still hold a conflict marker: ${stillMarked.join(", ")}`);
    }
    execFileSync("git", ["-C", packet.stoppedCheckoutPath, "add", "--", ...packet.conflictedFilePaths]);
  }

  // advanceTaskRebase refreshes the lock's heartbeat itself before touching anything.
  const outcome = advanceTaskRebase({
    projectRoot: packet.projectRoot,
    worktreePath: packet.worktree,
    taskNumber: packet.taskNumber,
    runId: packet.runId,
    stepId: "continue-resumed-rebase",
    rootSourceBranch: "staging",
    stoppedAt: { occurrenceId: packet.stoppedOccurrenceId, checkoutPath: packet.stoppedCheckoutPath },
  });
  const advanced = {
    ...packet,
    box: "Q_CONTINUE_RESUMED_REBASE",
    scriptSignal: SCRIPT_SIGNAL.CONTINUE,
    conflicted: outcome.conflicted,
    stoppedOccurrenceId: outcome.stoppedAt?.occurrenceId ?? "",
    stoppedCheckoutPath: outcome.stoppedAt?.checkoutPath ?? "",
    conflictedFilePaths: outcome.conflictedFilePaths,
  };
  // No round limit: every fresh conflict goes back to a new fixing agent with the lock still held.
  if (outcome.conflicted) {
    return { ...advanced, next: "B_FIX_RESUMED_REBASE_CONFLICTS" };
  }
  if (!outcome.finished) {
    throw new Error(`CONTINUE_RESUMED_REBASE: rebase stopped without a conflict: ${outcome.failureReason}`);
  }
  releaseSourceRepoLock(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
  return retainedDestination(packet.worktree, advanced) ?? { ...advanced, next: "Q_DOES_FENCE_COVER_WORKTREE_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
  console.log(JSON.stringify(main(process.argv[2] ?? "")));
