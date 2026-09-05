// Behavioral checks for relatedTests.ts: per-occurrence batching of edited files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { groupEditsByOccurrence } from "../scripts/relatedTests.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "root",
        checkoutPath: "repo",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "https://example.com/repo.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "task-group-1",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

const rootPath = "/workspace";
const SCRIPT_PATH = fileURLToPath(new URL("../scripts/relatedTests.ts", import.meta.url));

const root = makeOccurrence({ occurrenceId: "root", checkoutPath: "repo", childOccurrenceIds: ["pluginRepo"] });
const pluginRepo = makeOccurrence({
    occurrenceId: "pluginRepo",
    checkoutPath: "repo/plugin",
    parentOccurrenceId: "root",
    pathInParent: "plugin",
    depth: 1,
    childOccurrenceIds: ["nestedLib"],
});
const nestedLib = makeOccurrence({
    occurrenceId: "nestedLib",
    checkoutPath: "repo/plugin/vendor/lib",
    parentOccurrenceId: "pluginRepo",
    pathInParent: "vendor/lib",
    depth: 2,
});

const manifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [root, pluginRepo, nestedLib],
};

const rootFile = "/workspace/repo/src/app.test.ts";
const pluginFile = "/workspace/repo/plugin/src/thing.test.ts";
const nestedFile = "/workspace/repo/plugin/vendor/lib/src/foo.test.ts";

test("test_fileInsideNestedOccurrenceResolvesToItNotItsAncestorOrTheRoot", () => {
    const { batches } = groupEditsByOccurrence([nestedFile], rootPath, manifest);
    assert.deepEqual([...batches.keys()], ["nestedLib"]);
});

test("test_editsSpanningTwoOccurrencesYieldTwoBatchesEachHoldingOnlyItsOwnFiles", () => {
    const { batches } = groupEditsByOccurrence([pluginFile, nestedFile], rootPath, manifest);
    assert.equal(batches.size, 2);
    const pluginSources = [...batches.get("pluginRepo")!.byExtension.values()].flatMap((b) => b.sources);
    const nestedSources = [...batches.get("nestedLib")!.byExtension.values()].flatMap((b) => b.sources);
    assert.deepEqual(pluginSources, [pluginFile]);
    assert.deepEqual(nestedSources, [nestedFile]);
});

test("test_fileDirectlyInRootRepoMapsToTheRootOccurrence", () => {
    const { batches } = groupEditsByOccurrence([rootFile], rootPath, manifest);
    assert.deepEqual([...batches.keys()], ["root"]);
});

test("test_aNonTestTsFileResolvesToATestFileInTheSameDirectory", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "relatedTests-"));
    const srcDir = join(tmpRoot, "src");
    mkdirSync(srcDir, { recursive: true });
    const sourceFile = join(srcDir, "thing.ts");
    const testFile = join(srcDir, "thing.test.ts");
    writeFileSync(sourceFile, "export const thing = 1;\n");
    writeFileSync(testFile, "// placeholder test\n");
    const tmpOccurrence = makeOccurrence({ occurrenceId: "tmpRoot", checkoutPath: "" });
    const tmpManifest: RepositoryManifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: [tmpOccurrence] };
    const { batches, warnings } = groupEditsByOccurrence([sourceFile], tmpRoot, tmpManifest);
    assert.deepEqual(warnings, []);
    const tests = [...batches.get("tmpRoot")!.byExtension.values()].flatMap((b) => b.tests);
    assert.ok(tests.includes(testFile));
});

test("test_main_readsTheTurnFlagOnStopAndReportsTypeErrors", () => {
    const repo = mkdtempSync(join(tmpdir(), "related-tests-hook-"));
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["*.ts", "tests"] }));
    writeFileSync(join(repo, "widget.ts"), "export const n: number = \"not a number\";\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests", "widget.test.ts"), "");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);

    const home = mkdtempSync(join(tmpdir(), "related-tests-home-"));
    mkdirSync(join(home, ".claude", "turn-flags"), { recursive: true });
    writeFileSync(join(home, ".claude", "turn-flags", "session-1"), `${join(repo, "widget.ts")}\n`);
    const payload = JSON.stringify({ session_id: "session-1", cwd: repo });
    const run = spawnSync("node", [SCRIPT_PATH], { input: payload, encoding: "utf8", env: { ...process.env, HOME: home } });

    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /Type errors after editing .*widget\.ts/);
    assert.match(run.stderr, /error TS2322/);
});
