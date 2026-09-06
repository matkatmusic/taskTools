// mutating: runs only against temp files, never real state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./WRITE_CLARIFY_REQUEST.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";
import { writeCheckpoint, type Checkpoint } from "../shared/checkpoint.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "WRITE_CLARIFY_REQUEST.template.json");

// A temp project root holding one open task with an active run, which is all this box needs.
function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "write-clarify-request-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, files: ["src/owned.ts"], codexReviewNotes: "",
        run: {
            active: true,
            worktree: "/tmp/fake-worktree",
            leaseRunId: "run-1",
            history: [{
                runId: "run-1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    return root;
}

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

const worktreeOf = (projectRoot: string) => join(projectRoot, "worktree");

const packet = (projectRoot: string, clarifyRequest: string) => JSON.stringify({
    taskNumber: 35, runId: "run-1", worktree: worktreeOf(projectRoot), branch: "task-35", projectRoot,
    docsMode: "", planFile: "", exitType: "", exitNote: "", outcome: "CLARIFY", clarifyRequest,
});

function seedCheckpoint(worktree: string, passId: string): void {
    const checkpoint: Checkpoint = {
        taskNumber: 35, passId, runId: "run-1", projectRoot: worktree,
        block: "pipeline-plan.mmd::WHAT_DID_THE_PLANNER_RETURN", input: "{}",
        state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    };
    writeCheckpoint(worktree, checkpoint);
}

test("test_WRITE_CLARIFY_REQUEST_writesTheRequestWhereTheNextPlannerReadsIt", () => {
    const root = makeProjectRoot();
    seedCheckpoint(worktreeOf(root), "pass-0");

    const output = main(packet(root, "SENTINEL_WHICH_DATABASE"));

    assert.equal(output.box, "WRITE_CLARIFY_REQUEST");
    assert.equal(entryOf(root).clarifyRequest, "SENTINEL_WHICH_DATABASE");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_WRITE_CLARIFY_REQUEST_raisesTheClarifyAttemptCounter", () => {
    const root = makeProjectRoot();
    seedCheckpoint(worktreeOf(root), "pass-0");

    main(packet(root, "SENTINEL_WHICH_DATABASE"));

    assert.equal(entryOf(root).run.history[0].attempts.clarify, 1);
});

test("test_WRITE_CLARIFY_REQUEST_setsDocsModeToUpdate", () => {
    const root = makeProjectRoot();
    seedCheckpoint(worktreeOf(root), "pass-0");

    const output = main(packet(root, "SENTINEL_WHICH_DATABASE"));

    assert.equal(output.docsMode, "UPDATE");
    assert.equal(output.planFile, "");
});

test("test_WRITE_CLARIFY_REQUEST_leavesTheCodexReviewNotesChannelAlone", () => {
    const root = makeProjectRoot();
    seedCheckpoint(worktreeOf(root), "pass-0");

    main(packet(root, "SENTINEL_WHICH_DATABASE"));

    assert.equal(entryOf(root).codexReviewNotes, "");
});

test("test_WRITE_CLARIFY_REQUEST_throwsOnAnEmptyRequest", () => {
    assert.throws(() => main(packet(makeProjectRoot(), "   ")), /sent an empty request/);
});

test("test_WRITE_CLARIFY_REQUEST_throwsWhenTheTaskIsNotInTasksJson", () => {
    const root = makeProjectRoot();
    const badPacket = JSON.stringify({
        taskNumber: 999, runId: "run-1", worktree: worktreeOf(root), branch: "task-35", projectRoot: root,
        docsMode: "", planFile: "", exitType: "", exitNote: "", outcome: "CLARIFY", clarifyRequest: "anything",
    });
    assert.throws(() => main(badPacket), /task 999 not found/);
});

test("test_WRITE_CLARIFY_REQUEST_countsOnceWhenRunTwiceWithTheSameCheckpoint", () => {
    const root = makeProjectRoot();
    seedCheckpoint(worktreeOf(root), "pass-1");

    main(packet(root, "SENTINEL_WHICH_DATABASE"));
    main(packet(root, "SENTINEL_WHICH_DATABASE"));

    assert.equal(entryOf(root).run.history[0].attempts.clarify, 1);
});

test("test_WRITE_CLARIFY_REQUEST_throwsWithoutACheckpoint", () => {
    const root = makeProjectRoot();
    assert.throws(() => main(packet(root, "SENTINEL_WHICH_DATABASE")), /no checkpoint/);
});
