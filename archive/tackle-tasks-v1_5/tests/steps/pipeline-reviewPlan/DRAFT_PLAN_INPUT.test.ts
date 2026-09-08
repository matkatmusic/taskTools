// Behavioral checks for scripts/steps/pipeline-reviewPlan/DRAFT_PLAN_INPUT.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/DRAFT_PLAN_INPUT.ts";

function makeFixture(): { worktree: string; projectRoot: string } {
    const worktree = mkdtempSync(join(tmpdir(), "draft-plan-input-"));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "plans/brief-42.md"), "the brief");
    writeFileSync(join(worktree, "src/owned.ts"), "export const x = 1;");
    writeFileSync(join(worktree, "tasks.json"), JSON.stringify([{ taskNumber: 42, title: "t", files: ["src/owned.ts"] }]));
    return { worktree, projectRoot: worktree };
}

function packetFrom(fixture: ReturnType<typeof makeFixture>) {
    return {
        taskNumber: 42,
        runId: "run-1",
        worktree: fixture.worktree,
        sourceBranch: "main",
        projectRoot: fixture.projectRoot,
        planFile: "/repo/.worktrees/task-42/plans/plan.json",
        clarifyRequest: "",
    };
}

test("test_main_stampsItsOwnBoxAndContinueSignal", () => {
    const output = main(JSON.stringify(packetFrom(makeFixture())));
    assert.equal(output.box, "DRAFT_PLAN_INPUT");
    assert.equal(output.scriptSignal, "continue");
});

test("test_main_derivesTheFilePathsFromTaskWorktreeAndProjectRoot", () => {
    const fixture = makeFixture();
    const output = main(JSON.stringify(packetFrom(fixture)));
    assert.equal(output.taskNumber, 42);
    assert.equal(output.taskStateRoot, fixture.projectRoot);
    assert.equal(output.repoRoot, fixture.worktree);
    assert.equal(output.briefFile, join(fixture.worktree, "plans/brief-42.md"));
    assert.equal(output.planFile, join(fixture.worktree, "plans/plan.json"));
    assert.equal(output.reviewOutputFile, join(fixture.worktree, "plans/codex-review.json"));
    assert.deepEqual(output.ownedFilePaths, [join(fixture.worktree, "src/owned.ts")]);
});

test("test_main_carriesRunIdAndSourceBranchForward", () => {
    const fixture = makeFixture();
    const packet = packetFrom(fixture);
    const output = main(JSON.stringify(packet));
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
});

test("test_main_throwsWhenWorktreeIsNotAnAbsolutePath", () => {
    const fixture = makeFixture();
    const packet = { ...packetFrom(fixture), worktree: "relative/path" };
    assert.throws(() => main(JSON.stringify(packet)), /worktree/);
});
