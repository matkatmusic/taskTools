// Behavioral checks for scripts/tackle-tasks/planPrompt.ts, extracted from PlannerBodyEmitter.test.ts so this shared module (also used by scripts/steps/pipeline-plan/PLAN_THE_TASK.ts) has its own home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPrompt, planPromptSkeleton } from "./planPrompt.ts";
import type { PreparedTask } from "./preparedTask.ts";

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
    readOnlyFiles: ["*"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    readFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    createsFiles: [],
    difficulty: 1,
    clarifyRequest: "",
    testFilePaths: [],
    hasTests: true,
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    siblingTasks: [],
    blockedBy: [],
    blocks: [],
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

test("test_planPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent", () => {
    const prompt = planPrompt(fakeTask);
    // Retired (task 11): planPrompt no longer takes a second argument to compare against.
    // assert.equal(prompt, planPrompt(fakeTask, {}));
    assert.ok(prompt.startsWith("## YOUR JOB"));
    for (const marker of ["writeClarifyRequest.ts", "recordPlanReview.ts", "updateTaskDocs.ts", "TTCLARIFY", "TTREVIEW", "TTDOCS"]) {
        assert.equal(prompt.includes(marker), false, `unexpected "${marker}" in a default prompt`);
    }
});

// Retired (task 11): planPrompt's extra param (clarifyRequest/planReview/updateDocs) is retired; see planPrompt.ts.
// test("test_planPrompt_prependsACommandBlockPerPresentPayloadField", () => {
//     const clarifyPrompt = planPrompt(fakeTask, { clarifyRequest: "need the migration file" });
//     assert.match(clarifyPrompt, /node \S*writeClarifyRequest\.ts <<'TTCLARIFY'/);
//     assert.ok(clarifyPrompt.indexOf("TTCLARIFY") < clarifyPrompt.indexOf("## YOUR JOB"));
//
//     const review = { outcome: "OK" as const, missingFiles: [], message: "", issues: [], fixes: [], sectionsThatHoldUp: [] };
//     const reviewPrompt = planPrompt(fakeTask, { planReview: review });
//     assert.match(reviewPrompt, /node \S*recordPlanReview\.ts .* <<'TTREVIEW'/);
//     assert.ok(reviewPrompt.indexOf("TTREVIEW") < reviewPrompt.indexOf("## YOUR JOB"));
//
//     const docsPrompt = planPrompt(fakeTask, { updateDocs: true });
//     assert.match(docsPrompt, /node \S*updateTaskDocs\.ts <<'TTDOCS'/);
//     assert.ok(docsPrompt.indexOf("TTDOCS") < docsPrompt.indexOf("## YOUR JOB"));
//
//     // A clarify round always re-enters with both fields set, so the order must be clarify then docs.
//     const combined = planPrompt(fakeTask, { clarifyRequest: "need X", updateDocs: true });
//     assert.ok(combined.indexOf("TTCLARIFY") < combined.indexOf("TTDOCS"));
// });

test("test_planPrompt_readsThePlanShapeThroughReadFileInsteadOfPastingIt", () => {
    const prompt = planPrompt(fakeTask);
    assert.match(prompt, /\/read-file "[^"]*\/plans\/plan-template\.json"/);
    assert.equal(prompt.includes('"sections": ['), false);
    assert.match(prompt, /Set `task` to 99\./);
});

// test("test_planPrompt_tellsThePlannerToVerifyNamedIdentifiersAgainstTheCode", () => {
//     // Setup: the default planner prompt.
//     const prompt = planPrompt(fakeTask);
//     // Verification: the prompt says a name in the task description is unverified until the planner finds it in the owned files.
//     assert.match(prompt, /Treat every such name as unverified: search the owned files for it before you plan against it\./);
// });

test("test_planPrompt_tellsThePlannerItMayReadAnyFileWhenReadOnlyFilesIsWildcard", () => {
    const prompt = planPrompt(fakeTask);
    assert.match(prompt, /You are allowed to read any file in the repository/);
    assert.equal(prompt.includes("and nothing else"), false);
    const fenced = planPrompt({ ...fakeTask, readOnlyFiles: ["src/other.ts"] });
    assert.match(fenced, /nothing else/);
    assert.match(fenced, /src\/other\.ts/);
});

test("test_planPromptSkeleton_holdsOnlyTheSectionsTheChoicesTurnOn", () => {
    const skeleton = planPromptSkeleton({ hasCodexNotes: true, readsAnyFile: false, testsField: "skip" });
    for (const header of ["## CODEX'S PREVIOUS REVIEW NOTES", "## YOUR JOB", "## DESIRED OUTPUT", "## WHAT TO READ", "## FORMATTING THE PLAN", "## PLAN REQUIREMENTS", "## ANSWERING A LEFT-BEHIND CLARIFY REQUEST", "## WHEN TO STOP PLANNING", "## FORBIDDEN ACTIONS", "## ALLOWED ACTIONS", "---- TESTS_FIELD", "`${whatToReturnSection(...)}`"]) {
        assert.ok(skeleton.includes(header), `missing "${header}"`);
    }
    assert.match(skeleton, /nothing else/);
    assert.equal(skeleton.includes("read any file in the repository"), false);
    assert.match(skeleton, /----\nskip\n/);
    assert.equal(skeleton.includes("`${t.tests}`"), false);
    assert.equal(skeleton.includes("the user wrote no example"), false);
    assert.match(skeleton, /`\$\{t\.codexReviewNotes\.trim\(\)\}`/);
});

test("test_planPrompt_gatesTheCodexPlanReviewLineOnDifficultyAboveThree", () => {
    const easy = planPrompt({ ...fakeTask, difficulty: 3 });
    assert.equal(easy.includes("The Codex plan review rejects"), false);
    const hard = planPrompt({ ...fakeTask, difficulty: 4 });
    assert.match(hard, /The Codex plan review rejects/);
});

test("test_planPrompt_addsTheRepeatClarifyRuleOnlyWhenTheTaskCarriesAClarifyRequest", () => {
    const repeat = planPrompt({ ...fakeTask, clarifyRequest: "why?" });
    assert.match(repeat, /This is a repeat round/);
    const first = planPrompt({ ...fakeTask, clarifyRequest: "" });
    assert.equal(first.includes("This is a repeat round"), false);
});

test("test_planPrompt_writesCreatesFilesAsTheExactTaskRecordJson", () => {
    const prompt = planPrompt({ ...fakeTask, createsFiles: ["src/new-file.ts"] });
    assert.ok(prompt.includes(JSON.stringify(["src/new-file.ts"])));
});
