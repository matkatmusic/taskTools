// "run task tests" — pipeline.mmd. Diffs each occurrence's branch against its own baseRef
// (rule 8: every occurrence, deepest first) to find the tests this task's branch touched,
// then runs node --test on them inside each occurrence's own checkout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getOccurrencesDeepestFirst, buildOccurrencePath } from "./occurrences.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";

const MAX_OUTPUT_LENGTH = 8000;
const TEST_FILE_PATTERN = /^tests\/.*\.test\.ts$/;

export type RunTaskTestsOutput = {
    stepId: string;
    passed: boolean;
    testFiles: string[];
    createdTestFiles: string[];
    missingTests: boolean;
    output: string;
};

function truncateOutput(output: string): string {
    return output.length <= MAX_OUTPUT_LENGTH ? output : output.slice(-MAX_OUTPUT_LENGTH);
}

function diffNameStatus(checkoutPath: string, baseRef: string): { status: string; relativePath: string }[] {
    const raw = execFileSync("git", ["-C", checkoutPath, "diff", "--name-status", `${baseRef}...HEAD`], {
        encoding: "utf8",
    });
    return raw.split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
            const [status, relativePath] = line.split("\t");
            return { status, relativePath };
        });
}

function runNodeTest(checkoutPath: string, relativeTestFiles: string[]): { passed: boolean; output: string } {
    try {
        const stdout = execFileSync("node", ["--test", ...relativeTestFiles], {
            cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        return { passed: true, output: stdout };
    } catch (error) {
        const execError = error as { status?: number | null; stdout?: string; stderr?: string };
        if (execError.status === undefined || execError.status === null) throw error;
        return { passed: false, output: `${execError.stdout ?? ""}${execError.stderr ?? ""}` };
    }
}

export function runTaskTests(
    taskNumber: number,
    worktreePath: string,
    sourceBranch: string,
    stepId: string,
    projectRoot: string,
): RunTaskTestsOutput {
    const occurrences = getOccurrencesDeepestFirst(worktreePath, projectRoot, sourceBranch);

    const testFiles: string[] = [];
    const createdTestFiles: string[] = [];
    const relativeTestFilesByOccurrenceId = new Map<string, string[]>();

    for (const occurrence of occurrences) {
        const changes = diffNameStatus(occurrence.checkoutPath, occurrence.baseRef)
            .filter((change) => TEST_FILE_PATTERN.test(change.relativePath));
        if (changes.length === 0) continue;
        relativeTestFilesByOccurrenceId.set(occurrence.occurrenceId, changes.map((change) => change.relativePath));
        for (const change of changes) {
            const taggedPath = buildOccurrencePath(occurrence.occurrenceId, change.relativePath);
            testFiles.push(taggedPath);
            if (change.status === "A") createdTestFiles.push(taggedPath);
        }
    }

    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    const declaredTests = task?.tests;
    const taskDeclaresTests = typeof declaredTests === "string" && declaredTests !== "skip";

    let passed: boolean;
    let missingTests: boolean;
    let output: string;
    if (testFiles.length === 0) {
        missingTests = taskDeclaresTests;
        passed = !missingTests;
        output = missingTests ? "the task declares tests but the branch added none" : "";
    } else {
        missingTests = false;
        const runs = occurrences
            .filter((occurrence) => relativeTestFilesByOccurrenceId.has(occurrence.occurrenceId))
            .map((occurrence) => runNodeTest(occurrence.checkoutPath, relativeTestFilesByOccurrenceId.get(occurrence.occurrenceId)!));
        passed = runs.every((run) => run.passed);
        output = runs.map((run) => run.output).join("\n");
    }
    output = truncateOutput(output);

    const result: RunTaskTestsOutput = { stepId, passed, testFiles, createdTestFiles, missingTests, output };
    updateCurrentTaskRun(taskNumber, { taskTests: { ...result, checkedAt: getLocalIsoTimestamp() } }, projectRoot);
    return result;
}

export type RunTaskTestsCliInput = {
    taskNumber: number;
    worktreePath: string;
    sourceBranch: string;
    stepId: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("runTaskTests.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RunTaskTestsCliInput;
    const output = runTaskTests(input.taskNumber, input.worktreePath, input.sourceBranch, input.stepId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
