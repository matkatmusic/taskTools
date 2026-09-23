// Q_PREVIOUS_RUN_LEFT_NOTES passes the notes file path on YES and an empty path on NO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./PREVIOUS_RUN_LEFT_NOTES.ts";
import { claimTask, endTaskRun, updateCurrentTaskRun } from "../shared/taskRunState.ts";

// An ended run-old on a recorded worktree, then an active run-new.
function makeResumedTask(notesFile: string | null): { root: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), "PREVIOUS_RUN_LEFT_NOTES-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify([{ taskNumber: 1, title: "t1", files: [] }], null, 2)}\n`);
    const worktree = mkdtempSync(join(tmpdir(), "PREVIOUS_RUN_LEFT_NOTES-worktree-"));
    claimTask(1, "run-old", root);
    updateCurrentTaskRun(1, "run-old", { worktree, leaseRunId: "run-old" }, root);
    if (notesFile !== null) {
        writeFileSync(join(worktree, notesFile), "stopped here\n");
        updateCurrentTaskRun(1, "run-old", { implementationNotesFile: notesFile }, root);
    }
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);
    return { root, worktree };
}

function packet(worktree: string, projectRoot: string): string {
    return JSON.stringify({
        box: "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE", scriptSignal: "continue", taskNumber: 1, runId: "run-new", projectRoot,
        worktree, branch: "task-1", docsMode: "", planFile: "", exitType: "", exitNote: "",
        next: "Q_PREVIOUS_RUN_LEFT_NOTES",
    });
}

test("test_Q_PREVIOUS_RUN_LEFT_NOTES_passesTheNotesFilePathOnYes", () => {
    const { root, worktree } = makeResumedTask("notes.md");

    const output = main(packet(worktree, root));

    assert.equal(output.box, "Q_PREVIOUS_RUN_LEFT_NOTES");
    assert.equal(output.next, "Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING");
    assert.equal(output.implementationNotesFile, "notes.md");
});

test("test_Q_PREVIOUS_RUN_LEFT_NOTES_passesAnEmptyPathOnNo", () => {
    const { root, worktree } = makeResumedTask(null);

    const output = main(packet(worktree, root));

    assert.equal(output.box, "Q_PREVIOUS_RUN_LEFT_NOTES");
    assert.equal(output.next, "Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING");
    assert.equal(output.implementationNotesFile, "");
});
