// Behavioral checks for occurrenceSync.ts: N-way convergence, propagation, determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTreeDigest } from "../scripts/occurrenceTreeDelta.ts";
import type { OccurrenceTreeSpec } from "../scripts/occurrenceTreeDelta.ts";
import { syncOccurrences } from "../scripts/occurrenceSync.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeOccurrenceRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "occurrence-sync-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

test("rejects an empty occurrences list", async () => {
    await assert.rejects(() => syncOccurrences("/nonexistent", []));
});

test("rejects duplicate normalized occurrence paths", async () => {
    await assert.rejects(() =>
        syncOccurrences("/a", [{ occurrencePath: "/a" }, { occurrencePath: "/a" }]),
    );
});

test("rejects zero occurrences matching the source path", async () => {
    await assert.rejects(() => syncOccurrences("/a", [{ occurrencePath: "/b" }]));
});

test("rejects more than one occurrence matching the source path", async () => {
    await assert.rejects(() =>
        syncOccurrences("/a", [{ occurrencePath: "/a" }, { occurrencePath: "/a/../a" }]),
    );
});

test("rejects a non-positive maxIterations", async () => {
    await assert.rejects(() => syncOccurrences("/a", [{ occurrencePath: "/a" }], { maxIterations: 0 }));
});

test("rejects a non-integer maxIterations", async () => {
    await assert.rejects(() => syncOccurrences("/a", [{ occurrencePath: "/a" }], { maxIterations: 1.5 }));
});

test("two-way convergence", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    writeFileSync(join(source, "only-source.txt"), "only source\n");
    writeFileSync(join(target, "only-target.txt"), "only target\n");

    const occurrences: OccurrenceTreeSpec[] = [{ occurrencePath: source }, { occurrencePath: target }];
    const result = await syncOccurrences(source, occurrences);

    assert.equal(result.converged, true);
    assert.equal(result.iterations, 1);
    assert.deepEqual(result.changedPaths[target], ["only-source.txt", "only-target.txt"]);
    assert.deepEqual(result.changedPaths[source], []);
});

test("three-way convergence", async () => {
    const source = makeOccurrenceRepo();
    const targetA = makeOccurrenceRepo();
    const targetB = makeOccurrenceRepo();
    writeFileSync(join(targetA, "a-only.txt"), "a\n");
    writeFileSync(join(targetB, "b-only.txt"), "b\n");

    const occurrences: OccurrenceTreeSpec[] = [
        { occurrencePath: source },
        { occurrencePath: targetA },
        { occurrencePath: targetB },
    ];
    const result = await syncOccurrences(source, occurrences);

    assert.equal(result.converged, true);
    assert.equal(result.iterations, 1);
    assert.deepEqual(result.changedPaths[targetA], ["a-only.txt"]);
    assert.deepEqual(result.changedPaths[targetB], ["b-only.txt"]);
});

test("N-way convergence (4 occurrences)", async () => {
    const source = makeOccurrenceRepo();
    const targets = [makeOccurrenceRepo(), makeOccurrenceRepo(), makeOccurrenceRepo()];
    targets.forEach((target, index) => {
        writeFileSync(join(target, `only-${index}.txt`), `only ${index}\n`);
    });

    const occurrences: OccurrenceTreeSpec[] = [
        { occurrencePath: source },
        ...targets.map((occurrencePath) => ({ occurrencePath })),
    ];
    const result = await syncOccurrences(source, occurrences);

    assert.equal(result.converged, true);
    assert.equal(result.iterations, 1);
    targets.forEach((target, index) => {
        assert.deepEqual(result.changedPaths[target], [`only-${index}.txt`]);
    });
});

test("target-only modification removed/overwritten", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    writeFileSync(join(target, "seed.txt"), "edited\n");

    const occurrences: OccurrenceTreeSpec[] = [{ occurrencePath: source }, { occurrencePath: target }];
    await syncOccurrences(source, occurrences);

    assert.equal(readFileSync(join(target, "seed.txt"), "utf8"), readFileSync(join(source, "seed.txt"), "utf8"));
    const [sourceDigest, targetDigest] = await Promise.all([
        computeTreeDigest({ occurrencePath: source }),
        computeTreeDigest({ occurrencePath: target }),
    ]);
    assert.equal(sourceDigest, targetDigest);
});

test("target-only untracked file deleted", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    writeFileSync(join(target, "stray.txt"), "stray\n");

    const occurrences: OccurrenceTreeSpec[] = [{ occurrencePath: source }, { occurrencePath: target }];
    await syncOccurrences(source, occurrences);

    assert.equal(existsSync(join(target, "stray.txt")), false);
});

test("unstaged source changes propagate", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    writeFileSync(join(source, "seed.txt"), "mutated\n");

    const occurrences: OccurrenceTreeSpec[] = [{ occurrencePath: source }, { occurrencePath: target }];
    await syncOccurrences(source, occurrences);

    assert.equal(readFileSync(join(target, "seed.txt"), "utf8"), "mutated\n");
});

test("nested occurrence contents untouched", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    mkdirSync(join(source, "nested"));
    writeFileSync(join(source, "nested", "file.txt"), "source nested\n");
    mkdirSync(join(target, "nested"));
    writeFileSync(join(target, "nested", "file.txt"), "target nested\n");

    const occurrences: OccurrenceTreeSpec[] = [
        { occurrencePath: source, nestedOccurrencePaths: ["nested"] },
        { occurrencePath: target, nestedOccurrencePaths: ["nested"] },
    ];
    const result = await syncOccurrences(source, occurrences);

    assert.equal(readFileSync(join(target, "nested", "file.txt"), "utf8"), "target nested\n");
    assert.deepEqual(result.changedPaths[target], []);
});

test("excluded generated output untouched", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    mkdirSync(join(source, "dist"));
    writeFileSync(join(source, "dist", "gen.txt"), "source gen\n");
    mkdirSync(join(target, "dist"));
    writeFileSync(join(target, "dist", "gen.txt"), "target gen\n");

    const occurrences: OccurrenceTreeSpec[] = [
        { occurrencePath: source, excludePatterns: ["dist/**"] },
        { occurrencePath: target, excludePatterns: ["dist/**"] },
    ];
    const result = await syncOccurrences(source, occurrences);

    assert.equal(readFileSync(join(target, "dist", "gen.txt"), "utf8"), "target gen\n");
    assert.deepEqual(result.changedPaths[target], []);
});

test("order-independence", async () => {
    const sourceA = makeOccurrenceRepo();
    const targetA = makeOccurrenceRepo();
    writeFileSync(join(sourceA, "only-source.txt"), "only source\n");
    writeFileSync(join(targetA, "only-target.txt"), "only target\n");

    const sourceB = makeOccurrenceRepo();
    const targetB = makeOccurrenceRepo();
    writeFileSync(join(sourceB, "only-source.txt"), "only source\n");
    writeFileSync(join(targetB, "only-target.txt"), "only target\n");

    const resultA = await syncOccurrences(sourceA, [{ occurrencePath: sourceA }, { occurrencePath: targetA }]);
    const resultB = await syncOccurrences(sourceB, [{ occurrencePath: targetB }, { occurrencePath: sourceB }]);

    assert.deepEqual(resultA.changedPaths[targetA], resultB.changedPaths[targetB]);
    const [digestA, digestB] = await Promise.all([
        computeTreeDigest({ occurrencePath: targetA }),
        computeTreeDigest({ occurrencePath: targetB }),
    ]);
    assert.equal(digestA, digestB);
});

test("filesystem failure throws with context", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    writeFileSync(join(source, "only-source.txt"), "only source\n");
    chmodSync(target, 0o555);

    try {
        await assert.rejects(
            () => syncOccurrences(source, [{ occurrencePath: source }, { occurrencePath: target }]),
            (error: Error) => {
                assert.match(error.message, /syncOccurrences/);
                assert.ok(error.message.includes(source));
                assert.ok(error.message.includes(target));
                assert.ok(error.message.includes("only-source.txt"));
                return true;
            },
        );
    } finally {
        chmodSync(target, 0o755);
    }
});

test("second sync is a no-op", async () => {
    const source = makeOccurrenceRepo();
    const target = makeOccurrenceRepo();
    writeFileSync(join(source, "only-source.txt"), "only source\n");

    const occurrences: OccurrenceTreeSpec[] = [{ occurrencePath: source }, { occurrencePath: target }];
    await syncOccurrences(source, occurrences);
    const second = await syncOccurrences(source, occurrences);

    assert.equal(second.converged, true);
    assert.equal(second.iterations, 0);
    assert.deepEqual(second.changedPaths[source], []);
    assert.deepEqual(second.changedPaths[target], []);
});
