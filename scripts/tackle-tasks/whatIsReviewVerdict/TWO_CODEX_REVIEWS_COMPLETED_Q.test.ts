// Behavioral checks for TWO_CODEX_REVIEWS_COMPLETED_Q.ts. Ported from pipeline-reviewPlan's ARE_2_REVIEWS_DONE test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./TWO_CODEX_REVIEWS_COMPLETED_Q.ts";
import { claimTask, raiseAttemptCount } from "../shared/taskRunState.ts";
import { writeCheckpoint } from "../shared/checkpoint.ts";

function writeCheckpointResumedFrom(worktree: string, exitType: string | null): void {
    writeCheckpoint(worktree, {
        taskNumber: 42, passId: "pass-3", runId: "run-1", projectRoot: worktree,
        block: "pipeline-whatIsReviewVerdict.mmd::TWO_CODEX_REVIEWS_COMPLETED_Q", input: "", state: "running",
        sourceLockHeld: false, exitType: "", exitNote: "",
        resumedFrom: exitType === null ? null : { block: "pipeline-whatIsReviewVerdict.mmd::TWO_CODEX_REVIEWS_COMPLETED_Q", exitType, exitNote: "n" },
    });
}

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
    assert.equal(output.next, "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q");
    assert.equal(output.exitType, "");
});

test("test_main_replansWhenOnlyOneReviewHasHappened", () => {
    const projectRoot = makeFixture();
    raiseAttemptCount(42, "run-1", "planReview", "pass-1", projectRoot);
    const output = main(JSON.stringify(packet(projectRoot)));
    assert.equal(output.next, "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q");
});

test("test_main_scrapsTheTaskWhenTwoReviewsAreDone", () => {
    const projectRoot = makeFixture();
    raiseAttemptCount(42, "run-1", "planReview", "pass-1", projectRoot);
    raiseAttemptCount(42, "run-1", "planReview", "pass-2", projectRoot);
    writeCheckpointResumedFrom(projectRoot, null);
    const output = main(JSON.stringify(packet(projectRoot)));
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.exitType, "plan-scrapped");
    assert.match(output.exitNote as string, /two reviews/);
});

test("test_main_replansOnceMoreOnTheRelaunchAfterAScrap", () => {
    const projectRoot = makeFixture();
    raiseAttemptCount(42, "run-1", "planReview", "pass-1", projectRoot);
    raiseAttemptCount(42, "run-1", "planReview", "pass-2", projectRoot);
    writeCheckpointResumedFrom(projectRoot, "plan-scrapped");
    const output = main(JSON.stringify(packet(projectRoot)));
    assert.equal(output.next, "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q");
    assert.equal(output.exitType, "");
});

test("test_main_throwsWithoutACheckpointAtTheCap", () => {
    const projectRoot = makeFixture();
    raiseAttemptCount(42, "run-1", "planReview", "pass-1", projectRoot);
    raiseAttemptCount(42, "run-1", "planReview", "pass-2", projectRoot);
    assert.throws(() => main(JSON.stringify(packet(projectRoot))), /no checkpoint/);
});

test("test_main_replansToABoxThatIsStillAValidSuccessorInTheCommittedConfig", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const config = JSON.parse(readFileSync(join(repoRoot, "scripts/tackle-tasks/diagram-steps.json"), "utf8"));
    const entry = config["pipeline-whatIsReviewVerdict.mmd"].find((e: { box: string }) => e.box === "TWO_CODEX_REVIEWS_COMPLETED_Q");
    assert.ok(entry.next.includes("pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q"));
});
