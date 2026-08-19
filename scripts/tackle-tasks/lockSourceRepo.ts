// "lock the source repo" — pipeline-rebasePreamble.mmd. Tries once; the workflow owns the retry loop.
import { readFileSync } from "node:fs";
import { requireAbsolutePath } from "./inputPaths.ts";
import { acquireSourceRepoLock, buildLockOwner } from "./sourceRepoLock.ts";

export type LockSourceRepoInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
};

export type LockSourceRepoOutput = {
    acquired: boolean;
    heldByOwner: string | null;
};

// The owner is runId:taskNumber, and re-acquiring as the same owner is a no-op, so the rebase may ask again.
export async function lockSourceRepo(input: LockSourceRepoInput): Promise<LockSourceRepoOutput> {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    // A hook runs this box, so it never waits: WAS_LOCK_ACQUIRED sends the run round again.
    const outcome = acquireSourceRepoLock(projectRoot, owner);
    if (outcome.status === "acquired" || outcome.status === "already-held-by-me") {
        return { acquired: true, heldByOwner: null };
    }
    return { acquired: false, heldByOwner: outcome.owner };
}

if (process.argv[1]?.endsWith("lockSourceRepo.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as LockSourceRepoInput;
    lockSourceRepo(input).then((output) => {
        process.stdout.write(`${JSON.stringify(output)}\n`);
    }).catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}
