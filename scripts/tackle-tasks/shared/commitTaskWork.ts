// "commit if needed" x2 (pipeline.mmd). Walks occurrences deepest-first, commits dirty layers, derives its own message (rule 7).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireAbsolutePath } from "./inputPaths.ts";
import { getOccurrencesDeepestFirst } from "./occurrences.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";
import { appendTaskCommits, getCurrentTaskRun, type TaskCommit } from "./taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { logStepOutput } from "./logStepOutput.ts";

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

// F2: a commit's step is embedded in its message, so an unrecorded-but-landed commit is still recognizable on rerun.
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

        // F2: HEAD already matches this step but wasn't recorded; append its hash instead of committing again.
        if (readHeadStepId(occurrence.checkoutPath) === stepId) {
            const hash = git(occurrence.checkoutPath, "rev-parse", "HEAD").trim();
            commits.push({ occurrenceId: occurrence.occurrenceId, hash, kind, stepId });
        }
    }

    if (commits.length > 0) appendTaskCommits(taskNumber, runId, commits, projectRoot);
    return { commits };
}

const COMMIT_TASK_WORK_SOURCE = "scripts/tackle-tasks/commitTaskWork.ts:50: commitTaskWork";

if (process.argv[1]?.endsWith("commitTaskWork.ts")) {
    const stdinText = readFileSync(0, "utf8");
    const rawInput = JSON.parse(stdinText);
    const input = rawInput as CommitTaskWorkInput;
    // The emitter names the box; a genuinely unresolved call site falls back to the script name.
    const boxId = rawInput.boxId as string;
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId };
    const command = `node ${process.argv[1]} <<'TTCOMMIT'\n${stdinText}\nTTCOMMIT`;

    try {
        const output = commitTaskWork(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: COMMIT_TASK_WORK_SOURCE, input: rawInput, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: COMMIT_TASK_WORK_SOURCE, input: rawInput, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
