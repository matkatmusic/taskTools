// Behavioral checks for scripts/tackle-tasks/shared/resumedRunSection.ts. Run: node --test tests/resumedRunSection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumedRunSection } from "./resumedRunSection.ts";
import { writeCheckpoint, type Checkpoint } from "./checkpoint.ts";

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function baseCheckpoint(resumedFrom: Checkpoint["resumedFrom"]): Checkpoint {
    return {
        taskNumber: 1, passId: "pass-1", runId: "run-1", projectRoot: "/root",
        block: "diagram.mmd::BOX", input: "{}", state: "running",
        sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom,
    };
}

test("test_resumedRunSection_isEmptyWithoutACheckpoint", () => {
    const repoRoot = tmpMkdir("resumed-run-section-");
    assert.equal(resumedRunSection(repoRoot), "");
});

test("test_resumedRunSection_isEmptyWhenTheRunWasNeverResumed", () => {
    const repoRoot = tmpMkdir("resumed-run-section-");
    writeCheckpoint(repoRoot, baseCheckpoint(null));
    assert.equal(resumedRunSection(repoRoot), "");
});

test("test_resumedRunSection_namesTheBlockAndExitOfTheStoppedRun", () => {
    const repoRoot = tmpMkdir("resumed-run-section-");
    writeCheckpoint(repoRoot, baseCheckpoint({ block: "diagram.mmd::OLD_BOX", exitType: "tests-red", exitNote: "two tests failed" }));
    const section = resumedRunSection(repoRoot);
    assert.equal(section, `## RESUMED RUN

You are working in a resumed task worktree.
The previous run stopped at \`diagram.mmd::OLD_BOX\` with exit type "tests-red": two tests failed
The worktree already holds work from that run, and its commits are on the task branch.
Read the current state of every file you own before you change anything.
Do not redo work that is already done.`);
});

test("test_resumedRunSection_namesOnlyTheBlockAfterAKill", () => {
    const repoRoot = tmpMkdir("resumed-run-section-");
    writeCheckpoint(repoRoot, baseCheckpoint({ block: "diagram.mmd::OLD_BOX", exitType: "", exitNote: "" }));
    const section = resumedRunSection(repoRoot);
    assert.equal(section, `## RESUMED RUN

You are working in a resumed task worktree.
The previous run was stopped at \`diagram.mmd::OLD_BOX\`.
The worktree already holds work from that run, and its commits are on the task branch.
Read the current state of every file you own before you change anything.
Do not redo work that is already done.`);
});
