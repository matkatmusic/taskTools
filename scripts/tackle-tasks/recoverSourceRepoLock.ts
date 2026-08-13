// Maintenance CLI, no diagram box. The workflow never calls this; an operator
// runs it by hand to remove a cold source-repo lock. See
// plans/diagram/pipeline.mmd rule 9 and sourceRepoLock.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recoverSourceRepoLock } from "./sourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

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

// POSIX single-quote escape: close the quote, emit an escaped literal quote, reopen it.
// Safe for any byte a path or JSON string can contain, including an embedded apostrophe.
function shQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

// F2: the single source of the exact operator command a "recoverable" lock result prints
// (diagram rule 9). rebaseTaskWorktree builds its output from this, not an inline copy, so
// the two can never drift apart. Both the script path and the stdin JSON are absolute /
// shell-quoted so the command works from any cwd and for any path, apostrophes included.
export function formatSourceRepoLockRecoveryCommand(projectRoot: string, expectedStaleOwner: string): string {
    const input: RecoverSourceRepoLockCliInput = {
        projectRoot,
        expectedStaleOwner,
        confirmation: `abandon ${expectedStaleOwner}`,
    };
    const scriptPath = fileURLToPath(new URL("./recoverSourceRepoLock.ts", import.meta.url));
    return `echo ${shQuote(JSON.stringify(input))} | node ${shQuote(scriptPath)}`;
}

export function runRecoverSourceRepoLockCli(
    input: RecoverSourceRepoLockCliInput,
): RecoverSourceRepoLockCliOutput {
    if (!OWNER_TOKEN_PATTERN.test(input.expectedStaleOwner)) {
        return { status: "refused", owner: input.expectedStaleOwner, reason: "malformed owner token" };
    }
    requireAbsolutePath("projectRoot", input.projectRoot);
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
