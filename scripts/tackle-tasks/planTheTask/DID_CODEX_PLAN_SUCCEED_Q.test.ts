// Behavioral checks for DID_CODEX_PLAN_SUCCEED_Q.ts: routes on the codex-done file, not the agent's own report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./DID_CODEX_PLAN_SUCCEED_Q.ts";

function makeWorktree(): string {
    const worktree = mkdtempSync(join(tmpdir(), "did-codex-plan-succeed-q-"));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    return worktree;
}

function makePacket(worktree: string) {
    return JSON.stringify({
        box: "PLAN_THE_TASK_CODEX", scriptSignal: "continue", taskNumber: 35, runId: "run-1",
        projectRoot: "/proj", worktree, branch: "task-35", planFile: "", exitType: "", exitNote: "",
        message: "", additionalData: { outcome: "PLAN", planFile: `${worktree}/plans/plan.json`, clarifyRequest: "" },
    });
}

test("test_main_routesToWhatDidThePlannerReturnAndKeepsAdditionalDataWhenDoneFileIsZero", () => {
    const worktree = makeWorktree();
    writeFileSync(join(worktree, "plans", "PLAN_THE_TASK.codex-done"), "0\n");

    const output = main(makePacket(worktree));

    assert.equal(output.next, "pipeline-whatDidThePlannerReturn.mmd::WHAT_DID_THE_PLANNER_RETURN");
    assert.deepEqual(output.additionalData, { outcome: "PLAN", planFile: `${worktree}/plans/plan.json`, clarifyRequest: "" });
    rmSync(worktree, { recursive: true, force: true });
});

test("test_main_routesToPlanTheTaskWhenDoneFileIsNonZero", () => {
    const worktree = makeWorktree();
    writeFileSync(join(worktree, "plans", "PLAN_THE_TASK.codex-done"), "1\n");

    const output = main(makePacket(worktree));

    assert.equal(output.next, "PLAN_THE_TASK");
    assert.deepEqual(output.additionalData, { outcome: "", planFile: "", clarifyRequest: "" });
    rmSync(worktree, { recursive: true, force: true });
});

test("test_main_routesToPlanTheTaskWhenDoneFileIsMissing", () => {
    const worktree = makeWorktree();

    const output = main(makePacket(worktree));

    assert.equal(output.next, "PLAN_THE_TASK");
    assert.deepEqual(output.additionalData, { outcome: "", planFile: "", clarifyRequest: "" });
    rmSync(worktree, { recursive: true, force: true });
});
