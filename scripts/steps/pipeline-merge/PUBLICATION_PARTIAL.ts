// PUBLICATION_PARTIAL, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// Never retried: a partial publication would re-land around public work (paragraph 77).
const EXIT_NOTE = "some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Record<string, unknown>;
    return {
        ...packet,
        box: "PUBLICATION_PARTIAL",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        // Matches EXIT_WORKFLOW_MERGE's other predecessor, ARE_2_MERGE_ATTEMPTS_DONE, shape for shape.
        next: "EXIT_WORKFLOW_MERGE",
        exitType: "partially-published",
        exitNote: EXIT_NOTE,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
