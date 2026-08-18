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
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

test("test_implementPrompt_citesTheOutputTemplateAndCarriesNoDataBlock", () => {
    // The old prompt returned {implemented, implementationNotesFile, remaining} from a trailing DATA block.
    const prompt = implementPrompt(fakeTask, "", "npx tsc --noEmit", 3);
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/implementationNotesFile|remaining/.test(prompt), false);
    assert.match(prompt, /implement-output-template\.json/);
});

test("test_implementOutputTemplateKeysMatchTheWorkflowImplementResult", () => {
    // The workflow validates the receipt against IMPLEMENT_RESULT, so the template cannot drift from it.
    const templatePath = fileURLToPath(new URL("../plans/implement-output-template.json", import.meta.url));
    const workflowPath = fileURLToPath(new URL("../scripts/tackle-tasks/tackle-tasks.workflow.template.js", import.meta.url));
    const workflow = readFileSync(workflowPath, "utf8");
    const block = workflow.slice(workflow.indexOf("const IMPLEMENT_RESULT"));
    const properties = [...block.slice(0, block.indexOf("}\n")).matchAll(/(\w+): \{ type:/g)].map((match) => match[1]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(templatePath, "utf8"))).sort(), properties.sort());
});

test("test_implementPrompt_tellsTheImplementerToObeyTheSectionCodexNotes", () => {
    // recordPlanReview writes a required fix into each section's codexNotes; nothing else reads it.
    const prompt = implementPrompt(fakeTask, "", "npx tsc --noEmit", 3);
    assert.match(prompt, /codexNotes/);
});

test("test_implementPrompt_putsTheNoteInItsOwnSectionAndOmitsItWhenEmpty", () => {
    const sentinel = "SENTINEL_IMPLEMENT_NOTE_7cq2";
    const prompt = implementPrompt(fakeTask, sentinel, "npx tsc --noEmit", 3);
    assert.match(prompt, /## NOTE FOR THIS RUN\n\nSENTINEL_IMPLEMENT_NOTE_7cq2\n/);
    assert.equal(implementPrompt(fakeTask, "", "npx tsc --noEmit", 3).includes("NOTE FOR THIS RUN"), false);
});

test("test_implementPrompt_readFileListNamesAnOwnedTestFileOnlyOnce", () => {
    // An owned test file is also its own paired test, so the read-file list would otherwise repeat it.
    const owned = "/tmp/fake-worktree/tests/thing.test.ts";
    const task: PreparedTask = { ...fakeTask, ownedFilePaths: [owned], testFilePaths: [owned] };
    const readFileLine = implementPrompt(task, "", "npx tsc --noEmit", 3).split("\n").find((line) => line.startsWith("/read-file "));
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
    const note = "SENTINEL_NOTE_IMPL_d6";
    const typecheckCommand = "SENTINEL_TYPECHECK_IMPL_d7";
    const maxFixRounds = 918273;
    const prompt = implementPrompt(task, note, typecheckCommand, maxFixRounds);
    for (const sentinel of [String(task.number), task.briefFile, task.planFile, task.notesFile,
        task.files[0], task.repoRoot, note, typecheckCommand, String(maxFixRounds)]) {
        assert.ok(prompt.includes(sentinel), `prompt is missing ${sentinel}`);
    }
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/\b(TASK_WORKTREE|OWNED_PATHS|PLAN_FILE|NOTES_FILE|TESTS_FIELD|MAX_FIX_ROUNDS)\b/.test(prompt), false);
});
