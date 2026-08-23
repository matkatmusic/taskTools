// Sole home of the lock-source-repo prompt, the "lock the source repo" box in plans/diagram/pipeline-rebasePreamble.mmd.
import { fileURLToPath } from "node:url";

// The receipt that box hands back.
export type LockSourceRepoReceipt = {
    acquired: boolean;
    heldByOwner: string | null;
};

const LOCK_SOURCE_REPO_PATH = fileURLToPath(new URL("./lockSourceRepo.ts", import.meta.url));

export type LockSourceRepoPromptInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
};

export function lockSourceRepoPrompt(input: LockSourceRepoPromptInput): string {
    // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
    const payload = JSON.stringify({
        taskNumber: input.taskNumber,
        runId: input.runId,
        projectRoot: input.projectRoot,
        boxId: "LOCK_SOURCE_REPO",
    });
    return `Run this with Bash, exactly as written:
node ${LOCK_SOURCE_REPO_PATH} <<'TTLOCK'
${payload}
TTLOCK

It waits for the lock and can take up to fifteen minutes. Let it finish.

It prints one JSON object. Return that object verbatim.

Run nothing else. Edit nothing. Never delete or recover a lock another run holds.

If the command fails, say so plainly and return nothing else.
That is an operational failure, and a later box owns it.`;
}
