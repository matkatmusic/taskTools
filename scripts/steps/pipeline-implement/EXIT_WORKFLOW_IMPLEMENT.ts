// EXIT_WORKFLOW_IMPLEMENT, from pipeline-implement.mmd. Forwards the exit type and note to pipeline-failuresExit.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Record<string, unknown>;
    const { box: _box, scriptSignal: _scriptSignal, ...rest } = packet;
    return { box: "EXIT_WORKFLOW_IMPLEMENT", scriptSignal: SCRIPT_SIGNAL.CONTINUE, ...rest };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
