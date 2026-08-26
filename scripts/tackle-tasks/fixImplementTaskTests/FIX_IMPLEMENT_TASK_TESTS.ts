// FIX_IMPLEMENT_TASK_TESTS, from pipeline-fixImplementTaskTests.mmd
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    return { box: "FIX_IMPLEMENT_TASK_TESTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: `The tests in ${input} are failing.  fix the codebase and get them passing.  do not run the full suite` };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
