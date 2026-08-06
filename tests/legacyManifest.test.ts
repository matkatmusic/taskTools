// Behavioral checks for legacyManifest.ts: refusal of pre-version manifests, non-destructive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLegacyManifest } from "../scripts/legacyManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

test("test_versionlessManifestIsRejected", () => {
    const result = checkLegacyManifest({ occurrences: [] });
    assert.equal(result.ok, false);
    assert.equal((result as { detectedVersion: number | undefined }).detectedVersion, undefined);
});

test("test_olderVersionManifestIsRejected", () => {
    const olderVersion = REPOSITORY_MANIFEST_VERSION - 1;
    const result = checkLegacyManifest({ version: olderVersion, occurrences: [] });
    assert.equal(result.ok, false);
    assert.equal((result as { detectedVersion: number | undefined }).detectedVersion, olderVersion);
});

test("test_rejectionResultNamesRecoveryCommands", () => {
    const result = checkLegacyManifest({ occurrences: [] });
    assert.equal(result.ok, false);
    const recoveryCommands = (result as { recoveryCommands: string[] }).recoveryCommands;
    assert.ok(recoveryCommands.length > 0);
    for (const command of recoveryCommands) {
        assert.equal(typeof command, "string");
        assert.ok(command.trim().length > 0);
    }
});

test("test_refusalDoesNotDeleteWorktreeOrBranch", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "legacy-manifest-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    git(repoRoot, "commit", "-q", "--allow-empty", "-m", "seed");
    const worktreePath = join(repoRoot, "worktree-1");
    git(repoRoot, "worktree", "add", "-q", "-b", "task-group-1", worktreePath);

    const legacyManifest = {
        repositories: [{ checkoutPath: worktreePath, operationBranch: "task-group-1" }],
    };
    const result = checkLegacyManifest(legacyManifest);

    assert.equal(result.ok, false);
    assert.equal(existsSync(worktreePath), true);
    const branches = git(repoRoot, "branch", "--list", "task-group-1");
    assert.ok(branches.includes("task-group-1"));
});

test("test_cliRefusalNamesAffectedWorktreeAndSurvivesOnDisk", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "legacy-manifest-cli-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    git(repoRoot, "commit", "-q", "--allow-empty", "-m", "seed");
    const worktreePath = join(repoRoot, "worktree-1");
    git(repoRoot, "worktree", "add", "-q", "-b", "task-group-1", worktreePath);

    const manifestPath = join(repoRoot, "manifest.json");
    writeFileSync(
        manifestPath,
        JSON.stringify({ repositories: [{ checkoutPath: worktreePath, operationBranch: "task-group-1" }] }),
    );

    const scriptPath = join(process.cwd(), "scripts", "mergeTaskWorktrees.ts");
    const result = spawnSync("bun", [scriptPath, "--run", manifestPath], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(worktreePath));
    assert.equal(existsSync(worktreePath), true);
    const branches = git(repoRoot, "branch", "--list", "task-group-1");
    assert.ok(branches.includes("task-group-1"));
    const worktrees = git(repoRoot, "worktree", "list");
    assert.ok(worktrees.includes(worktreePath));
});

test("test_currentVersionManifestPassesThroughUnchanged", () => {
    const manifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] };
    const clone = structuredClone(manifest);

    const result = checkLegacyManifest(manifest);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(manifest, clone);
});
