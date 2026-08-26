// Renders and writes task briefs, and hides tracked generated docs from a linked worktree's index. No CLI — see plans/tackle-tasks-v1_5-plan.md §1d.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderTaskBriefContent } from "../prepareTasks.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { getPreviousTaskRuns, type TaskRunRecord } from "./taskRunState.ts";

const MAX_PREVIOUS_RUNS_SHOWN = 3;

// Kept in one place so .gitignore (§1f) and every caller of configureGeneratedArtifactIsolation agree.
export const GENERATED_ARTIFACT_PATTERNS = [
    "plans/brief-*.md",
    "plans/plan.json",
    "plans/codex-review.json",
    "plans/test-review.json",
    "plans/implementation-notes-*.md",
];

// startedAt is what tells two runs of the same task apart, so it leads the heading.
function renderPreviousRunSection(run: TaskRunRecord): string {
    const modifiedFiles = run.modifiedFiles.length > 0 ? run.modifiedFiles.join(", ") : "(none recorded)";
    return [
        `### Run ${run.runId} — ${run.startedAt}`,
        "",
        `Exit type: ${run.exitType ?? "(none recorded)"}`,
        `Exit note: ${run.exitNote ?? "(none recorded)"}`,
        `Modified files: ${modifiedFiles}`,
        `Implementation notes: ${run.implementationNotesFile ?? "(none recorded)"}`,
        "",
    ].join("\n");
}

function renderPreviousRunsSection(previousRuns: TaskRunRecord[]): string {
    const runsWithExitType = previousRuns.filter((run) => run.exitType !== null).reverse();
    if (runsWithExitType.length === 0) return "";
    const kept = runsWithExitType.slice(0, MAX_PREVIOUS_RUNS_SHOWN);
    const omittedCount = runsWithExitType.length - kept.length;
    return [
        "",
        "## Previous runs",
        "",
        ...(omittedCount > 0 ? [`(${omittedCount} earlier runs omitted)`, ""] : []),
        ...kept.map(renderPreviousRunSection),
    ].join("\n");
}

export function generateTaskBriefContents(taskNumber: number, projectRoot: string): string {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    const previousRuns = getPreviousTaskRuns(taskNumber, projectRoot);
    return renderTaskBriefContent(task, projectRoot) + renderPreviousRunsSection(previousRuns);
}

export function writeTaskBriefToDisk(taskNumber: number, worktreePath: string, projectRoot: string): string {
    const briefFile = join(worktreePath, "plans", `brief-${taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    writeFileSync(briefFile, generateTaskBriefContents(taskNumber, projectRoot));
    return briefFile;
}

// taskNumber is accepted to match every other worktree-setup call in this pipeline; every
// generated-doc pattern is worktree-wide, not per-task, so it plays no part in the matching.
export function configureGeneratedArtifactIsolation(taskNumber: number, worktreePath: string): string[] {
    void taskNumber;
    const trackedPaths = execFileSync(
        "git", ["-C", worktreePath, "ls-files", "--", ...GENERATED_ARTIFACT_PATTERNS],
        { encoding: "utf8" },
    ).split("\n").filter((line) => line.length > 0);
    if (trackedPaths.length === 0) return [];
    execFileSync("git", ["-C", worktreePath, "update-index", "--skip-worktree", ...trackedPaths]);
    return trackedPaths;
}
