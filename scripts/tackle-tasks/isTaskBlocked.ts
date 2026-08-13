// "is task blocked?" — pipeline.mmd. Reuses blockerReport; blockedBy keys on taskNum,
// never taskNumber.
import { readFileSync } from "node:fs";
import { blockerReport } from "../checkBlockers.ts";

export type IsTaskBlockedOutput = {
    blocked: boolean;
    blockers: { taskNum: number; reason: string }[];
};

export function isTaskBlocked(taskNumber: number, projectRoot: string): IsTaskBlockedOutput {
    const { openBlockersOf } = blockerReport([taskNumber], projectRoot);
    const blockers = openBlockersOf(taskNumber);
    return { blocked: blockers.length > 0, blockers };
}

if (process.argv[1]?.endsWith("isTaskBlocked.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; projectRoot: string };
    const output = isTaskBlocked(input.taskNumber, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
