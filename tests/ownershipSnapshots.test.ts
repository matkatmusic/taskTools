// Behavioral checks for ownershipSnapshots.ts: snapshot diffing, occurrence attribution, ownership checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    attributeOccurrence,
    checkGroupBoundary,
    checkOwnership,
    diffSnapshots,
    takeSnapshot,
} from "../scripts/ownershipSnapshots.ts";
import type { Change } from "../scripts/ownershipSnapshots.ts";
import type { OwnershipEffects } from "../scripts/ownershipKeys.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeRepoWithCommit(prefix = "ownership-snapshots-"): string {
    const repoPath = mkdtempSync(join(tmpdir(), prefix));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function findChange(changes: Change[], path: string): Change {
    const found = changes.find((change) => change.path === path);
    if (!found) throw new Error(`no change for "${path}"`);
    return found;
}

function effectsFor(...absolutePaths: string[]): OwnershipEffects[] {
    return [
        {
            key: { canonicalOccurrenceId: "test", pathWithinRepo: "" },
            occurrencePaths: absolutePaths,
            ancestorGitlinks: [],
        },
    ];
}

test("edit outside declared ownership is reported, with zero commits made", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    writeFileSync(join(repoPath, "seed.txt"), "edited\n");
    const after = takeSnapshot(repoPath);
    assert.equal(git(repoPath, "log", "--oneline").split("\n").length, 1);

    const changes = diffSnapshots(repoPath, before, after);
    const violations = checkOwnership("worker-a", changes, effectsFor(join(repoPath, "other.txt")));
    assert.equal(violations.length, 1);
    assert.deepEqual(violations[0], {
        occurrenceId: repoPath,
        path: "seed.txt",
        type: "modified",
        reason: "out-of-ownership",
    });
});

test("edit inside declared ownership produces no violation", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    writeFileSync(join(repoPath, "seed.txt"), "edited\n");
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    const violations = checkOwnership("worker-a", changes, effectsFor(join(repoPath, "seed.txt")));
    assert.deepEqual(violations, []);
});

test("deletion is attributed as deleted", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    execFileSync("rm", [join(repoPath, "seed.txt")]);
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    assert.equal(findChange(changes, "seed.txt").type, "deleted");
});

test("rename is attributed with correct from/to paths", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    execFileSync("mv", [join(repoPath, "seed.txt"), join(repoPath, "renamed.txt")]);
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    const rename = findChange(changes, "renamed.txt");
    assert.equal(rename.type, "renamed");
    assert.equal(rename.fromPath, "seed.txt");
});

test("mode change (chmod +x) is attributed as mode-changed", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    chmodSync(join(repoPath, "seed.txt"), 0o755);
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    assert.equal(findChange(changes, "seed.txt").type, "mode-changed");
});

test("symlink change (file replaced by symlink) is attributed as symlink-changed", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    execFileSync("rm", [join(repoPath, "seed.txt")]);
    symlinkSync("/nonexistent-target", join(repoPath, "seed.txt"));
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    assert.equal(findChange(changes, "seed.txt").type, "symlink-changed");
});

test("nested occurrence: change is attributed to the deepest containing occurrence root", () => {
    const repoPath = makeRepoWithCommit();
    mkdirSync(join(repoPath, "nested"));
    writeFileSync(join(repoPath, "nested", "b.txt"), "seed\n");
    git(repoPath, "add", "nested/b.txt");
    git(repoPath, "commit", "-q", "-m", "add nested occurrence file");

    const before = takeSnapshot(repoPath);
    writeFileSync(join(repoPath, "nested", "b.txt"), "edited\n");
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    const change = findChange(changes, "nested/b.txt");

    const nestedRoot = join(repoPath, "nested");
    const attributed = attributeOccurrence(change, [repoPath, nestedRoot]);
    assert.equal(attributed.occurrenceRoot, nestedRoot);
    assert.equal(attributed.path, "b.txt");
});

test("group boundary rejects a change matching no worker's declared ownership", () => {
    const repoPath = makeRepoWithCommit();
    const before = takeSnapshot(repoPath);
    writeFileSync(join(repoPath, "seed.txt"), "edited\n");
    const after = takeSnapshot(repoPath);

    const changes = diffSnapshots(repoPath, before, after);
    const workerAEffects = effectsFor(join(repoPath, "unrelated-a.txt"));
    const workerBEffects = effectsFor(join(repoPath, "unrelated-b.txt"));

    const groupViolations = checkGroupBoundary(changes, [workerAEffects, workerBEffects]);
    assert.equal(groupViolations.length, 1);
    assert.equal(groupViolations[0].path, "seed.txt");
});
