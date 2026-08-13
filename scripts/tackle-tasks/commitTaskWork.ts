// "commit if needed" x2 (pipeline.mmd). Walks every occurrence deepest-first, commits any
// dirty layer, and derives its own message: never accepts one (rule 7).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getOccurrencesDeepestFirst } from "./occurrences.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";
import { appendTaskCommits, getCurrentTaskRun, type TaskCommit } from "./taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";

export type CommitTaskWorkInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    rootSourceBranch: string;
};

export type CommitTaskWorkOutput = { commits: TaskCommit[] };

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function isDirty(checkoutPath: string): boolean {
    return git(checkoutPath, "status", "--porcelain").trim() !== "";
}

function readTaskTitle(taskNumber: number, projectRoot: string): string {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    return typeof task.title === "string" ? task.title : `task ${taskNumber}`;
}

export function commitTaskWork(input: CommitTaskWorkInput): CommitTaskWorkOutput {
    const { projectRoot, worktreePath, taskNumber, rootSourceBranch } = input;
    configureGeneratedArtifactIsolation(taskNumber, worktreePath);

    const currentRun = getCurrentTaskRun(taskNumber, projectRoot);
    const hasEarlierCommit = (currentRun?.commits.length ?? 0) > 0;
    const message = hasEarlierCommit
        ? `task ${taskNumber}: fixed code making tests fail`
        : `task ${taskNumber}: ${readTaskTitle(taskNumber, projectRoot)}`;
    const kind: TaskCommit["kind"] = hasEarlierCommit ? "repair" : "work";

    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, rootSourceBranch);
    const commits: TaskCommit[] = [];
    for (const occurrence of occurrences) {
        if (!isDirty(occurrence.checkoutPath)) continue;
        git(occurrence.checkoutPath, "add", "-A");
        git(occurrence.checkoutPath, "commit", "-q", "-m", message);
        const hash = git(occurrence.checkoutPath, "rev-parse", "HEAD").trim();
        commits.push({ occurrenceId: occurrence.occurrenceId, hash, kind });
    }

    if (commits.length > 0) appendTaskCommits(taskNumber, commits, projectRoot);
    return { commits };
}

if (process.argv[1]?.endsWith("commitTaskWork.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CommitTaskWorkInput;
    const output = commitTaskWork(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
