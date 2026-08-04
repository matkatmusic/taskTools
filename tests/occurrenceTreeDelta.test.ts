// Behavioral checks for occurrenceTreeDelta.ts: tracked/untracked change classification + tree digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeOccurrenceTreeDelta, computeTreeDelta, computeTreeDigest } from "../scripts/occurrenceTreeDelta.ts";
import type { TreeChange } from "../scripts/occurrenceTreeDelta.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeRepoWithCommit(): { repoPath: string; baseRef: string } {
    const repoPath = mkdtempSync(join(tmpdir(), "occurrence-tree-delta-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return { repoPath, baseRef: git(repoPath, "rev-parse", "HEAD") };
}

function findChange(changes: TreeChange[], path: string): TreeChange {
    const found = changes.find((change) => change.path === path);
    if (!found) throw new Error(`no change for "${path}"`);
    return found;
}

test("added: staged new file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    writeFileSync(join(repoPath, "new.txt"), "new\n");
    git(repoPath, "add", "new.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "new.txt").kind, "added");
});

test("modified: unstaged edit of tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    writeFileSync(join(repoPath, "seed.txt"), "changed\n");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "seed.txt").kind, "modified");
});

test("deleted: removed tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    rmSync(join(repoPath, "seed.txt"));
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "seed.txt").kind, "deleted");
});

test("renamed: staged git mv", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    git(repoPath, "mv", "seed.txt", "renamed.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    const change = findChange(delta.changes, "renamed.txt");
    assert.equal(change.kind, "renamed");
    assert.equal(change.oldPath, "seed.txt");
});

test("mode-changed: staged chmod with no byte change", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    chmodSync(join(repoPath, "seed.txt"), 0o755);
    git(repoPath, "add", "seed.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    const change = findChange(delta.changes, "seed.txt");
    assert.equal(change.kind, "mode-changed");
    assert.notEqual(change.oldMode, change.newMode);
});

test("symlink: staged tracked symlink", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    symlinkSync("seed.txt", join(repoPath, "link.txt"));
    git(repoPath, "add", "link.txt");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "link.txt").kind, "symlink");
});

test("untracked: new file not added", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    writeFileSync(join(repoPath, "untracked.txt"), "untracked\n");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 1);
    assert.equal(findChange(delta.changes, "untracked.txt").kind, "untracked");
});

test("nested occurrence exclusion: absent from changes and digest", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    mkdirSync(join(repoPath, "nested"));
    writeFileSync(join(repoPath, "nested", "base.txt"), "base\n");
    git(repoPath, "add", "nested/base.txt");
    git(repoPath, "commit", "-q", "-m", "add nested");

    const pristineDelta = await computeOccurrenceTreeDelta({
        occurrencePath: repoPath,
        baseRef,
        nestedOccurrencePaths: ["nested"],
    });

    writeFileSync(join(repoPath, "nested", "base.txt"), "mutated\n");
    writeFileSync(join(repoPath, "nested", "new.txt"), "new\n");

    const delta = await computeOccurrenceTreeDelta({
        occurrencePath: repoPath,
        baseRef,
        nestedOccurrencePaths: ["nested"],
    });
    assert.equal(delta.changes.length, 0);
    assert.equal(delta.digest, pristineDelta.digest);
});

test("ignored exclusion: gitignored untracked file absent from changes", async () => {
    const { repoPath } = makeRepoWithCommit();
    writeFileSync(join(repoPath, ".gitignore"), "ignored.txt\n");
    git(repoPath, "add", ".gitignore");
    git(repoPath, "commit", "-q", "-m", "add gitignore");
    const baseRef = git(repoPath, "rev-parse", "HEAD");
    writeFileSync(join(repoPath, "ignored.txt"), "ignored\n");
    const delta = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.equal(delta.changes.length, 0);
});

test("generated-output exclusion: excludePatterns hides tracked path", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    mkdirSync(join(repoPath, "dist"));
    writeFileSync(join(repoPath, "dist", "gen.txt"), "gen\n");
    git(repoPath, "add", "dist/gen.txt");
    git(repoPath, "commit", "-q", "-m", "add dist");
    writeFileSync(join(repoPath, "dist", "gen.txt"), "gen changed\n");
    const delta = await computeOccurrenceTreeDelta({
        occurrencePath: repoPath,
        baseRef,
        excludePatterns: ["dist/**"],
    });
    assert.equal(delta.changes.length, 0);
});

test("digest equality: byte-identical trees produce equal digests", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.equal(deltaA.digest, deltaB.digest);
});

test("digest inequality: mode difference changes the digest", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    chmodSync(join(b.repoPath, "seed.txt"), 0o755);
    git(b.repoPath, "add", "seed.txt");
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.notEqual(deltaA.digest, deltaB.digest);
});

test("digest inequality: symlink target difference changes the digest", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    symlinkSync("target-a", join(a.repoPath, "link.txt"));
    git(a.repoPath, "add", "link.txt");
    symlinkSync("target-b", join(b.repoPath, "link.txt"));
    git(b.repoPath, "add", "link.txt");
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.notEqual(deltaA.digest, deltaB.digest);
});

test("digest inequality: one differing byte changes the digest", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    writeFileSync(join(b.repoPath, "seed.txt"), "seee\n");
    git(b.repoPath, "add", "seed.txt");
    const [deltaA, deltaB] = await Promise.all([
        computeOccurrenceTreeDelta({ occurrencePath: a.repoPath, baseRef: a.baseRef }),
        computeOccurrenceTreeDelta({ occurrencePath: b.repoPath, baseRef: b.baseRef }),
    ]);
    assert.notEqual(deltaA.digest, deltaB.digest);
});

test("digest changes on unstaged byte edit of a tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    const before = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    writeFileSync(join(repoPath, "seed.txt"), "changed\n");
    const after = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.notEqual(before.digest, after.digest);
});

test("digest changes on unstaged deletion of a tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    const before = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    rmSync(join(repoPath, "seed.txt"));
    const after = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.notEqual(before.digest, after.digest);
});

test("digest changes on unstaged exec-bit change of a tracked file", async () => {
    const { repoPath, baseRef } = makeRepoWithCommit();
    const before = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    chmodSync(join(repoPath, "seed.txt"), 0o755);
    const after = await computeOccurrenceTreeDelta({ occurrencePath: repoPath, baseRef });
    assert.notEqual(before.digest, after.digest);
});

test("computeTreeDigest changes when a symlink target changes", async () => {
    const a = makeRepoWithCommit();
    const b = makeRepoWithCommit();
    symlinkSync("target-a", join(a.repoPath, "link.txt"));
    git(a.repoPath, "add", "link.txt");
    symlinkSync("target-b", join(b.repoPath, "link.txt"));
    git(b.repoPath, "add", "link.txt");
    const [digestA, digestB] = await Promise.all([
        computeTreeDigest({ occurrencePath: a.repoPath }),
        computeTreeDigest({ occurrencePath: b.repoPath }),
    ]);
    assert.notEqual(digestA, digestB);
});

test("computeTreeDelta reports a target-only edit", async () => {
    const source = makeRepoWithCommit();
    const target = makeRepoWithCommit();
    writeFileSync(join(target.repoPath, "seed.txt"), "target changed\n");
    const patches = await computeTreeDelta(
        { occurrencePath: source.repoPath },
        { occurrencePath: target.repoPath },
    );
    assert.deepEqual(patches, [{ path: "seed.txt", kind: "modify", mode: "100644" }]);
});

test("computeTreeDelta reports a source-only untracked file as an addition", async () => {
    const source = makeRepoWithCommit();
    const target = makeRepoWithCommit();
    writeFileSync(join(source.repoPath, "extra.txt"), "extra\n");
    const patches = await computeTreeDelta(
        { occurrencePath: source.repoPath },
        { occurrencePath: target.repoPath },
    );
    assert.equal(patches.length, 1);
    assert.equal(patches[0].kind, "add");
    assert.equal(patches[0].path, "extra.txt");
});

test("computeTreeDelta respects nested-occurrence exclusions on both sides", async () => {
    const source = makeRepoWithCommit();
    const target = makeRepoWithCommit();
    mkdirSync(join(source.repoPath, "nested"));
    writeFileSync(join(source.repoPath, "nested", "a.txt"), "source nested\n");
    mkdirSync(join(target.repoPath, "nested"));
    writeFileSync(join(target.repoPath, "nested", "a.txt"), "target nested\n");
    const patches = await computeTreeDelta(
        { occurrencePath: source.repoPath, nestedOccurrencePaths: ["nested"] },
        { occurrencePath: target.repoPath, nestedOccurrencePaths: ["nested"] },
    );
    assert.deepEqual(patches, []);
});

test("computeTreeDelta respects generated-output exclusions on both sides", async () => {
    const source = makeRepoWithCommit();
    const target = makeRepoWithCommit();
    mkdirSync(join(source.repoPath, "dist"));
    writeFileSync(join(source.repoPath, "dist", "gen.txt"), "source gen\n");
    mkdirSync(join(target.repoPath, "dist"));
    writeFileSync(join(target.repoPath, "dist", "gen.txt"), "target gen\n");
    const patches = await computeTreeDelta(
        { occurrencePath: source.repoPath, excludePatterns: ["dist/**"] },
        { occurrencePath: target.repoPath, excludePatterns: ["dist/**"] },
    );
    assert.deepEqual(patches, []);
});

test("computeTreeDelta yields a deterministic rename, or an accepted delete+add with no old path", async () => {
    const source = makeRepoWithCommit();
    const target = makeRepoWithCommit();
    writeFileSync(join(target.repoPath, "old.txt"), "seed\n");
    git(target.repoPath, "add", "old.txt");
    git(target.repoPath, "commit", "-q", "-m", "add old");
    writeFileSync(join(source.repoPath, "new.txt"), "seed\n");
    git(source.repoPath, "add", "new.txt");
    git(source.repoPath, "commit", "-q", "-m", "add new");
    const patches = await computeTreeDelta(
        { occurrencePath: source.repoPath },
        { occurrencePath: target.repoPath },
    );
    const isSingleRename =
        patches.length === 1 && patches[0].kind === "renamed" && patches[0].path === "new.txt" && patches[0].oldPath === "old.txt";
    const isDeleteAddPair =
        patches.length === 2 &&
        patches.some((p) => p.kind === "delete" && p.path === "old.txt" && p.oldPath === undefined) &&
        patches.some((p) => p.kind === "add" && p.path === "new.txt" && p.oldPath === undefined);
    assert.ok(isSingleRename || isDeleteAddPair);
});
