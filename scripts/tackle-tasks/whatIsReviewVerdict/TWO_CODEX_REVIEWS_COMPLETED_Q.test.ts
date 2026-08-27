// Behavioral checks for TWO_CODEX_REVIEWS_COMPLETED_Q.ts. Ported from pipeline-reviewPlan's ARE_2_REVIEWS_DONE test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./TWO_CODEX_REVIEWS_COMPLETED_Q.ts";
import { claimTask, raiseAttemptCount } from "../shared/taskRunState.ts";

function makeFixture(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "two-codex-reviews-done-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{ taskNumber: 42, title: "Fixture task" }]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    claimTask(42, "run-1", projectRoot);
    return projectRoot;
}

function packet(projectRoot: string) {
    return {
        box: "UPDATE_TASKS_JSON", scriptSignal: "continue",
        taskNumber: 42, runId: "run-1", projectRoot, worktree: projectRoot, branch: "main",
        planFile: join(projectRoot, "plan.json"), reviewOutputFile: join(projectRoot, "codex-review.json"),
        exitType: "", exitNote: "", verdict: "AMEND", notes: "",
    };
}

test("test_main_replansWhenTheCounterHasNeverBeenRaised", () => {
    const projectRoot = makeFixture();
    const output = main(JSON.stringify(packet(projectRoot)));
    assert.equal(output.next, "pipeline-planTheTask.mmd::PLAN_THE_TASK");
    assert.equal(output.exitType, "");
});

test("test_main_replansWhenOnlyOneReviewHasHappened", () => {
    const projectRoot = makeFixture();
    raiseAttemptCount(42, "run-1", "planReview", projectRoot);
    const output = main(JSON.stringify(packet(projectRoot)));
    assert.equal(output.next, "pipeline-planTheTask.mmd::PLAN_THE_TASK");
});

test("test_main_scrapsTheTaskWhenTwoReviewsAreDone", () => {
    const projectRoot = makeFixture();
    raiseAttemptCount(42, "run-1", "planReview", projectRoot);
    raiseAttemptCount(42, "run-1", "planReview", projectRoot);
    const output = main(JSON.stringify(packet(projectRoot)));
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "plan-scrapped");
    assert.match(output.exitNote as string, /two reviews/);
});
