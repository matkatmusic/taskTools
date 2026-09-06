// Behavioral checks for AMEND_ENTRY_WITH_CODEX_NOTES.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./AMEND_ENTRY_WITH_CODEX_NOTES.ts";
import { claimTask, getAttemptCount } from "../shared/taskRunState.ts";
import { writeCheckpoint, type Checkpoint } from "../shared/checkpoint.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "amend-codex-notes-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
        { taskNumber: 99, files: ["src/thing.ts"], codexReviewNotes: "" },
    ]));
    const outcome = claimTask(99, "run-1", root);
    assert.equal(outcome.status, "claimed");
    const checkpoint: Checkpoint = {
        taskNumber: 99, passId: "pass-0", runId: "run-1", projectRoot: root,
        block: "pipeline-areTestsFlagged.mmd::AMEND_ENTRY_WITH_CODEX_NOTES", input: "{}",
        state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    };
    writeCheckpoint(join(root, "worktree"), checkpoint);
    return root;
}

function packetFor(projectRoot: string, notes: string) {
    return {
        box: "ARE_2_TEST_REVIEWS_DONE_Q", scriptSignal: "continue", next: "AMEND_ENTRY_WITH_CODEX_NOTES",
        taskNumber: 99, runId: "run-1", projectRoot, worktree: `${projectRoot}/worktree`, branch: "main",
        exitType: "", exitNote: "", flagged: true, notes,
    };
}

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

test("test_main_writesTheReviewerNotesIntoTheTaskEntry", () => {
    const projectRoot = makeProjectRoot();
    const output = main(JSON.stringify(packetFor(projectRoot, "SENTINEL_PROBLEM\n\nFix: SENTINEL_FIX")));
    assert.equal(output.box, "AMEND_ENTRY_WITH_CODEX_NOTES");
    assert.equal(output.next, undefined);
    assert.match(entryOf(projectRoot).codexReviewNotes, /SENTINEL_PROBLEM/);
    assert.match(entryOf(projectRoot).codexReviewNotes, /SENTINEL_FIX/);
});

test("test_main_raisesTheTestReviewsCounter", () => {
    const projectRoot = makeProjectRoot();
    main(JSON.stringify(packetFor(projectRoot, "x")));
    assert.equal(getAttemptCount(99, "testReviews", projectRoot), 1);
});

test("test_main_throwsWhenThereAreNoNotesToWrite", () => {
    const projectRoot = makeProjectRoot();
    assert.throws(() => main(JSON.stringify(packetFor(projectRoot, ""))), /no reviewer notes to write/);
});

test("test_main_dropsFlaggedAndNotesFromTheOutput", () => {
    const projectRoot = makeProjectRoot();
    const output = main(JSON.stringify(packetFor(projectRoot, "x")));
    assert.equal("flagged" in output, false);
    assert.equal("notes" in output, false);
});

test("test_AMEND_ENTRY_WITH_CODEX_NOTES_runsTwiceWithTheSameInput", () => {
    const projectRoot = makeProjectRoot();
    const input = packetFor(projectRoot, "SENTINEL_PROBLEM\n\nFix: SENTINEL_FIX");

    const firstOutput = main(JSON.stringify(input));
    const firstEntry = entryOf(projectRoot);
    const secondOutput = main(JSON.stringify(input));
    const secondEntry = entryOf(projectRoot);

    assert.deepEqual(secondOutput, firstOutput);
    assert.deepEqual(secondEntry, firstEntry);
    assert.equal(getAttemptCount(99, "testReviews", projectRoot), 1);
});
