// B_FIX_CATCH_UP_CONFLICTS, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function main(_input: string): Record<string, unknown> {
    throw new Error(`block B_FIX_CATCH_UP_CONFLICTS in pipeline-preambleStatusCheck.mmd is not implemented`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
