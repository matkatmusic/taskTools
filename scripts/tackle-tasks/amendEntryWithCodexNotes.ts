// "amend tasks.json entry with codex's notes and fixes" — pipeline-reviewTests.mmd. The implementer reads the entry next.
import { readFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";
import { decideTestReview, type TestReview } from "./decideTestReview.ts";

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

if (process.argv[1]?.endsWith("amendEntryWithCodexNotes.ts")) {
    const [projectRoot, taskNumber] = process.argv.slice(2);
    const review = JSON.parse(readFileSync(0, "utf8")) as TestReview;
    const output = amendEntryWithCodexNotes({ projectRoot, taskNumber: Number(taskNumber), review });
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
