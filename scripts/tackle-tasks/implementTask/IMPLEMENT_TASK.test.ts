// Behavioral checks for scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMatchesTemplate } from "../../contracts.ts";
import { buildImplementPrompt, main } from "./IMPLEMENT_TASK.ts";
import type { PreparedTask } from "../shared/preparedTask.ts";

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

test("test_buildImplementPrompt_citesNoCommitInvocationAndNoDataBlock", () => {
    // The old prompt told the agent to run commitTaskWork.ts itself; COMMIT_IMPLEMENTATION_IF_NEEDED now owns that.
    const prompt = buildImplementPrompt(fakeTask, "npx tsc --noEmit", 3);
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/commitTaskWork\.ts/.test(prompt), false);
    assert.match(prompt, /Never stage, commit, or run any git command/);
});

test("test_buildImplementPrompt_tellsTheImplementerToObeyTheSectionCodexNotes", () => {
    const prompt = buildImplementPrompt(fakeTask, "npx tsc --noEmit", 3);
    assert.match(prompt, /codexNotes/);
});

test("test_buildImplementPrompt_takesTheNoteFromTheEntryAndOmitsTheSectionWhenItIsEmpty", () => {
    const sentinel = "SENTINEL_IMPLEMENT_NOTE_7cq2";
    const prompt = buildImplementPrompt({ ...fakeTask, codexReviewNotes: sentinel }, "npx tsc --noEmit", 3);
    assert.match(prompt, /## NOTE FOR THIS RUN\n\nSENTINEL_IMPLEMENT_NOTE_7cq2\n/);
    assert.equal(buildImplementPrompt(fakeTask, "npx tsc --noEmit", 3).includes("NOTE FOR THIS RUN"), false);
});

test("test_buildImplementPrompt_readFileListNamesAnOwnedTestFileOnlyOnce", () => {
    const owned = "/tmp/fake-worktree/tests/thing.test.ts";
    const task: PreparedTask = { ...fakeTask, ownedFilePaths: [owned], testFilePaths: [owned] };
    const readFileLine = buildImplementPrompt(task, "npx tsc --noEmit", 3).split("\n").find((line) => line.startsWith("/read-file "));
    assert.equal(readFileLine?.split(`"${owned}"`).length, 2);
});

test("test_buildImplementPrompt_tellsTheAgentToReturnMessageAndAdditionalData", () => {
    const prompt = buildImplementPrompt(fakeTask, "npx tsc --noEmit", 3);
    assert.match(prompt, /`message` and `additionalData`/);
    assert.match(prompt, /"implemented"/);
});

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

test("test_main_printsAPromptSignalAndMentionsTheTaskFromDisk", () => {
    const worktreePath = tmpMkdir("implement-task-");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-7.md"), "brief\n");
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 7, title: "widget", files: ["a.ts"] }]));

    const input = JSON.stringify({
        taskNumber: 7, projectRoot: worktreePath, worktree: worktreePath,
        typecheckCommand: "npx tsc --noEmit", maxFixRounds: 3,
    });
    const output = main(input);
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(output.box, "IMPLEMENT_TASK");
    const promptFileContents = readFileSync(join(worktreePath, "plans", "IMPLEMENT_TASK.prompt.md"), "utf8");
    assert.match(promptFileContents, /task 7/);
    assertMatchesTemplate("IMPLEMENT_TASK", { box: "", scriptSignal: "prompt", prompt: "" }, output);
});

test("test_main_defaultsMaxFixRoundsWhenTheSenderOmitsIt", () => {
    const worktreePath = tmpMkdir("implement-task-");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-8.md"), "brief\n");
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 8, title: "widget", files: ["a.ts"] }]));

    const input = JSON.stringify({ taskNumber: 8, projectRoot: worktreePath, worktree: worktreePath });
    main(input);
    const promptFileContents = readFileSync(join(worktreePath, "plans", "IMPLEMENT_TASK.prompt.md"), "utf8");
    assert.match(promptFileContents, /Stop after 3 rounds/);
});
