// Maintenance CLI, no diagram box. The workflow never calls this; an operator
// runs it by hand to remove a cold source-repo lock. See
// plans/diagram/pipeline.mmd rule 9 and sourceRepoLock.ts.
import { readFileSync } from "node:fs";
import { recoverSourceRepoLock } from "./sourceRepoLock.ts";

export type RecoverSourceRepoLockCliInput = {
    projectRoot: string;
    expectedStaleOwner: string;
    confirmation: string;
};

export type RecoverSourceRepoLockCliOutput = {
    status: "recovered" | "refused";
    owner: string;
    reason: string | null;
};

const OWNER_TOKEN_PATTERN = /^.+:\d+$/;

// F2: the single source of the exact operator command a "recoverable" lock result prints
// (diagram rule 9). rebaseTaskWorktree builds its output from this, not an inline copy, so
// the two can never drift apart.
export function formatSourceRepoLockRecoveryCommand(projectRoot: string, expectedStaleOwner: string): string {
    const input: RecoverSourceRepoLockCliInput = {
        projectRoot,
        expectedStaleOwner,
        confirmation: `abandon ${expectedStaleOwner}`,
    };
    return `echo '${JSON.stringify(input)}' | node scripts/tackle-tasks/recoverSourceRepoLock.ts`;
}

export function runRecoverSourceRepoLockCli(
    input: RecoverSourceRepoLockCliInput,
): RecoverSourceRepoLockCliOutput {
    if (!OWNER_TOKEN_PATTERN.test(input.expectedStaleOwner)) {
        return { status: "refused", owner: input.expectedStaleOwner, reason: "malformed owner token" };
    }
    const result = recoverSourceRepoLock(input.projectRoot, input.expectedStaleOwner, input.confirmation);
    return {
        status: result.recovered ? "recovered" : "refused",
        owner: input.expectedStaleOwner,
        reason: result.reason,
    };
}

if (process.argv[1]?.endsWith("recoverSourceRepoLock.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RecoverSourceRepoLockCliInput;
    const output = runRecoverSourceRepoLockCli(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
