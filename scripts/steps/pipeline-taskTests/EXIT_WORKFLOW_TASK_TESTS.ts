// EXIT_WORKFLOW_TASK_TESTS, from pipeline-taskTests.mmd. Forwards the exit type and note to pipeline-failuresExit.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPacket } from "./packet.ts";

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as { exitType: string; exitNote: string };
    const packet = readPacket(input);
    return {
        ...packet, box: "EXIT_WORKFLOW_TASK_TESTS", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: parsed.exitType, exitNote: parsed.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
