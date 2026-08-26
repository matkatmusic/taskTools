// Old CLI entrypoint, still dispatched by path from ImplementBodyEmitter.ts. Ported to scripts/steps/pipeline-reviewTests/AMEND_ENTRY_WITH_CODEX_NOTES.ts.
import { readFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";
import { decideTestReview, type TestReview } from "./decideTestReview.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";
import { logStepOutput } from "./logStepOutput.ts";

export type AmendEntryInput = { projectRoot: string; taskNumber: number; review: TestReview };
export type AmendEntryOutput = { amended: boolean; notes: string };

export function amendEntryWithCodexNotes(input: AmendEntryInput): AmendEntryOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    // The same ruling the review box returned, so the entry and the receipt can never disagree.
    const verdict = decideTestReview(input.review);
    if (!verdict.flagged) throw new Error(`amend-entry: the test review for ${input.taskNumber} flagged nothing; this box runs only on a flagged review`);

    const notes = `A reviewer flagged the task tests. Apply every fix below.\n\n${verdict.notes}`;
    const pair = resolveTaskFiles(projectRoot);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task: any) => task.taskNumber === input.taskNumber);
        if (!entry) throw new Error(`task ${input.taskNumber} not found in ${pair.tasksPath}`);
        (entry as any).codexReviewNotes = notes;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
    return { amended: true, notes };
}

const AMEND_ENTRY_WITH_CODEX_NOTES_SOURCE = "scripts/tackle-tasks/amendEntryWithCodexNotes.ts:13: amendEntryWithCodexNotes";

if (process.argv[1]?.endsWith("amendEntryWithCodexNotes.ts")) {
    const argv = process.argv.slice(2);
    const [projectRoot, taskNumber] = argv;
    const N = Number(taskNumber);
    const stdinText = readFileSync(0, "utf8");
    const review = JSON.parse(stdinText) as TestReview;
    const input = { projectRoot, taskNumber: N, review };
    const identity = { projectRoot, taskNumber: N, runId: getCurrentTaskRun(N, projectRoot)!.runId };
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const command = `node ${process.argv[1]} ${argv.map(quote).join(" ")} <<'TTNOTES'\n${stdinText}\nTTNOTES`;

    try {
        const output = amendEntryWithCodexNotes(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId: "AMEND_ENTRY_WITH_CODEX_NOTES", source: AMEND_ENTRY_WITH_CODEX_NOTES_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId: "AMEND_ENTRY_WITH_CODEX_NOTES", source: AMEND_ENTRY_WITH_CODEX_NOTES_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
