// "lock the source repo" — pipeline-rebasePreamble.mmd.
// Migrated to scripts/steps/pipeline-rebasePreamble/LOCK_SOURCE_REPO.ts; kept here, commented out, never deleted.
// import { readFileSync } from "node:fs";
// import { requireAbsolutePath } from "./inputPaths.ts";
// import { acquireSourceRepoLock, buildLockOwner } from "./sourceRepoLock.ts";
// import { logStepOutput } from "./logStepOutput.ts";
//
// export type LockSourceRepoInput = {
//     taskNumber: number;
//     runId: string;
//     projectRoot: string;
// };
//
// export type LockSourceRepoOutput = {
//     acquired: boolean;
//     heldByOwner: string | null;
// };
//
// // The owner is runId:taskNumber, and re-acquiring as the same owner is a no-op, so the rebase may ask again.
// export async function lockSourceRepo(input: LockSourceRepoInput): Promise<LockSourceRepoOutput> {
//     const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
//     const owner = buildLockOwner(input.runId, input.taskNumber);
//     // A hook runs this box, so it never waits: WAS_LOCK_ACQUIRED sends the run round again.
//     const outcome = acquireSourceRepoLock(projectRoot, owner);
//     if (outcome.status === "acquired" || outcome.status === "already-held-by-me") {
//         return { acquired: true, heldByOwner: null };
//     }
//     return { acquired: false, heldByOwner: outcome.owner };
// }
//
// const LOCK_SOURCE_REPO_SOURCE = "scripts/tackle-tasks/lockSourceRepo.ts:19: lockSourceRepo";
//
// if (process.argv[1]?.endsWith("lockSourceRepo.ts")) {
//     const payloadText = readFileSync(0, "utf8");
//     const input = JSON.parse(payloadText) as LockSourceRepoInput & { boxId?: string };
//     const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId };
//     const boxId = input.boxId ?? "lockSourceRepo";
//     const command = `node ${process.argv[1]} <<'TTLOCK'\n${payloadText}\nTTLOCK`;
//
//     lockSourceRepo(input).then((output) => {
//         const commandOutput = `${JSON.stringify(output)}\n`;
//         logStepOutput(identity, { boxId, source: LOCK_SOURCE_REPO_SOURCE, input, command, commandOutput, output });
//         process.stdout.write(commandOutput);
//     }).catch((error) => {
//         const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
//         logStepOutput(identity, { boxId, source: LOCK_SOURCE_REPO_SOURCE, input, command, commandOutput: message as string, output: { error: message } });
//         process.stderr.write(`${message}\n`);
//         process.exitCode = 1;
//     });
// }
