// Behavioral checks for scripts/tackle-tasks/implementTask/IMPLEMENT_TASK.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMatchesTemplate } from "../../shared/contracts.ts";
import { buildImplementPrompt, buildImplementPromptSkeleton, main } from "./IMPLEMENT_TASK.ts";
import type { PreparedTask } from "../shared/preparedTask.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "implement-task-run-log.json");

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

test("test_buildImplementPrompt_citesNoCommitInvocationAndNoDataBlock", () => {
    // The old prompt told the agent to run commitTaskWork.ts itself; COMMIT_IMPLEMENTATION_IF_NEEDED now owns that.
    const prompt = buildImplementPrompt(fakeTask, "npx tsc --noEmit", 3);
    assert.equal(prompt.includes("---- DATA ----"), false);
    assert.equal(/commitTaskWork\.ts/.test(prompt), false);
    // task 51: the git prohibition is retired prose; the fenced agent's disallowedTools denies Bash(git *) instead.
    assert.equal(/Never stage, commit, or run any git command/.test(prompt), false);
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
    const task: PreparedTask = { ...fakeTask, ownedFilePaths: [owned], readFilePaths: [owned], testFilePaths: [owned] };
    const readFileLine = buildImplementPrompt(task, "npx tsc --noEmit", 3).split("\n").find((line) => line.startsWith("/read-file "));
    assert.equal(readFileLine?.split(`"${owned}"`).length, 2);
});

test("test_buildImplementPrompt_tellsTheAgentToReturnMessageAndAdditionalData", () => {
    const prompt = buildImplementPrompt(fakeTask, "npx tsc --noEmit", 3);
    assert.match(prompt, /"message": "", "additionalData": \{ "implemented": </);
    assert.match(prompt, /"implemented"/);
});

test("test_buildImplementPromptSkeleton_holdsOnlyTheSectionsTheChoicesTurnOn", () => {
    const skeleton = buildImplementPromptSkeleton({ hasCodexNotes: true, testsField: "skip" });
    for (const header of ["## NOTE FOR THIS RUN", "## YOUR JOB", "## BEFORE YOU IMPLEMENT", "## WHAT TO READ", "## OBEY THE REVIEW NOTES", "## WHAT YOU MAY EDIT", "## DO NOT CREATE TESTS", "## HOW TO IMPLEMENT", "## FORBIDDEN ACTIONS", "`${whatToReturnSection(...)}`"]) {
        assert.ok(skeleton.includes(header), `missing "${header}"`);
    }
    assert.equal(skeleton.includes("## TESTS\n"), false);
});

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

test("test_main_printsAPromptSignalAndMentionsTheTaskFromDisk", () => {
    const worktreePath = tmpMkdir("implement-task-");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-7.md"), "brief\n");
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 7, title: "widget", modifiableFiles: ["a.ts"], createsFiles: ["a.ts"] }]));

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

test("test_implementTaskPrompt_carriesTheResumedRunNotice", () => {
    const worktreePath = tmpMkdir("implement-task-");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-9.md"), "brief\n");
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 9, title: "widget", modifiableFiles: ["a.ts"], createsFiles: ["a.ts"] }]));
    writeFileSync(join(worktreePath, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber: 9, passId: "pass-1", runId: "run-1", projectRoot: worktreePath,
        block: "diagram.mmd::OLD_BOX", input: "{}", state: "running",
        sourceLockHeld: false, exitType: "tests-red", exitNote: "n",
        resumedFrom: { block: "diagram.mmd::OLD_BOX", exitType: "tests-red", exitNote: "n" },
    }));

    const input = JSON.stringify({
        taskNumber: 9, projectRoot: worktreePath, worktree: worktreePath,
        typecheckCommand: "npx tsc --noEmit", maxFixRounds: 3,
    });
    main(input);
    const promptFileContents = readFileSync(join(worktreePath, "plans", "IMPLEMENT_TASK.prompt.md"), "utf8");
    assert.match(promptFileContents, /## RESUMED RUN/);
});

test("test_IMPLEMENT_TASK_runsTwiceWithTheSameInput", () => {
    const worktreePath = tmpMkdir("implement-task-");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-11.md"), "brief\n");
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 11, title: "widget", modifiableFiles: ["a.ts"], createsFiles: ["a.ts"] }]));

    const input = JSON.stringify({
        taskNumber: 11, projectRoot: worktreePath, worktree: worktreePath,
        typecheckCommand: "npx tsc --noEmit", maxFixRounds: 3,
    });
    const firstOutput = main(input);
    const firstPrompt = readFileSync(join(worktreePath, "plans", "IMPLEMENT_TASK.prompt.md"), "utf8");
    const secondOutput = main(input);
    const secondPrompt = readFileSync(join(worktreePath, "plans", "IMPLEMENT_TASK.prompt.md"), "utf8");

    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(secondPrompt, firstPrompt);
});

test("test_main_defaultsMaxFixRoundsWhenTheSenderOmitsIt", () => {
    const worktreePath = tmpMkdir("implement-task-");
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "brief-8.md"), "brief\n");
    // The fix-round cap renders only for a task with tests; a no-tests task has no test loop to cap.
    writeFileSync(join(worktreePath, "tasks.json"), JSON.stringify([{ taskNumber: 8, title: "widget", modifiableFiles: ["a.ts"], createsFiles: ["a.ts"], schemaVersion: "1.0.1", hasTests: true }]));

    const input = JSON.stringify({ taskNumber: 8, projectRoot: worktreePath, worktree: worktreePath });
    main(input);
    const promptFileContents = readFileSync(join(worktreePath, "plans", "IMPLEMENT_TASK.prompt.md"), "utf8");
    assert.match(promptFileContents, /Stop after 3 rounds/);
});
