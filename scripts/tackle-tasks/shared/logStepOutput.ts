// Appends one debugging block per "Run this with Bash" invocation, to the run's shared log file.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type RunIdentity = {
    projectRoot: string;
    taskNumber: number | string;
    runId: string;
};

export type StepLogEntry = {
    boxId: string;
    // "repo/relative/path.ts:123: functionName" - where the logic that ran is defined.
    source: string;
    input: unknown;
    command: string;
    // The raw stdout the command produced, verbatim, unparsed.
    commandOutput: string;
    // The step's structured result, logged as JSON.
    output: unknown;
};

const HEADER_OPEN = "=".repeat(7);
const HEADER_CLOSE = "=".repeat(6);
const FENCE = "=".repeat(36);

// The sole home of this path: every caller derives its log folder through this function.
export function stepOutputDirectory(identity: RunIdentity): string {
    return join(identity.projectRoot, "plans/diagram/output renders", String(identity.taskNumber), "runs", identity.runId);
}

export function logStepOutput(identity: RunIdentity, entry: StepLogEntry): void {
    const directory = stepOutputDirectory(identity);
    mkdirSync(directory, { recursive: true });
    const block = `${HEADER_OPEN} ${entry.boxId} ${HEADER_CLOSE}\n`
        + `Source ${entry.source}\n`
        + `input: ${JSON.stringify(entry.input)}\n`
        + `${FENCE}\n`
        + `${entry.command}\n`
        + `${entry.commandOutput}\n`
        + ` output: ${JSON.stringify(entry.output)}\n`
        + `${FENCE}\n`;
    // One write, one string: many processes append to this file concurrently.
    appendFileSync(join(directory, "run-log.md"), block);
}
