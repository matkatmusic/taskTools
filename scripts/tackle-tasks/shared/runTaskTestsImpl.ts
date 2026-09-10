// Implements pipeline-taskTests.mmd: diffs each occurrence's branch against its own baseRef, deepest first, to run node --test on touched tests.
import { execFileSync } from "node:child_process";
import { getOccurrencesDeepestFirst, buildOccurrencePath } from "./occurrences.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { readTaskFile, resolveTaskFiles, taskHasTests } from "../../shared/taskFiles.ts";
import { TASK_HAS_TESTS } from "../../shared/resultCodes.ts";
import { existsSync } from "node:fs";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { pairedTestPath } from "./preparedTask.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { runSuite, parseFailingTests, readKnownFailingTests, newFailingTests, judgeSuite, SUITE_TIMEOUT_MS, type FailingTest } from "../../shared/taskTestsRunner.ts";

const MAX_OUTPUT_LENGTH = 8000;
// const TEST_FILE_PATTERN = /^tests\/.*\.test\.ts$/;
const TEST_FILE_PATTERN = /\.test\.ts$/; // co-located scripts/**/x.test.ts count too

export type RunTaskTestsOutput = {
    stepId: string;
    passed: boolean;
    testFiles: string[];
    createdTestFiles: string[];
    deletedTestFiles: string[];
    missingTests: boolean;
    output: string;
    newFailingTests: FailingTest[];
    knownFailingTests: FailingTest[];
};

function truncateOutput(output: string): string {
    return output.length <= MAX_OUTPUT_LENGTH ? output : output.slice(-MAX_OUTPUT_LENGTH);
}

type DiffChange = {
    kind: "A" | "M" | "D" | "R" | "C" | string;
    oldPath?: string;
    newPath?: string;
    runnablePath?: string;
};

// `-z` NUL-delimits fields, so whitespace in paths and rename/copy's three fields never look ambiguous under a whitespace split.
function diffNameStatus(checkoutPath: string, baseRef: string): DiffChange[] {
    const raw = execFileSync("git", ["-C", checkoutPath, "diff", "--name-status", "-z", `${baseRef}...HEAD`], {
        encoding: "utf8",
    });
    const tokens = raw.split("\0").filter((token) => token !== "");
    const changes: DiffChange[] = [];
    for (let i = 0; i < tokens.length; ) {
        const statusToken = tokens[i];
        const kind = statusToken[0];
        if (kind === "R" || kind === "C") {
            const oldPath = tokens[i + 1];
            const newPath = tokens[i + 2];
            changes.push({ kind, oldPath, newPath, runnablePath: newPath });
            i += 3;
        } else if (kind === "D") {
            const oldPath = tokens[i + 1];
            changes.push({ kind, oldPath });
            i += 2;
        } else {
            const path = tokens[i + 1];
            changes.push({ kind, newPath: path, runnablePath: path });
            i += 2;
        }
    }
    return changes;
}

function isTestPath(path: string | undefined): path is string {
    return path !== undefined && TEST_FILE_PATTERN.test(path);
}

// function runNodeTest(checkoutPath: string, relativeTestFiles: string[]): { passed: boolean; output: string } {
//     try {
//         // ponytail: strip NODE_TEST_CONTEXT so a red child suite can't inherit a green parent's test context
//         const { NODE_TEST_CONTEXT: _parentTestContext, ...env } = process.env;
//         const stdout = execFileSync("node", ["--test", ...relativeTestFiles], {
//             cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env,
//         });
//         return { passed: true, output: stdout };
//     } catch (error) {
//         const execError = error as { status?: number | null; stdout?: string; stderr?: string };
//         if (execError.status === undefined || execError.status === null) throw error;
//         return { passed: false, output: `${execError.stdout ?? ""}${execError.stderr ?? ""}` };
//     }
// }

export async function runTaskTests(
    taskNumber: number,
    expectedRunId: string,
    worktreePath: string,
    stepId: string,
    projectRoot: string,
    timeoutMs: number = SUITE_TIMEOUT_MS,
): Promise<RunTaskTestsOutput> {
    requireAbsolutePath("projectRoot", projectRoot);
    requireAbsolutePath("worktreePath", worktreePath);
    // const baseBranch = execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const baseBranch = "staging";
    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, baseBranch);

    const testFiles: string[] = [];
    const createdTestFiles: string[] = [];
    const deletedTestFiles: string[] = [];
    const relativeTestFilesByOccurrenceId = new Map<string, string[]>();

    for (const occurrence of occurrences) {
        const changes = diffNameStatus(occurrence.checkoutPath, occurrence.baseRef);
        const runnable = changes.filter((change) => isTestPath(change.runnablePath));
        const deleted = changes.filter((change) => change.kind === "D" && isTestPath(change.oldPath));
        if (runnable.length > 0) {
            relativeTestFilesByOccurrenceId.set(occurrence.occurrenceId, runnable.map((change) => change.runnablePath!));
        }
        for (const change of runnable) {
            const taggedPath = buildOccurrencePath(occurrence.occurrenceId, change.runnablePath!);
            testFiles.push(taggedPath);
            if (change.kind === "A") createdTestFiles.push(taggedPath);
        }
        for (const change of deleted) {
            deletedTestFiles.push(buildOccurrencePath(occurrence.occurrenceId, change.oldPath!));
        }
    }

    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    const taskDeclaresTests = task !== undefined && taskHasTests(task) === TASK_HAS_TESTS;
    // Every owned file must have its paired tests/<file name>.test.ts on disk, not just any test file.
    const absentPairedTests = taskDeclaresTests
        ? modifiableFiles(task!).map((file) => pairedTestPath(worktreePath, file)).filter((path) => !existsSync(path))
        : [];

    let passed: boolean;
    let missingTests: boolean;
    let taskNewFailingTests: FailingTest[] = [];
    let taskKnownFailingTests: FailingTest[] = [];
    const outputParts: string[] = [];
    if (testFiles.length === 0 || absentPairedTests.length > 0) {
        missingTests = taskDeclaresTests;
        passed = !missingTests;
        if (missingTests) outputParts.push(`the task declares tests but the branch lacks: ${absentPairedTests.join(", ")}`);
    } else {
        missingTests = false;
        // ponytail: runs the top-level worktree's suite only; submodule suites are not run here.
        const suite = await runSuite(worktreePath, timeoutMs);
        const failing = suite.allPassing ? [] : parseFailingTests(suite.log);
        const known = readKnownFailingTests(projectRoot);
        const newFailures = newFailingTests(failing, known);
        if (suite.timedOut) {
            passed = false;
        } else {
            passed = judgeSuite(suite.allPassing, failing, newFailures);
        }
        taskNewFailingTests = newFailures;
        taskKnownFailingTests = failing.filter((test) => !newFailures.includes(test));
        outputParts.push(...taskNewFailingTests.map((test) => `new failing test: ${test.file} — ${test.name}`));
        outputParts.push(...taskKnownFailingTests.map((test) => `known failing test (ignored): ${test.file} — ${test.name}`));
        if (suite.timedOut) outputParts.push(`the branch's test suite timed out after ${timeoutMs}ms and was killed`);
        outputParts.push(suite.output);
        outputParts.push(truncateOutput(suite.log));
    }

    // A deleted test is an explicit deterministic red, never an accidental node --test file-not-found on a missing path.
    if (deletedTestFiles.length > 0) {
        passed = false;
        outputParts.push(`the branch deleted test file(s): ${deletedTestFiles.join(", ")}`);
    }

    const output = outputParts.join("\n");

    const result: RunTaskTestsOutput = {
        stepId, passed, testFiles, createdTestFiles, deletedTestFiles, missingTests, output,
        newFailingTests: taskNewFailingTests, knownFailingTests: taskKnownFailingTests,
    };
    updateCurrentTaskRun(taskNumber, expectedRunId, { taskTests: { ...result, checkedAt: getLocalIsoTimestamp() } }, projectRoot);
    return result;
}
