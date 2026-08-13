// "commit if needed" x2 (pipeline.mmd). Walks every occurrence deepest-first, commits any
// dirty layer, and derives its own message: never accepts one (rule 7).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireAbsolutePath } from "./inputPaths.ts";
import { getOccurrencesDeepestFirst } from "./occurrences.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";
import { appendTaskCommits, getCurrentTaskRun, type TaskCommit } from "./taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";

export type CommitTaskWorkInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    stepId: string;
    rootSourceBranch: string;
};

export type CommitTaskWorkOutput = { commits: TaskCommit[] };

const STEP_TRAILER = "Task-Step";
const STEP_TRAILER_PATTERN = new RegExp(`^${STEP_TRAILER}: (.+)$`, "m");

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function isDirty(checkoutPath: string): boolean {
    return git(checkoutPath, "status", "--porcelain").trim() !== "";
}

// F2: embeds the logical step in the commit itself, so a commit that landed but whose result
// never reached the run record is still recognizable as "made by this step" on a safe rerun.
function commitMessageWithStepTrailer(message: string, stepId: string): string {
    return `${message}\n\n${STEP_TRAILER}: ${stepId}`;
}

function readHeadStepId(checkoutPath: string): string | null {
    const body = git(checkoutPath, "log", "-1", "--format=%B");
    return STEP_TRAILER_PATTERN.exec(body)?.[1]?.trim() ?? null;
}

function readTaskTitle(taskNumber: number, projectRoot: string): string {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    return typeof task.title === "string" ? task.title : `task ${taskNumber}`;
}

export function commitTaskWork(input: CommitTaskWorkInput): CommitTaskWorkOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const { taskNumber, runId, stepId, rootSourceBranch } = input;
    configureGeneratedArtifactIsolation(taskNumber, worktreePath);

    const currentRun = getCurrentTaskRun(taskNumber, projectRoot);
    const priorCommits = currentRun?.commits ?? [];
    const hasEarlierCommit = priorCommits.length > 0;
    const message = hasEarlierCommit
        ? `task ${taskNumber}: fixed code making tests fail`
        : `task ${taskNumber}: ${readTaskTitle(taskNumber, projectRoot)}`;
    const kind: TaskCommit["kind"] = hasEarlierCommit ? "repair" : "work";

    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, rootSourceBranch);
    const commits: TaskCommit[] = [];
    for (const occurrence of occurrences) {
        // Idempotent rerun: this step already has a durable record entry for this layer.
        const alreadyRecorded = priorCommits.some(
            (commit) => commit.occurrenceId === occurrence.occurrenceId && commit.stepId === stepId,
        );
        if (alreadyRecorded) continue;

        if (isDirty(occurrence.checkoutPath)) {
            git(occurrence.checkoutPath, "add", "-A");
            git(occurrence.checkoutPath, "commit", "-q", "-m", commitMessageWithStepTrailer(message, stepId));
            const hash = git(occurrence.checkoutPath, "rev-parse", "HEAD").trim();
            commits.push({ occurrenceId: occurrence.occurrenceId, hash, kind, stepId });
            continue;
        }

        // F2: the layer is clean, but its HEAD was made by this exact step and was never
        // recorded (the process died between `git commit` and `appendTaskCommits`). Append the
        // hash that already landed instead of silently skipping it or making a second commit.
        if (readHeadStepId(occurrence.checkoutPath) === stepId) {
            const hash = git(occurrence.checkoutPath, "rev-parse", "HEAD").trim();
            commits.push({ occurrenceId: occurrence.occurrenceId, hash, kind, stepId });
        }
    }

    if (commits.length > 0) appendTaskCommits(taskNumber, runId, commits, projectRoot);
    return { commits };
}

if (process.argv[1]?.endsWith("commitTaskWork.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CommitTaskWorkInput;
    const output = commitTaskWork(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
