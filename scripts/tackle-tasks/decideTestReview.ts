// "are the tests flagged?" — pipeline-reviewTests.mmd. Rules on the reviewer's answer so no prompt derives it in prose.
import { readFileSync } from "node:fs";
import { logStepOutput } from "./logStepOutput.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

export type TestReviewIssue = {
    testFile: string;
    testName: string;
    evidence: string;
    problem: string;
    fix: string;
};

// One shape, enforced by plans/review-tests-schema.json, so outcome is always present.
export type TestReview = {
    outcome: "OK" | "ERROR";
    missingFiles: string[];
    message: string;
    issues: TestReviewIssue[];
    testsThatHoldUp: string[];
};

export type TestReviewVerdict = { flagged: boolean; notes: string };

const issueNote = (issue: TestReviewIssue) => `[${issue.testFile}] ${issue.testName}\n\n${issue.problem}\n\nFix: ${issue.fix}`;

export function decideTestReview(review: TestReview): TestReviewVerdict {
    // The reviewer never saw the tests, so a missing input is flagged rather than read as a clean review.
    if (review.outcome === "ERROR") {
        return { flagged: true, notes: `${review.message} missing: ${review.missingFiles.join(", ")}` };
    }
    return { flagged: review.issues.length > 0, notes: review.issues.map(issueNote).join("\n\n") };
}

const DECIDE_TEST_REVIEW_SOURCE = "scripts/tackle-tasks/decideTestReview.ts:27: decideTestReview";

if (process.argv[1]?.endsWith("decideTestReview.ts")) {
    const [projectRoot, taskNumberArg, boxIdArg] = process.argv.slice(2);
    const boxId = boxIdArg ?? "ARE_TESTS_FLAGGED";
    const N = Number(taskNumberArg);
    const stdinText = readFileSync(0, "utf8");
    const review = JSON.parse(stdinText) as TestReview;
    const runId = getCurrentTaskRun(N, projectRoot)?.runId ?? "unknown-run";
    const identity = { projectRoot, taskNumber: N, runId };
    const command = `node ${process.argv[1]} ${projectRoot} ${taskNumberArg} ${boxId} <"$REVIEW_FILE"\n${stdinText}`;
    try {
        const output = decideTestReview(review);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: DECIDE_TEST_REVIEW_SOURCE, input: review, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: DECIDE_TEST_REVIEW_SOURCE, input: review, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
