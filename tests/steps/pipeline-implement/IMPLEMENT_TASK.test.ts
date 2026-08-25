// Behavioral checks for scripts/steps/pipeline-implement/IMPLEMENT_TASK.ts. Run: node --test tests/steps/pipeline-implement/IMPLEMENT_TASK.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMatchesTemplate } from "../../../scripts/contracts.ts";
import { buildImplementPrompt, main } from "../../../scripts/steps/pipeline-implement/IMPLEMENT_TASK.ts";
import type { PreparedTask } from "../../../scripts/tackle-tasks/preparedTask.ts";

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

function git(repoPath: string, ...args: string[]): void {
    execFileSync("git", ["-C", repoPath, ...args], { stdio: "ignore" });
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

test("test_main_printsAPromptSignalAndMentionsTheTaskFromDisk", () => {
    const worktreePath = tmpMkdir("implement-task-");
    git(worktreePath, "init", "-q");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-7.md"), "brief\n");
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 7, title: "widget", files: ["a.ts"] }]));

    const input = JSON.stringify({
        taskNumber: 7, projectRoot: worktreePath, worktreePath, runId: "run-1",
        sourceBranch: "main", typecheckCommand: "npx tsc --noEmit", maxFixRounds: 3,
    });
    const output = main(input);
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(output.box, "IMPLEMENT_TASK");
    assert.match(output.prompt as string, /task 7/);
    assertMatchesTemplate("IMPLEMENT_TASK", { box: "", scriptSignal: "prompt", prompt: "" }, output);
});
