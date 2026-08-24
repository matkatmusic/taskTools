// WHAT_DID_THE_PLANNER_RETURN, from pipeline-plan.mmd
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    return { box: "WHAT_DID_THE_PLANNER_RETURN", scriptSignal: SCRIPT_SIGNAL.CONTINUE, note: `${basename(fileURLToPath(import.meta.url))} for WHAT_DID_THE_PLANNER_RETURN`, input };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
