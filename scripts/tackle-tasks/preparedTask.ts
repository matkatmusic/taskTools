// The task record every agent prompt is built from. Its own module so no prompt file
// has to import the dispatch hub, which would make the imports circular.
import { existsSync } from "node:fs";
import { basename } from "node:path";
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
    // Where the review CLI writes its JSON answer; codex-review.json is already a generated-artifact pattern.
    reviewOutputFile: string;
    testReviewFile: string;
    notesFile: string;
    files: string[];
    // The same files as absolute paths, so a prompt can name them without rebuilding the join.
    ownedFilePaths: string[];
    // The test file paired with each owned file by the naming convention, kept to the ones that exist.
    testFilePaths: string[];
    tests: string | null;
    // Written into the task entry by UPDATE_TASK_ENTRY; empty until a replan has been asked for.
    codexReviewNotes: string;
    repoRoot: string;
    taskStateRoot: string;
};

// ---------------------------------------------------------------------------
// loadPreparedTask — read-only. Validates the brief path exists but never writes it; the docs boxes own brief writes.
// ---------------------------------------------------------------------------

// A source file is paired with tests/<its base name>.test.ts; the related-tests hook uses the same convention.
const pairedTestPath = (root: string, file: string) => `${root}/tests/${basename(file).replace(/\.tsx?$/, "")}.test.ts`;

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
        reviewOutputFile: `${worktree}/plans/codex-review.json`,
        testReviewFile: `${worktree}/plans/test-review.json`,
        notesFile: `${worktree}/plans/implementation-notes-${taskNumber}.md`,
        files,
        ownedFilePaths: files.map((file) => `${root}/${file}`),
        testFilePaths: files.map((file) => pairedTestPath(root, file)).filter((path) => existsSync(path)),
        tests: typeof (task as any).tests === "string" ? (task as any).tests : null,
        codexReviewNotes: typeof (task as any).codexReviewNotes === "string" ? (task as any).codexReviewNotes : "",
        repoRoot: worktree,
        taskStateRoot: projectRoot,
    };
}
