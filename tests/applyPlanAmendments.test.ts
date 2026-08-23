// CLI behavior for applyPlanAmendments.ts: validates both files, applies only on an amend
// verdict, and writes the plan back to disk only when applied. The pure amendment rule
// itself is covered by tests/tackle-tasks/planArtifacts.test.ts.
// Run alone: node --test tests/tackle-tasks/applyPlanAmendments.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runApplyPlanAmendmentsCli } from "../../scripts/tackle-tasks/applyPlanAmendments.ts";
import { readAndValidatePlan, type Plan } from "../../scripts/tackle-tasks/planArtifacts.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/applyPlanAmendments.ts", import.meta.url));

function samplePlan(): Plan {
    return {
        task: 42,
        revision: 1,
        sections: [
            { id: "problem", title: "Problem", body: "b" },
            { id: "step-1", title: "Step one", body: "b" },
        ],
    };
}

function makeFixture(plan: Plan, review: unknown): { planFilePath: string; reviewFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "apply-plan-amendments-"));
    const planFilePath = join(dir, "plan.json");
    const reviewFilePath = join(dir, "codex-review.json");
    writeFileSync(planFilePath, JSON.stringify(plan));
    writeFileSync(reviewFilePath, JSON.stringify(review));
    return { planFilePath, reviewFilePath };
}

function runCli(input: unknown, cwd?: string): unknown {
    const output = execFileSync("node", [cliPath], { input: JSON.stringify(input), encoding: "utf8", cwd });
    assert.equal(output.split("\n").filter((line) => line.length > 0).length, 1);
    return JSON.parse(output.trim());
}

test("test_applyPlanAmendmentsCli_writesTheAmendedPlanBackToDiskOnlyWhenApplied", () => {
    const { planFilePath, reviewFilePath } = makeFixture(samplePlan(), {
        verdict: "amend",
        amendments: [{ op: "remove", id: "step-1" }],
    });
    const output = runApplyPlanAmendmentsCli({ projectRoot: "/repo", planFilePath, reviewFilePath, taskNumber: 42 });
    assert.deepEqual(output, { status: "applied", revision: 2, problem: null });
    const written = JSON.parse(readFileSync(planFilePath, "utf8")) as Plan;
    assert.deepEqual(written.sections.map((s) => s.id), ["problem"]);
    assert.equal(written.revision, 2);
});

test("test_applyPlanAmendmentsCli_leavesThePlanFileUntouchedWhenRejected", () => {
    const plan = samplePlan();
    const { planFilePath, reviewFilePath } = makeFixture(plan, {
        verdict: "amend",
        amendments: [{ op: "remove", id: "does-not-exist" }],
    });
    const before = readFileSync(planFilePath, "utf8");
    const output = runApplyPlanAmendmentsCli({ projectRoot: "/repo", planFilePath, reviewFilePath, taskNumber: 42 });
    assert.equal(output.status, "rejected");
    assert.equal(output.revision, 1);
    assert.ok(typeof output.problem === "string");
    assert.equal(readFileSync(planFilePath, "utf8"), before);
});

test("test_applyPlanAmendmentsCli_rejectsAScrapVerdictWithoutApplying", () => {
    const { planFilePath, reviewFilePath } = makeFixture(samplePlan(), { verdict: "scrap", notes: "start over" });
    const output = runApplyPlanAmendmentsCli({ projectRoot: "/repo", planFilePath, reviewFilePath, taskNumber: 42 });
    assert.equal(output.status, "rejected");
    assert.equal(output.revision, 1);
});

test("test_applyPlanAmendmentsCli_rejectsAnUnreadablePlanFile", () => {
    const { reviewFilePath } = makeFixture(samplePlan(), { verdict: "amend", amendments: [{ op: "remove", id: "step-1" }] });
    const output = runApplyPlanAmendmentsCli({
        projectRoot: "/repo",
        planFilePath: "/does/not/exist.json",
        reviewFilePath,
        taskNumber: 42,
    });
    assert.equal(output.status, "rejected");
    assert.equal(output.revision, 0);
});

test("test_applyPlanAmendmentsCli_rejectsAnUnreadableReviewFile", () => {
    const { planFilePath } = makeFixture(samplePlan(), { verdict: "amend", amendments: [] });
    const output = runApplyPlanAmendmentsCli({
        projectRoot: "/repo",
        planFilePath,
        reviewFilePath: "/does/not/exist.json",
        taskNumber: 42,
    });
    assert.equal(output.status, "rejected");
    assert.equal(output.revision, 1);
});

test("test_applyPlanAmendmentsCli_printsOneLineOfJsonOnStdout", () => {
    const { planFilePath, reviewFilePath } = makeFixture(samplePlan(), {
        verdict: "amend",
        amendments: [{ op: "remove", id: "step-1" }],
    });
    const output = runCli({ projectRoot: "/repo", planFilePath, reviewFilePath, taskNumber: 42 });
    assert.deepEqual(output, { status: "applied", revision: 2, problem: null });
});

test("test_applyPlanAmendmentsCli_leavesTheOriginalPlanValidAndByteIdenticalWhenTheWriteFails", () => {
    const { planFilePath, reviewFilePath } = makeFixture(samplePlan(), {
        verdict: "amend",
        amendments: [{ op: "remove", id: "step-1" }],
    });
    const before = readFileSync(planFilePath, "utf8");
    const dir = dirname(planFilePath);
    chmodSync(dir, 0o500);
    try {
        assert.throws(() => runApplyPlanAmendmentsCli({ projectRoot: "/repo", planFilePath, reviewFilePath, taskNumber: 42 }));
    } finally {
        chmodSync(dir, 0o700);
    }
    assert.equal(readFileSync(planFilePath, "utf8"), before);
    const stillValid = readAndValidatePlan(planFilePath, 42);
    assert.ok(!("problem" in stillValid));
});

test("test_applyPlanAmendmentsCli_behavesIdenticallyFromAnUnrelatedCwd", () => {
    const { planFilePath, reviewFilePath } = makeFixture(samplePlan(), {
        verdict: "amend",
        amendments: [{ op: "remove", id: "step-1" }],
    });
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-cwd-"));
    const output = runCli({ projectRoot: "/repo", planFilePath, reviewFilePath, taskNumber: 42 }, unrelatedCwd);
    assert.deepEqual(output, { status: "applied", revision: 2, problem: null });
});

test("test_applyPlanAmendmentsCli_rejectsARelativePlanFilePath", () => {
    const { planFilePath, reviewFilePath } = makeFixture(samplePlan(), {
        verdict: "amend",
        amendments: [{ op: "remove", id: "step-1" }],
    });
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-cwd-"));
    const relativePlanFilePath = relative(unrelatedCwd, planFilePath);
    assert.throws(() =>
        execFileSync("node", [cliPath], {
            input: JSON.stringify({ projectRoot: "/repo", planFilePath: relativePlanFilePath, reviewFilePath, taskNumber: 42 }),
            encoding: "utf8",
            cwd: unrelatedCwd,
        }),
    );
});
