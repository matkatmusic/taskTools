import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    isRootDoneMarkerStaged,
    waitForAuditorSignal,
    waitForStagedDone,
} from "../../phase-loop/done-monitor.ts";
import {
    parseFeedbackMarker,
    waitForImplementorSignal,
} from "../../phase-loop/feedback-monitor.ts";
import { DONE_MARKER_NOT_STAGED } from "../../scripts/shared/resultCodes.ts";

function git(projectRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" }).trim();
}

function makeRepository(): string {
    const root = mkdtempSync(join(tmpdir(), "phase-loop-monitor-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "seed.txt"), "seed\n");
    git(root, "add", "seed.txt");
    git(root, "commit", "-q", "-m", "seed");
    return realpathSync(root);
}

test("test_doneMonitor_consumesTheStagedMarkerBeforeFiring", async () => {
    const root = makeRepository();
    const markerPath = join(root, ".done");
    writeFileSync(markerPath, "implementation staged\n");
    git(root, "add", ".done");

    const event = await waitForStagedDone({ projectRoot: root, pollIntervalMs: 5, timeoutMs: 1_000 });

    assert.deepEqual(event, {
        event: "done",
        status: "landed",
        nextAction: "freeze-staged-snapshot-and-audit",
        markerPath: join(realpathSync(root), ".done"),
        contents: "implementation staged\n",
    });
    assert.equal(existsSync(markerPath), false);
    assert.equal(isRootDoneMarkerStaged(root), DONE_MARKER_NOT_STAGED);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("test_doneMonitor_ignoresAnUnstagedMarker", async () => {
    const root = makeRepository();
    writeFileSync(join(root, ".done"), "");

    await assert.rejects(
        waitForStagedDone({ projectRoot: root, pollIntervalMs: 5, timeoutMs: 30 }),
        /timed out waiting/,
    );
    assert.equal(existsSync(join(root, ".done")), true);
});

test("test_doneMonitor_consumesCompleteAndEndsTheAuditorLoop", async () => {
    const root = makeRepository();
    const markerPath = join(root, ".complete");
    writeFileSync(markerPath, "resolution acknowledged\n");

    const event = await waitForAuditorSignal({ projectRoot: root, pollIntervalMs: 5, timeoutMs: 1_000 });

    assert.deepEqual(event, {
        event: "complete",
        status: "landed",
        nextAction: "end-auditor-loop",
        markerPath: join(realpathSync(root), ".complete"),
        contents: "resolution acknowledged\n",
    });
    assert.equal(existsSync(markerPath), false);
});

function createReviewFiles(root: string): { planPath: string; auditPath: string; reviewPath: string } {
    const plans = join(root, "plans");
    mkdirSync(plans);
    const planPath = join(plans, "plan.md");
    const auditPath = join(plans, "audit.md");
    const reviewPath = join(plans, "feedback-phase7-2.md");
    writeFileSync(planPath, "plan\n");
    writeFileSync(auditPath, "audit\n");
    writeFileSync(reviewPath, "final review\n");
    return { planPath, auditPath, reviewPath };
}

function feedbackContents(review = "plans/feedback-phase7-2.md"): string {
    return [
        ".plan=plans/plan.md",
        ".audit=plans/audit.md",
        `.review=${review}`,
        "",
    ].join("\n");
}

function publishFeedback(root: string, review = "plans/feedback-phase7-2.md"): string {
    const markerPath = join(root, ".feedback");
    writeFileSync(markerPath, feedbackContents(review));
    return markerPath;
}

test("test_feedbackMonitor_waitsForFeedbackAfterTheReviewFileIsFinal", async () => {
    const root = makeRepository();
    const waiting = waitForImplementorSignal({ projectRoot: root, pollIntervalMs: 5, timeoutMs: 1_000 });
    const paths = createReviewFiles(root);

    const firedBeforePublication = await Promise.race([
        waiting.then(() => true),
        new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 30)),
    ]);
    assert.equal(firedBeforePublication, false);

    const markerPath = publishFeedback(root);

    const event = await waiting;

    assert.deepEqual(event, {
        event: "feedback",
        status: "landed",
        nextAction: "implement-published-feedback",
        markerPath,
        contents: feedbackContents(),
        ...paths,
        relativePlanPath: "plans/plan.md",
        relativeAuditPath: "plans/audit.md",
        relativeReviewPath: "plans/feedback-phase7-2.md",
    });
    assert.equal(existsSync(markerPath), false);
});

test("test_feedbackMonitor_reportsAnExistingFeedbackMarkerImmediately", async () => {
    const root = makeRepository();
    const paths = createReviewFiles(root);
    const markerPath = publishFeedback(root);

    assert.deepEqual(await waitForImplementorSignal({ projectRoot: root }), {
        event: "feedback",
        status: "landed",
        nextAction: "implement-published-feedback",
        markerPath,
        contents: feedbackContents(),
        ...paths,
        relativePlanPath: "plans/plan.md",
        relativeAuditPath: "plans/audit.md",
        relativeReviewPath: "plans/feedback-phase7-2.md",
    });
    assert.equal(existsSync(markerPath), false);
});

test("test_feedbackMonitor_acceptsTheAuditAsTheInitialReview", async () => {
    const root = makeRepository();
    const { auditPath } = createReviewFiles(root);
    publishFeedback(root, "plans/audit.md");

    const event = await waitForImplementorSignal({ projectRoot: root });

    assert.equal(event.event, "feedback");
    if (event.event === "feedback") assert.equal(event.reviewPath, auditPath);
});

test("test_feedbackMonitor_consumesAMarkerWhoseReviewIsMissingBeforeReportingIt", async () => {
    const root = makeRepository();
    createReviewFiles(root);
    const markerPath = publishFeedback(root, "plans/not-written-yet.md");

    await assert.rejects(waitForImplementorSignal({ projectRoot: root }), /review path is not a file/);
    assert.equal(existsSync(markerPath), false);
});

test("test_feedbackMonitor_consumesAMalformedMarkerBeforeReportingIt", async () => {
    const root = makeRepository();
    const markerPath = join(root, ".feedback");
    writeFileSync(markerPath, ".plan=plans/plan.md\n");

    await assert.rejects(waitForImplementorSignal({ projectRoot: root }), /missing .feedback key/);
    assert.equal(existsSync(markerPath), false);
});

test("test_feedbackMonitor_requiresExactlyTheThreeFeedbackFields", () => {
    assert.deepEqual(parseFeedbackMarker(".plan=p\n.audit=a\n.review=r\n"), {
        plan: "p",
        audit: "a",
        review: "r",
    });
    assert.throws(() => parseFeedbackMarker(".plan=p\n.audit=a\n"), /missing .feedback key: .review/);
    assert.throws(
        () => parseFeedbackMarker(".plan=p\n.audit=a\n.review=r\n.review=r2\n"),
        /duplicate .feedback key: .review/,
    );
});

test("test_feedbackMonitor_reportsAnExistingResolvedMarkerImmediately", async () => {
    const root = makeRepository();
    const markerPath = join(root, ".resolved");
    writeFileSync(markerPath, "all audit items resolved\n");

    const event = await waitForImplementorSignal({ projectRoot: root, pollIntervalMs: 5, timeoutMs: 1_000 });

    assert.deepEqual(event, {
        event: "resolved",
        status: "landed",
        nextAction: "acknowledge-resolution-with-complete",
        markerPath,
        contents: "all audit items resolved\n",
    });
    assert.equal(existsSync(markerPath), false);
});

test("test_feedbackMonitor_rejectsConflictingFeedbackAndResolvedMarkers", async () => {
    const root = makeRepository();
    createReviewFiles(root);
    publishFeedback(root);
    writeFileSync(join(root, ".resolved"), "");

    await assert.rejects(
        waitForImplementorSignal({ projectRoot: root, pollIntervalMs: 5, timeoutMs: 1_000 }),
        /conflicting root protocol markers/,
    );
});
