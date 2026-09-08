// TASK_TESTS_PIPELINE, from pipeline-implement.mmd. Forwards the committed work packet to pipeline-taskTests.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Record<string, unknown>;
    const { box: _box, scriptSignal: _scriptSignal, next: _next, ...rest } = packet;
    return { box: "TASK_TESTS_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, ...rest };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
