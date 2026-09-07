// Phase 4 acceptance: the RevEng-shaped recursive graph is consolidated only after green evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmptyResolutionManifest } from "../scripts/shared/resolutionRequests.ts";
import { discoverRepositoryTree } from "../scripts/shared/repositoryDiscovery.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/shared/repositoryManifest.ts";
import { buildLogicalRepositories } from "../scripts/shared/logicalRepository.ts";
import { runMergePipeline, type CliInput } from "../scripts/shared/mergePipeline.ts";
import { archivePublishedTasks, type ArchiveRequest } from "../scripts/shared/taskArchival.ts";
import {
    REVENG_OCCURRENCE_IDS,
    REPEATED_OCCURRENCE_IDS,
    type RevengOccurrenceId,
    addRevengGroupWorktree,
    makeRevengGraphFixture,
    occurrenceChangeFile,
    occurrencePathInWorktree,
} from "./fixtures/revengGraph.ts";

const TASK_NUMBERS = [3601, 3602, 3603, 3604, 3605, 3606, 3607] as const;

type PipelineOutput = {
    conflicts: unknown[];
    runState: { readyForApproval: boolean };
    publicationTargets: { repositoryPath: string; recordedBaseOid: string; targetOid: string }[];
    abortReason: string | null;
    archiveRequest: ArchiveRequest | null;
};

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

async function invokePipeline(input: CliInput): Promise<PipelineOutput> {
    let output = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
    }) as typeof process.stdout.write;
    try {
        await runMergePipeline(input);
    } finally {
        process.stdout.write = originalWrite;
    }
    return JSON.parse(output) as PipelineOutput;
}

function writeTaskState(rootPath: string, taskFiles: string[]): void {
    const taskToolsPath = join(rootPath, ".taskTools");
    mkdirSync(taskToolsPath, { recursive: true });
    writeFileSync(join(taskToolsPath, "tasks.json"), JSON.stringify([
        ...taskFiles.map((file, index) => ({ taskNumber: TASK_NUMBERS[index], title: file, description: file, files: [file], difficulty: 1, blockedBy: [] })),
        { taskNumber: 3699, title: "unpublished", description: "unpublished", files: ["unpublished.txt"], difficulty: 1, blockedBy: [] },
    ]) + "\n");
    writeFileSync(join(taskToolsPath, "completedTasks.json"), "[]\n");
}

function allMainOids(occurrencePaths: Record<string, string>): Map<string, string> {
    return new Map(Object.entries(occurrencePaths).map(([id, path]) => [id, git(path, "rev-parse", "main")]));
}

function assertMainOids(occurrencePaths: Record<string, string>, expected: Map<string, string>): void {
    for (const [id, path] of Object.entries(occurrencePaths)) assert.equal(git(path, "rev-parse", "main"), expected.get(id), id);
}

test("test_revengGraphConsolidatesRepeatedOccurrencesOnlyAfterApproval", async () => {
    // Scenario: seven independently committed changes originate in every repeated occurrence of the RevEng graph.
    const fixture = makeRevengGraphFixture();
    const discovery = discoverRepositoryTree(fixture.rootPath, {
        repositoryManifest: { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] },
        resolutionManifest: createEmptyResolutionManifest(),
    }, "main");
    assert.equal(discovery.status, "resolved");
    if (discovery.status !== "resolved") return;
    const manifest: RepositoryManifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: discovery.graph };
    assert.deepEqual(manifest.occurrences.map((occurrence) => occurrence.occurrenceId), REVENG_OCCURRENCE_IDS);
    const logicalRepositories = buildLogicalRepositories(manifest.occurrences);
    assert.equal(logicalRepositories.length, 6);
    assert.deepEqual(logicalRepositories.map((repository) => repository.occurrenceIds.length).sort((left, right) => left - right), [1, 1, 1, 2, 2, 3]);

    const taskFiles: string[] = [];
    const groups = REPEATED_OCCURRENCE_IDS.map((occurrenceId, index) => {
        const taskNumber = TASK_NUMBERS[index];
        const worktree = addRevengGroupWorktree(fixture, taskNumber);
        const relativeChangeFile = occurrenceChangeFile(occurrenceId);
        const declaredFile = `${occurrenceId}/${relativeChangeFile}`;
        taskFiles.push(declaredFile);
        const sourcePath = occurrencePathInWorktree(worktree, occurrenceId);
        mkdirSync(join(sourcePath, "changes"), { recursive: true });
        writeFileSync(join(sourcePath, relativeChangeFile), `payload from ${occurrenceId}\n`);
        git(sourcePath, "add", relativeChangeFile);
        git(sourcePath, "commit", "-q", "-m", `change ${occurrenceId}`);
        return { groupId: taskNumber, worktree, branch: `task-group-${taskNumber}`, scope: "unknown" as const, tasks: [{ number: taskNumber, briefFile: "", planFile: "", files: [declaredFile], readOnlyFiles: ["*"] }] };
    });
    writeTaskState(fixture.rootPath, taskFiles);
    const basesBeforeApproval = allMainOids(fixture.occurrencePaths);

    // A red receipt must cause the real pipeline to return before finalization, push, publication, or archival.
    const redOutput = await invokePipeline({
        repo: fixture.rootPath,
        typecheckCommand: "sh verify.sh",
        groups,
        repositorySources: manifest.occurrences.map((occurrence) => ({ path: occurrence.occurrenceId, sourceBranch: occurrence.baseBranch })),
        repositoryManifest: manifest,
        runId: "reveng-red",
        testReceipts: [{ groupId: String(TASK_NUMBERS[0]), status: "red" }],
        reviewHandoffs: ["reveng review"],
    });
    assert.equal(redOutput.runState.readyForApproval, false);
    assert.deepEqual(redOutput.publicationTargets, []);
    assert.equal(redOutput.archiveRequest, null);
    assertMainOids(fixture.occurrencePaths, basesBeforeApproval);
    for (const path of Object.values(fixture.occurrencePaths)) assert.equal(git(path, "for-each-ref", "--format=%(refname)", "refs/finalize").includes("refs/finalize/"), false);
    for (const originPath of fixture.originPaths) assert.equal(git(originPath, "for-each-ref", "--format=%(refname)", "refs/heads/operations/reveng-red").trim(), "");
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.rootPath, ".taskTools", "tasks.json"), "utf8")).map((task: { taskNumber: number }) => task.taskNumber), [...TASK_NUMBERS, 3699]);
    assert.equal(JSON.parse(readFileSync(join(fixture.rootPath, ".taskTools", "completedTasks.json"), "utf8")).length, 0);

    // Execute the fixture's deterministic suite in every child and ancestor checkout of every real group worktree before minting green receipts.
    for (const group of groups) {
        for (const occurrenceId of REVENG_OCCURRENCE_IDS) execFileSync("sh", ["verify.sh"], { cwd: occurrencePathInWorktree(group.worktree, occurrenceId), encoding: "utf8" });
    }
    const greenReceipts = groups.map((group) => ({ groupId: String(group.groupId), status: "green" as const }));

    const greenOutput = await invokePipeline({
        repo: fixture.rootPath,
        typecheckCommand: "sh verify.sh",
        groups,
        repositorySources: manifest.occurrences.map((occurrence) => ({ path: occurrence.occurrenceId, sourceBranch: occurrence.baseBranch })),
        repositoryManifest: manifest,
        runId: "reveng-green",
        testReceipts: greenReceipts,
        reviewHandoffs: ["reveng review"],
    });
    assert.equal(greenOutput.runState.readyForApproval, true);
    assert.equal(greenOutput.abortReason, null);
    assert.equal(greenOutput.publicationTargets.length, 10);
    assert.ok(greenOutput.archiveRequest);
    assert.deepEqual(greenOutput.archiveRequest?.publishedTaskNumbers, [...TASK_NUMBERS]);

    // One prepared integration exists per logical repository, and each repeated source's independently named payload converges into all of its copies.
    const targetsByOid = new Map<string, string[]>();
    for (const target of greenOutput.publicationTargets) targetsByOid.set(target.targetOid, [...(targetsByOid.get(target.targetOid) ?? []), target.repositoryPath]);
    assert.equal(targetsByOid.size, 6);
    assert.deepEqual([...targetsByOid.values()].map((paths) => paths.length).sort((left, right) => left - right), [1, 1, 1, 2, 2, 3]);
    for (const occurrenceId of REPEATED_OCCURRENCE_IDS) {
        const payload = `payload from ${occurrenceId}`;
        const expectedFile = occurrenceChangeFile(occurrenceId);
        const sameSourceOccurrences = logicalRepositories.find((repository) => repository.occurrenceIds.includes(occurrenceId))!.occurrenceIds as RevengOccurrenceId[];
        for (const peerOccurrenceId of sameSourceOccurrences) assert.equal(git(fixture.occurrencePaths[peerOccurrenceId], "show", `main:${expectedFile}`), payload);
    }
    for (const occurrence of manifest.occurrences) {
        const occurrenceId = occurrence.occurrenceId as RevengOccurrenceId;
        const target = greenOutput.publicationTargets.find((candidate) => candidate.repositoryPath === occurrence.occurrenceId)!;
        assert.equal(git(fixture.occurrencePaths[occurrenceId], "rev-parse", "main"), target.targetOid);
        for (const childId of occurrence.childOccurrenceIds as RevengOccurrenceId[]) assert.equal(git(fixture.occurrencePaths[occurrenceId], "rev-parse", `main:${manifest.occurrences.find((candidate) => candidate.occurrenceId === childId)!.pathInParent}`), git(fixture.occurrencePaths[childId], "rev-parse", "main"));
    }

    const archiveResult = archivePublishedTasks(greenOutput.archiveRequest!.publishedTaskNumbers, greenOutput.archiveRequest!.mergeResults, fixture.rootPath);
    assert.deepEqual(archiveResult.archived, [...TASK_NUMBERS]);
    assert.deepEqual(archiveResult.leftOpen, []);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.rootPath, ".taskTools", "tasks.json"), "utf8")).map((task: { taskNumber: number }) => task.taskNumber), [3699]);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.rootPath, ".taskTools", "completedTasks.json"), "utf8")).map((task: { taskNumber: number }) => task.taskNumber).sort((left: number, right: number) => left - right), [...TASK_NUMBERS]);
});
