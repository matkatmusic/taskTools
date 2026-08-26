// "is task blocked?" — pipeline.mmd. Reuses blockerReport; blockedBy keys on taskNum,
// never taskNumber.
import { readFileSync } from "node:fs";
import { blockerReport } from "../checkBlockers.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

// The outer `reason` is this task's, worded here once; each blocker carries its own.
export type IsTaskBlockedOutput = {
    blocked: boolean;
    blockers: { taskNum: number; reason: string }[];
    reason: string | null;
};

export function isTaskBlocked(taskNumber: number, projectRoot: string): IsTaskBlockedOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    const { openBlockersOf } = blockerReport([taskNumber], projectRoot);
    const blockers = openBlockersOf(taskNumber);
    if (blockers.length === 0) return { blocked: false, blockers, reason: null };
    return { blocked: true, blockers, reason: `is blocked by ${blockers.map((blocker) => blocker.taskNum).join(", ")}` };
}

if (process.argv[1]?.endsWith("isTaskBlocked.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; projectRoot: string };
    const output = isTaskBlocked(input.taskNumber, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
