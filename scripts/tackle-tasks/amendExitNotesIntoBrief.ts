// "amend last exit notes" — plans/tackle-tasks-v1_5-plan.md Phase 3. Fresh-worktree path only:
// appends one section per previous ended run that has an exitType, newest first, capped at three.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPreviousTaskRuns, type TaskRunRecord } from "./taskRunState.ts";

const MAX_RUNS_AMENDED = 3;

function renderRunSection(run: TaskRunRecord): string {
    const modifiedFiles = run.modifiedFiles.length > 0 ? run.modifiedFiles.join(", ") : "(none recorded)";
    return [
        `## Previous run — ${run.startedAt} (runId ${run.runId})`,
        "",
        `Exit type: ${run.exitType ?? "(none recorded)"}`,
        `Exit note: ${run.exitNote ?? "(none recorded)"}`,
        `Modified files: ${modifiedFiles}`,
        `Implementation notes: ${run.implementationNotesFile ?? "(none recorded)"}`,
        "",
    ].join("\n");
}

export type AmendExitNotesIntoBriefOutput = { briefFile: string; runsAmended: number };

export function amendExitNotesIntoBrief(
    taskNumber: number,
    worktreePath: string,
    projectRoot: string,
): AmendExitNotesIntoBriefOutput {
    const briefFile = join(worktreePath, "plans", `brief-${taskNumber}.md`);
    const runsWithExitType = getPreviousTaskRuns(taskNumber, projectRoot)
        .filter((run) => run.exitType !== null)
        .reverse();
    if (runsWithExitType.length === 0) return { briefFile, runsAmended: 0 };

    const kept = runsWithExitType.slice(0, MAX_RUNS_AMENDED);
    const omittedCount = runsWithExitType.length - kept.length;
    const sections = [
        "",
        "## Previous runs",
        "",
        ...(omittedCount > 0 ? [`(${omittedCount} earlier runs omitted)`, ""] : []),
        ...kept.map(renderRunSection),
    ].join("\n");
    appendFileSync(briefFile, sections);
    return { briefFile, runsAmended: kept.length };
}

export type AmendExitNotesIntoBriefCliInput = { taskNumber: number; worktreePath: string; projectRoot: string };

if (process.argv[1]?.endsWith("amendExitNotesIntoBrief.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as AmendExitNotesIntoBriefCliInput;
    const output = amendExitNotesIntoBrief(input.taskNumber, input.worktreePath, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
