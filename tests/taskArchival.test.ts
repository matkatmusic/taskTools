// Behavioral checks for taskArchival.ts: only tasks explicitly listed as published, and cross-checked as fullyPublished, move from tasks.json to completedTasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    archivePublishedTasks,
    summarizeTaskMergeResults,
    type RawTaskRepoOutcome,
} from "../scripts/taskArchival.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-archival-"));
    writeFileSync(
        join(root, "tasks.json"),
        JSON.stringify([
            { taskNumber: 1, title: "partial rollback" },
            { taskNumber: 2, title: "fully published" },
            { taskNumber: 3, title: "conflicted" },
            { taskNumber: 4, title: "skipped" },
            { taskNumber: 5, title: "not in explicit list" },
        ]),
    );
    writeFileSync(join(root, "completedTasks.json"), "[]");
    return root;
}

function readTasks(root: string): any[] {
    return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
    return JSON.parse(readFileSync(join(root, "completedTasks.json"), "utf8"));
}

test("partial-repo rollback keeps the touching task open, archives the clean one", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 1, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
        { taskNumber: 1, repo: { repoName: "r2", status: "rolled-back" } },
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "bbb" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived, leftOpen } = archivePublishedTasks([1, 2], mergeResults, root);

    assert.deepEqual(archived, [2]);
    assert.equal(leftOpen.includes(1), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 1), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 2), false);
    const completedTwo = readCompleted(root).find((t) => t.taskNumber === 2);
    assert.deepEqual(completedTwo.commitHashes, ["bbb"]);
});

test("conflicted or skipped repos keep the task open and out of completedTasks.json", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 3, repo: { repoName: "r1", status: "conflicted" } },
        { taskNumber: 4, repo: { repoName: "r1", status: "skipped" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived } = archivePublishedTasks([3, 4], mergeResults, root);

    assert.deepEqual(archived, []);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 3), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 4), true);
    assert.equal(readCompleted(root).length, 0);
});

test("a fully-published task not named in the explicit list stays open", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 5, repo: { repoName: "r1", status: "published", commitHash: "ccc" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived, leftOpen } = archivePublishedTasks([], mergeResults, root);

    assert.deepEqual(archived, []);
    assert.equal(leftOpen.includes(5), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 5), true);
    assert.equal(readCompleted(root).length, 0);
});

test("does not import or call any approval/confirmation code path", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "scripts", "taskArchival.ts"), "utf8");
    const importLines = source.split("\n").filter((line) => line.trim().startsWith("import"));
    assert.equal(importLines.some((line) => /approvalGate|approvalReadiness/.test(line)), false);
    assert.equal(/recordApproval\(|issueApprovalAuthorization\(/.test(source), false);
});

test("commit hashes from every published repo land in completedTasks.json", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "hash1" } },
        { taskNumber: 2, repo: { repoName: "r2", status: "published", commitHash: "hash2" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    archivePublishedTasks([2], mergeResults, root);

    const completedTwo = readCompleted(root).find((t) => t.taskNumber === 2);
    assert.deepEqual(completedTwo.commitHashes, ["hash1", "hash2"]);
});

test("a task with zero repos in its merge result is not fullyPublished", () => {
    const results = summarizeTaskMergeResults([]);
    assert.deepEqual(results, []);
});

test("an explicitly listed task missing from mergeResults is left open, not thrown", () => {
    const root = makeProjectRoot();
    assert.doesNotThrow(() => archivePublishedTasks([1], [], root));
    const { archived, leftOpen } = archivePublishedTasks([1], [], root);
    assert.deepEqual(archived, []);
    assert.equal(leftOpen.includes(1), true);
});

test("duplicate task numbers in publishedTaskNumbers archive the task once", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived } = archivePublishedTasks([2, 2, 2], mergeResults, root);

    assert.deepEqual(archived, [2]);
    assert.equal(readCompleted(root).filter((t) => t.taskNumber === 2).length, 1);
});
