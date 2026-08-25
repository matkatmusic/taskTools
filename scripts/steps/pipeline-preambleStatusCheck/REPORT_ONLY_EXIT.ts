// REPORT_ONLY_EXIT, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    const { exitType, exitNote } = JSON.parse(input) as { exitType: string; exitNote: string };
    return { box: "REPORT_ONLY_EXIT", scriptSignal: SCRIPT_SIGNAL.CONTINUE, exitType, exitNote };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
