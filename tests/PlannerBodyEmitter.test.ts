import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { skillBody, planPrompt, type RunContext } from "../scripts/tackle-tasks/PlannerBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const ctx: RunContext = { runId: "test-run", projectRoot, sourceBranch: "master" };

// A hand-built PreparedTask for structural tests that never touch a real worktree.
const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
    files: ["src/thing.ts"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    testFilePaths: [],
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

// ponytail: only the read-only exits are covered. The paths past "claim the task" create worktrees and write tasks.json, so they need a fixture repo, not this one.
test("an unknown task number stops with invalid-number and writes nothing", () => {
    const body = skillBody(999999, false, ctx);
    assert.match(body, /Do nothing except report/);
    assert.match(body, /Task 999999: invalid-number/);
});

test("test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent", () => {
    const prompt = planPrompt(fakeTask);
    assert.equal(prompt, planPrompt(fakeTask, {}));
    assert.ok(prompt.startsWith("Invoke the skill `/ponytail:ponytail ultra` first."));
    for (const marker of ["writeClarifyRequest.ts", "recordPlanReview.ts", "updateTaskDocs.ts", "TTCLARIFY", "TTREVIEW", "TTDOCS"]) {
        assert.equal(prompt.includes(marker), false, `unexpected "${marker}" in a default prompt`);
    }
});

test("test_planPrompt_prependsACommandBlockPerPresentPayloadField", () => {
    const clarifyPrompt = planPrompt(fakeTask, { clarifyRequest: "need the migration file" });
    assert.match(clarifyPrompt, /node \S*writeClarifyRequest\.ts <<'TTCLARIFY'/);
    assert.ok(clarifyPrompt.indexOf("TTCLARIFY") < clarifyPrompt.indexOf("Invoke the skill"));

    const review = { outcome: "OK" as const, missingFiles: [], message: "", issues: [], fixes: [], sectionsThatHoldUp: [] };
    const reviewPrompt = planPrompt(fakeTask, { planReview: review });
    assert.match(reviewPrompt, /node \S*recordPlanReview\.ts .* <<'TTREVIEW'/);
    assert.ok(reviewPrompt.indexOf("TTREVIEW") < reviewPrompt.indexOf("Invoke the skill"));

    const docsPrompt = planPrompt(fakeTask, { updateDocs: true });
    assert.match(docsPrompt, /node \S*updateTaskDocs\.ts <<'TTDOCS'/);
    assert.ok(docsPrompt.indexOf("TTDOCS") < docsPrompt.indexOf("Invoke the skill"));

    // A clarify round always re-enters with both fields set, so the order must be clarify then docs.
    const combined = planPrompt(fakeTask, { clarifyRequest: "need X", updateDocs: true });
    assert.ok(combined.indexOf("TTCLARIFY") < combined.indexOf("TTDOCS"));
});
