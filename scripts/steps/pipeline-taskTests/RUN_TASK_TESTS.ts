// RUN_TASK_TESTS, from pipeline-taskTests.mmd. Runs the task's own tests and records the decision.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { runTaskTests } from "../../tackle-tasks/runTaskTestsImpl.ts";
import { readPacket } from "./packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = readPacket(input);
    const result = runTaskTests(
        packet.taskNumber, packet.runId, packet.worktreePath, packet.sourceBranch, "RUN_TASK_TESTS", packet.projectRoot,
    );
    return { ...packet, box: "RUN_TASK_TESTS", scriptSignal: SCRIPT_SIGNAL.CONTINUE, passed: result.passed };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
