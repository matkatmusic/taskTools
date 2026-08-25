// DO_TASK_TESTS_PASS, from pipeline-taskTests.mmd. Decision: do the task tests pass?
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPacket } from "./packet.ts";

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as { passed: boolean };
    const packet = readPacket(input);
    const next = parsed.passed ? "REVIEW_TESTS_PIPELINE" : "ARE_2_TEST_FIXES_DONE";
    return { ...packet, box: "DO_TASK_TESTS_PASS", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
