// Integration coverage for prepareTasks against a real, on-disk git repository with a real submodule.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapRepositoryManifest } from "../scripts/manifestBootstrap.ts";
import { getOwningOccurrence } from "../scripts/repositoryGraph.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";
import { groupTasksByFileOverlap } from "../scripts/taskGroups.ts";
import { buildWorkflowArguments } from "../scripts/prepareTasks.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";

function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}

const rootPath = mkdtempSync(join(tmpdir(), "prepareTasksIntegration-"));
const submoduleSourcePath = mkdtempSync(join(tmpdir(), "prepareTasksIntegrationSubmoduleSource-"));

git(rootPath, ["init", "-q", "-b", "main"]);
git(rootPath, ["config", "user.email", "test@example.com"]);
git(rootPath, ["config", "user.name", "Test"]);
execFileSync("mkdir", ["-p", join(rootPath, "scripts")]);
execFileSync("bash", ["-c", `echo 'export const foo = 1;' > "${join(rootPath, "scripts", "foo.ts")}"`]);
git(rootPath, ["add", "scripts/foo.ts"]);
git(rootPath, ["commit", "-q", "-m", "add foo"]);
git(rootPath, ["remote", "add", "origin", "https://example.com/root.git"]);
git(rootPath, ["config", "protocol.file.allow", "always"]);

git(submoduleSourcePath, ["init", "-q", "-b", "main"]);
git(submoduleSourcePath, ["config", "user.email", "test@example.com"]);
git(submoduleSourcePath, ["config", "user.name", "Test"]);
execFileSync("mkdir", ["-p", join(submoduleSourcePath, "src")]);
execFileSync("bash", ["-c", `echo 'export const bar = 1;' > "${join(submoduleSourcePath, "src", "bar.ts")}"`]);
git(submoduleSourcePath, ["add", "src/bar.ts"]);
git(submoduleSourcePath, ["commit", "-q", "-m", "add bar"]);

git(rootPath, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSourcePath, "external/sub"]);
git(rootPath, ["commit", "-q", "-m", "add submodule"]);

const bootstrapResult = bootstrapRepositoryManifest(rootPath);
assert.equal(bootstrapResult.refused, false, "bootstrap must resolve without needing manual input");
const occurrenceGraph: RepositoryOccurrence[] = bootstrapResult.refused ? [] : bootstrapResult.occurrenceGraph;
const manifest: RepositoryManifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: occurrenceGraph };

after(() => {
    rmSync(rootPath, { recursive: true, force: true });
    rmSync(submoduleSourcePath, { recursive: true, force: true });
});

test("test_ownershipResolvesForARootFilePath", () => {
    const owner = getOwningOccurrence("scripts/foo.ts", manifest);
    assert.ok(owner);
    assert.equal(owner!.parentOccurrenceId, null);
});

test("test_ownershipResolvesForASubmoduleFilePath", () => {
    const root = manifest.occurrences.find((occurrence) => occurrence.parentOccurrenceId === null);
    assert.ok(root);
    const owner = getOwningOccurrence("external/sub/src/bar.ts", manifest);
    assert.ok(owner);
    assert.equal(owner!.parentOccurrenceId, root!.occurrenceId);
});

test("test_everyOccurrenceHasANonEmptyOriginUrl", () => {
    for (const occurrence of manifest.occurrences) {
        assert.notEqual(occurrence.originUrl, "");
    }
});

test("test_everyOccurrenceHasANonEmptyOccurrenceId", () => {
    for (const occurrence of manifest.occurrences) {
        assert.notEqual(occurrence.occurrenceId, "");
    }
});

test("test_groupTasksByFileOverlapReturnsRealGroupsInsteadOfThrowing", () => {
    const tasks: TaskRecord[] = [
        { taskNumber: 1, files: ["scripts/foo.ts"] },
        { taskNumber: 2, files: ["external/sub/src/bar.ts"] },
    ];
    const groups = groupTasksByFileOverlap(tasks);
    assert.ok(groups.length > 0);

    // buildWorkflowArguments runs `git submodule update` in a fresh worktree; the submodule's origin is a local file path in this test, which git blocks by default unless allow-listed.
    process.env.GIT_ALLOW_PROTOCOL = "file:https:ssh:git:http";
    const workflowArguments = buildWorkflowArguments(rootPath, "npx tsc --noEmit", groups);
    assert.ok(workflowArguments.groups.length > 0);
});
