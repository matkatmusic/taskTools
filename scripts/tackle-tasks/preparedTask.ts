// The task record every agent prompt is built from. Its own module so no prompt file
// has to import the dispatch hub, which would make the imports circular.
import { existsSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";

function fail(problem: string): never {
    process.stderr.write(`AgentPromptEmitter: ${problem}\n`);
    process.exit(1);
}

export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    reviewFile: string;
    testReviewFile: string;
    notesFile: string;
    files: string[];
    // The same files as absolute paths, so a prompt can name them without rebuilding the join.
    ownedFilePaths: string[];
    tests: string | null;
    // Written into the task entry by UPDATE_TASK_ENTRY; empty until a replan has been asked for.
    codexReviewNotes: string;
    repoRoot: string;
    taskStateRoot: string;
};

// ---------------------------------------------------------------------------
// loadPreparedTask — read-only. Validates the brief path exists but never writes it; the docs boxes own brief writes.
// ---------------------------------------------------------------------------

export function loadPreparedTask(taskNumber: number, worktree: string, projectRoot: string): PreparedTask {
    const pair = resolveTaskFiles(projectRoot);
    const task = readTaskFile(pair.tasksPath).find((entry: any) => entry.taskNumber === taskNumber);
    if (!task) fail(`task ${taskNumber} not found in tasks.json`);
    const briefFile = `${worktree.replace(/\/+$/, "")}/plans/brief-${taskNumber}.md`;
    if (!existsSync(briefFile)) {
        fail(`brief not found at ${briefFile} — the docs box must write it before this role runs; this emitter is read-only and never creates it`);
    }
    const files: string[] = Array.isArray((task as any).files) ? (task as any).files : [];
    const root = worktree.replace(/\/+$/, "");
    return {
        number: taskNumber,
        briefFile,
        planFile: `${worktree}/plans/plan.json`,
        reviewFile: `${worktree}/plans/codex-review.json`,
        testReviewFile: `${worktree}/plans/test-review.json`,
        notesFile: `${worktree}/plans/task-${taskNumber}-implementation-notes.md`,
        files,
        ownedFilePaths: files.map((file) => `${root}/${file}`),
        tests: typeof (task as any).tests === "string" ? (task as any).tests : null,
        codexReviewNotes: typeof (task as any).codexReviewNotes === "string" ? (task as any).codexReviewNotes : "",
        repoRoot: worktree,
        taskStateRoot: projectRoot,
    };
}
