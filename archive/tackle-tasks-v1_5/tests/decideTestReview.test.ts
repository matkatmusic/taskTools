// Behavioral checks for scripts/tackle-tasks/decideTestReview.ts. Run: node --test tests/decideTestReview.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTestReview, type TestReview } from "../scripts/tackle-tasks/decideTestReview.ts";

const clean: TestReview = { outcome: "OK", missingFiles: [], message: "", issues: [], testsThatHoldUp: ["a test"] };
const issue = { testFile: "tests/thing.test.ts", testName: "t", evidence: "tests/thing.test.ts:1-9", problem: "asserts nothing", fix: "assert the return value" };

test("test_decideTestReview_flagsNothingWhenTheReviewerFoundNoIssues", () => {
    assert.deepEqual(decideTestReview(clean), { flagged: false, notes: "" });
});

test("test_decideTestReview_flagsEveryIssueAndCarriesItsProblemAndFix", () => {
    const verdict = decideTestReview({ ...clean, issues: [issue] });
    assert.equal(verdict.flagged, true);
    assert.match(verdict.notes, /asserts nothing/);
    assert.match(verdict.notes, /Fix: assert the return value/);
});

test("test_decideTestReview_flagsAnErrorOutcomeRatherThanReadingItAsACleanReview", () => {
    // An unreadable input means the tests were never judged, which is not the same as no issues.
    const verdict = decideTestReview({ ...clean, outcome: "ERROR", missingFiles: ["/wt/plans/plan.json"], message: "not performed." });
    assert.equal(verdict.flagged, true);
    assert.match(verdict.notes, /missing: \/wt\/plans\/plan\.json/);
});
