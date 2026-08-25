// STOP, from pipeline-reportOnlyExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    const { exitType, exitNote } = JSON.parse(input) as { exitType: string; exitNote: string };
    return { box: "STOP", scriptSignal: SCRIPT_SIGNAL.STOP, exitType, exitNote };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
