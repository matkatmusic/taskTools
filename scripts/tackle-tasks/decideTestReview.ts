// "are the tests flagged?" — pipeline-reviewTests.mmd. Rules on the reviewer's answer so no prompt derives it in prose.
import { readFileSync } from "node:fs";

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

if (process.argv[1]?.endsWith("decideTestReview.ts")) {
    const review = JSON.parse(readFileSync(0, "utf8")) as TestReview;
    process.stdout.write(`${JSON.stringify(decideTestReview(review))}\n`);
}
