// Behavioral checks for scripts/tackle-tasks/ImplementBodyEmitter.ts. Run: node --test tests/ImplementBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { implementPrompt } from "../scripts/tackle-tasks/ImplementBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

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
    hasTests: true,
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

test("test_implementPrompt_citesTheOutputTemplateAndCarriesNoDataBlock", () => {
    // The old prompt returned {implemented, implementationNotesFile, remaining} from a trailing DATA block.
    const prompt = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main");
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/implementationNotesFile|remaining/.test(prompt), false);
    assert.match(prompt, /implement-output-template\.json/);
});

test("test_implementPrompt_tellsTheImplementerToObeyTheSectionCodexNotes", () => {
    // recordPlanReview writes a required fix into each section's codexNotes; nothing else reads it.
    const prompt = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main");
    assert.match(prompt, /codexNotes/);
});

test("test_implementPrompt_takesTheNoteFromTheEntryAndOmitsTheSectionWhenItIsEmpty", () => {
    // The amend boxes write codexReviewNotes on the entry; a caller-passed note is easy to lose.
    const sentinel = "SENTINEL_IMPLEMENT_NOTE_7cq2";
    const prompt = implementPrompt({ ...fakeTask, codexReviewNotes: sentinel }, "npx tsc --noEmit", 3, "run-1", "main");
    assert.match(prompt, /## NOTE FOR THIS RUN\n\nSENTINEL_IMPLEMENT_NOTE_7cq2\n/);
    assert.equal(implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main").includes("NOTE FOR THIS RUN"), false);
});

test("test_implementPrompt_readFileListNamesAnOwnedTestFileOnlyOnce", () => {
    // An owned test file is also its own paired test, so the read-file list would otherwise repeat it.
    const owned = "/tmp/fake-worktree/tests/thing.test.ts";
    const task: PreparedTask = { ...fakeTask, ownedFilePaths: [owned], testFilePaths: [owned] };
    const readFileLine = implementPrompt(task, "npx tsc --noEmit", 3, "run-1", "main").split("\n").find((line) => line.startsWith("/read-file "));
    assert.equal(readFileLine?.split(`"${owned}"`).length, 2);
});

test("test_implementPrompt_interpolatesEveryRuntimeValueAndUsesNoAllCapsPlaceholder", () => {
    // Every value now lands where it is used, so no DATA block and no ALL_CAPS stand-in remain.
    const task: PreparedTask = {
        ...fakeTask,
        number: 445566,
        briefFile: "/tmp/SENTINEL_BRIEF_IMPL_d0/brief.md",
        planFile: "/tmp/SENTINEL_PLANFILE_IMPL_d1/plan.json",
        notesFile: "/tmp/SENTINEL_NOTESFILE_IMPL_d2/notes.md",
        files: ["SENTINEL_FILE_IMPL_d3.ts"],
        repoRoot: "/tmp/SENTINEL_REPOROOT_IMPL_d5",
    };
    const typecheckCommand = "SENTINEL_TYPECHECK_IMPL_d7";
    const maxFixRounds = 918273;
    const prompt = implementPrompt({ ...task, codexReviewNotes: "SENTINEL_NOTE_IMPL_d6" }, typecheckCommand, maxFixRounds, "run-1", "main");
    for (const sentinel of [String(task.number), task.briefFile, task.planFile, task.notesFile,
        task.files[0], task.repoRoot, "SENTINEL_NOTE_IMPL_d6", typecheckCommand, String(maxFixRounds)]) {
        assert.ok(prompt.includes(sentinel), `prompt is missing ${sentinel}`);
    }
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/\b(TASK_WORKTREE|OWNED_PATHS|PLAN_FILE|NOTES_FILE|TESTS_FIELD|MAX_FIX_ROUNDS)\b/.test(prompt), false);
});

test("test_implementPrompt_tellsTheAgentToCommitViaTheScriptAsItsFinalStep", () => {
    // Rule 1 folded the commit into this box's own prompt instead of a separate committer box.
    const prompt = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main");
    assert.match(prompt, /node \S*commitTaskWork\.ts <<'TTCOMMIT'/);
    assert.equal(prompt.includes("a later box owns committing"), false);
    assert.match(prompt, /stage or commit anything by hand/);
});

test("test_implementPrompt_isUnchangedWhenNoNewPayloadFieldsArePresent", () => {
    const prompt = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main");
    assert.equal(prompt, implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main", {}));
    assert.ok(prompt.startsWith("Invoke the skill `/ponytail:ponytail ultra` first."));
    for (const marker of ["amendEntryWithFailingTests.ts", "amendEntryWithCodexNotes.ts", "TTNOTES"]) {
        assert.equal(prompt.includes(marker), false, `unexpected "${marker}" in a default prompt`);
    }
});

test("test_implementPrompt_prependsACommandBlockPerPresentPayloadField", () => {
    const failingPrompt = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main", { amendFailingTests: true });
    assert.match(failingPrompt, /node \S*amendEntryWithFailingTests\.ts .*99/);
    assert.ok(failingPrompt.indexOf("amendEntryWithFailingTests.ts") < failingPrompt.indexOf("Invoke the skill"));

    const review = { outcome: "OK" as const, missingFiles: [], message: "", issues: [], testsThatHoldUp: [] };
    const reviewPrompt = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main", { testReview: review });
    assert.match(reviewPrompt, /node \S*amendEntryWithCodexNotes\.ts .* <<'TTNOTES'/);
    assert.ok(reviewPrompt.indexOf("TTNOTES") < reviewPrompt.indexOf("Invoke the skill"));

    // Both boxes can fire on the same reimplement round; amend-failing-tests reads first.
    const combined = implementPrompt(fakeTask, "npx tsc --noEmit", 3, "run-1", "main", { amendFailingTests: true, testReview: review });
    assert.ok(combined.indexOf("amendEntryWithFailingTests.ts") < combined.indexOf("TTNOTES"));
});
