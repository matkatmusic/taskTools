// ARE_2_MERGE_ATTEMPTS_DONE, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    return { box: "ARE_2_MERGE_ATTEMPTS_DONE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, note: `${basename(fileURLToPath(import.meta.url))} for ARE_2_MERGE_ATTEMPTS_DONE`, input };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
