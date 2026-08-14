// "build the closure note from the recorded run" — pipeline.mmd. Deterministic: reads only
// the stored run record, nothing re-derived, so it runs correctly after the worktree is gone.
// Replaces closeTasksBrief.ts, whose prompt re-verified and edited files after clean-up.
import { readFileSync } from "node:fs";
import { readTaskRunState, type FullSuiteResult, type TaskRunRecord, type TaskTestResult } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type BuildClosureNoteInput = { taskNumber: number; runId: string; projectRoot: string };
export type BuildClosureNoteOutput = { closureNote: string };

function occurrenceLabel(occurrenceId: string): string {
    return occurrenceId === "" ? "(root)" : occurrenceId;
}

function renderTaskTests(taskTests: TaskTestResult | null): string {
    if (taskTests === null) return "(not recorded)";
    return `${taskTests.testFiles.length} files, ${taskTests.passed ? "green" : "red"}`;
}

function renderFullSuite(fullSuite: FullSuiteResult | null, exitType: TaskRunRecord["exitType"]): string {
    if (fullSuite === null) return exitType === "suite-red" ? "not run (rebase tests failed first)" : "(not recorded)";
    return fullSuite.passed ? "green" : "red";
}

export function renderClosureNote(taskNumber: number, record: TaskRunRecord): string {
    const commitLines = record.commits
        .map((commit) => `  ${commit.hash}  ${occurrenceLabel(commit.occurrenceId)}   ${commit.kind}`)
        .join("\n");
    const modifiedFiles = record.modifiedFiles.length > 0 ? record.modifiedFiles.join(", ") : "none";
    return [
        `Task ${taskNumber} ${record.exitType}.`,
        "",
        "Commits:",
        commitLines,
        `Modified files: ${modifiedFiles}`,
        `Task tests: ${renderTaskTests(record.taskTests)}`,
        `Full suite: ${renderFullSuite(record.fullSuite, record.exitType)}`,
    ].join("\n");
}

// F6: reads the specified run, never "the newest", so a late call can never describe the
// wrong run's commits, files, and test results.
export function buildClosureNote(input: BuildClosureNoteInput): BuildClosureNoteOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    const state = readTaskRunState(input.taskNumber, input.projectRoot);
    const record = state.history.find((candidate) => candidate.runId === input.runId);
    if (record === undefined) throw new Error(`buildClosureNote: task ${input.taskNumber} has no run "${input.runId}" in its history`);
    return { closureNote: renderClosureNote(input.taskNumber, record) };
}

if (process.argv[1]?.endsWith("buildClosureNote.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as BuildClosureNoteInput;
    const output = buildClosureNote(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
