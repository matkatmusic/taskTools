// The task record every agent prompt is built from; its own module avoids prompt files importing the dispatch hub.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { readTaskFile, resolveTaskFiles, taskHasTests } from "../../shared/taskFiles.ts";
import { TASK_HAS_TESTS } from "../../shared/resultCodes.ts";
import { modifiableFiles, readOnlyFiles } from "../../shared/prepareTasks.ts";
import { groupTasksByFileOverlap } from "../../shared/taskGroups.ts";

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
    readOnlyFiles: string[];
    // The same files as absolute paths, so a prompt can name them without rebuilding the join.
    ownedFilePaths: string[];
    // Every /read-file line: readOnlyFiles' absolute paths, then handoffFilePaths, then the owned files that exist on disk.
    readFilePaths: string[];
    // The task record's createsFiles; the planner copies it into the plan, never decides it.
    createsFiles: string[];
    difficulty: number;
    // The question the previous planning round left on the task record; "" when none.
    clarifyRequest: string;
    // The test file paired with each owned file by the naming convention, kept to the ones that exist.
    testFilePaths: string[];
    hasTests: boolean;
    // The user's example test as prose; "skip" on a 1.0.0 entry, "" on a 1.0.1 entry without tests.
    tests: string | null;
    // Written into the task entry by UPDATE_TASK_ENTRY; empty until a replan has been asked for.
    codexReviewNotes: string;
    // Tasks sharing this task's files, from groupTasksByFileOverlap; their work is out of scope for the plan reviewer.
    siblingTasks: { number: number; title: string }[];
    // This task's blockedBy entries from tasks.json; their work is out of scope for the plan reviewer.
    blockedBy: { taskNumber: number; reason: string }[];
    // Tasks whose blockedBy entries name this task; their work is out of scope for the plan reviewer.
    blocks: { number: number; title: string; reason: string }[];
    repoRoot: string;
    taskStateRoot: string;
};

// ---------------------------------------------------------------------------
// loadPreparedTask — read-only. Validates the brief path exists but never writes it; the docs boxes own brief writes.
// ---------------------------------------------------------------------------

// A source file is paired with tests/<its base name>.test.ts; the related-tests hook uses the same convention.
export const pairedTestPath = (root: string, file: string) => `${root}/tests/${basename(file).replace(/\.tsx?$/, "")}.test.ts`;

export function loadPreparedTask(taskNumber: number, worktree: string, projectRoot: string): PreparedTask {
    const pair = resolveTaskFiles(projectRoot);
    const allTasks = readTaskFile(pair.tasksPath);
    const task = allTasks.find((entry: any) => entry.taskNumber === taskNumber);
    if (!task) fail(`task ${taskNumber} not found in tasks.json`);
    const briefFile = `${worktree.replace(/\/+$/, "")}/plans/brief-${taskNumber}.md`;
    if (!existsSync(briefFile)) {
        fail(`brief not found at ${briefFile} — the docs box must write it before this role runs; this emitter is read-only and never creates it`);
    }
    const files: string[] = modifiableFiles(task);
    const root = worktree.replace(/\/+$/, "");
    const declaredReadOnlyFiles = readOnlyFiles(task);
    const readOnlyFilePaths = declaredReadOnlyFiles.filter((file) => file !== "*").map((file) => `${root}/${file}`);
    for (const path of readOnlyFilePaths) {
        if (!existsSync(path)) throw new Error(`task ${taskNumber}: readOnlyFiles names ${path} but the file does not exist`);
    }
    const handoffFilePaths: string[] = Array.isArray((task as any).handoffFilePaths) ? (task as any).handoffFilePaths : [];
    const handoffPaths = handoffFilePaths.map((file) => `${root}/${file}`);
    for (const path of handoffPaths) {
        if (!existsSync(path)) throw new Error(`task ${taskNumber}: handoffFilePaths names ${path} but the file does not exist`);
    }
    const createsFiles: string[] = Array.isArray((task as any).createsFiles) ? (task as any).createsFiles : [];
    for (const file of files) {
        if (createsFiles.includes(file)) continue;
        if (!existsSync(`${root}/${file}`)) throw new Error(`task ${taskNumber}: modifiableFiles names ${root}/${file} but the file does not exist; list it in "createsFiles" if this task creates it, or run the task that creates it first`);
    }
    const group = groupTasksByFileOverlap(allTasks).find((g) => g.taskNumbers.includes(taskNumber));
    const siblingTasks = (group ? group.taskNumbers.filter((n) => n !== taskNumber) : [])
        .map((n) => allTasks.find((entry: any) => entry.taskNumber === n))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .map((entry: any) => ({ number: entry.taskNumber, title: entry.title }));
    const blocks = allTasks
        .filter((entry: any) => Array.isArray(entry.blockedBy))
        .flatMap((entry: any) =>
            (entry.blockedBy as { taskNumber: number; reason: string }[])
                .filter((b) => b.taskNumber === taskNumber)
                .map((b) => ({ number: entry.taskNumber, title: entry.title, reason: b.reason }))
        );
    return {
        number: taskNumber,
        briefFile,
        planFile: `${worktree}/plans/plan.json`,
        reviewFile: `${worktree}/plans/codex-review.json`,
        reviewOutputFile: `${worktree}/plans/codex-review.json`,
        testReviewFile: `${worktree}/plans/test-review.json`,
        notesFile: `${worktree}/plans/implementation-notes-${taskNumber}.md`,
        files,
        readOnlyFiles: declaredReadOnlyFiles,
        ownedFilePaths: files.map((file) => `${root}/${file}`),
        readFilePaths: [...readOnlyFilePaths, ...handoffPaths, ...files.map((file) => `${root}/${file}`).filter((path) => existsSync(path))],
        createsFiles,
        difficulty: Number((task as any).difficulty),
        clarifyRequest: typeof (task as any).clarifyRequest === "string" ? (task as any).clarifyRequest : "",
        testFilePaths: files.map((file) => pairedTestPath(root, file)).filter((path) => existsSync(path)),
        hasTests: taskHasTests(task) === TASK_HAS_TESTS,
        tests: typeof (task as any).tests === "string" ? (task as any).tests : null,
        codexReviewNotes: typeof (task as any).codexReviewNotes === "string" ? (task as any).codexReviewNotes : "",
        siblingTasks,
        blockedBy: Array.isArray((task as any).blockedBy) ? (task as any).blockedBy : [],
        blocks,
        repoRoot: worktree,
        taskStateRoot: projectRoot,
    };
}
