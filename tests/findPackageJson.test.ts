// Behavioral checks for findPackageJson.ts. Run: node --test tests/findPackageJson.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getProjectRoot,
    // ensurePackageJsonExists,
    findNearestPackageJson,
} from "../scripts/shared/findPackageJson.ts";

function withScratchRepo(body: (repoPath: string) => void): void {
    const repoPath = mkdtempSync(join(tmpdir(), "find-package-json-"));
    try {
        execFileSync("git", ["-C", repoPath, "init", "-q"]);
        body(repoPath);
    } finally {
        rmSync(repoPath, { recursive: true, force: true });
    }
}

test("test_findNearestPackageJson_prefersTheNearerSubmodulePackageJsonOverTheRootOne", () => {
    withScratchRepo((repoPath) => {
        writeFileSync(join(repoPath, "package.json"), "{}");
        mkdirSync(join(repoPath, "mermaid-editor", "tests"), { recursive: true });
        writeFileSync(join(repoPath, "mermaid-editor", "package.json"), "{}");
        const filePath = join(repoPath, "mermaid-editor", "tests", "x.test.ts");
        writeFileSync(filePath, "");
        assert.equal(findNearestPackageJson(filePath), join(repoPath, "mermaid-editor", "package.json"));
    });
});

test("test_findNearestPackageJson_findsTheRootPackageJsonForARootLevelFile", () => {
    withScratchRepo((repoPath) => {
        writeFileSync(join(repoPath, "package.json"), "{}");
        mkdirSync(join(repoPath, "tests"), { recursive: true });
        const filePath = join(repoPath, "tests", "x.test.ts");
        writeFileSync(filePath, "");
        assert.equal(findNearestPackageJson(filePath), join(repoPath, "package.json"));
    });
});

test("test_findNearestPackageJson_returnsNullWhenNoPackageJsonExistsAtOrAboveTheFile", () => {
    withScratchRepo((repoPath) => {
        mkdirSync(join(repoPath, "tests"), { recursive: true });
        const filePath = join(repoPath, "tests", "x.test.ts");
        writeFileSync(filePath, "");
        assert.equal(findNearestPackageJson(filePath), null);
    });
});

// ensurePackageJsonExists (and findPackageJsonFolderOrUndefined) commented out in findPackageJson.ts.
// test("test_ensurePackageJsonExists_isTrueWhenPackageJsonOnlyLivesInASubfolder", () => {
//     withScratchRepo((repoPath) => {
//         mkdirSync(join(repoPath, "nested"), { recursive: true });
//         writeFileSync(join(repoPath, "nested", "package.json"), "{}");
//         assert.equal(ensurePackageJsonExists(repoPath), true);
//     });
// });

// test("test_ensurePackageJsonExists_isFalseWhenPackageJsonOnlyLivesInsideNodeModules", () => {
//     withScratchRepo((repoPath) => {
//         mkdirSync(join(repoPath, "node_modules", "some-dep"), { recursive: true });
//         writeFileSync(join(repoPath, "node_modules", "some-dep", "package.json"), "{}");
//         assert.equal(ensurePackageJsonExists(repoPath), false);
//     });
// });

test("test_getProjectRoot_findsTheDotGitFolderFromANestedFolder", () => {
    withScratchRepo((repoPath) => {
        mkdirSync(join(repoPath, "a", "b", "c"), { recursive: true });
        assert.equal(getProjectRoot(join(repoPath, "a", "b", "c")), repoPath);
    });
});

test("test_getProjectRoot_returnsTheSuperprojectRootFromInsideASubmodule", () => {
    const superRepo = mkdtempSync(join(tmpdir(), "find-package-json-super-"));
    const subSourceRepo = mkdtempSync(join(tmpdir(), "find-package-json-subsource-"));
    try {
        execFileSync("git", ["-C", subSourceRepo, "init", "-q"]);
        writeFileSync(join(subSourceRepo, "package.json"), "{}");
        execFileSync("git", ["-C", subSourceRepo, "add", "."]);
        execFileSync("git", ["-C", subSourceRepo, "-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

        execFileSync("git", ["-C", superRepo, "init", "-q"]);
        writeFileSync(join(superRepo, "package.json"), "{}");
        execFileSync("git", ["-C", superRepo, "-c", "protocol.file.allow=always", "submodule", "add", subSourceRepo, "sub"]);
        mkdirSync(join(superRepo, "sub", "tests"), { recursive: true });
        const filePath = join(superRepo, "sub", "tests", "x.test.ts");
        writeFileSync(filePath, "");

        const nearestPackageJson = findNearestPackageJson(filePath);
        assert.ok(nearestPackageJson);
        assert.equal(realpathSync(getProjectRoot(filePath)), realpathSync(superRepo));
        assert.equal(realpathSync(nearestPackageJson), realpathSync(join(superRepo, "sub", "package.json")));
    } finally {
        rmSync(superRepo, { recursive: true, force: true });
        rmSync(subSourceRepo, { recursive: true, force: true });
    }
});

test("test_findNearestPackageJson_returnsNullInsteadOfHangingWhenRootIsASymlinkedTmpdir", () => {
    withScratchRepo((repoPath) => {
        mkdirSync(join(repoPath, "tests"), { recursive: true });
        const filePath = join(repoPath, "tests", "x.test.ts");
        writeFileSync(filePath, "");
        assert.notEqual(repoPath, realpathSync(repoPath), "expected the scratch repo path to live under a symlinked tmpdir");
        assert.equal(findNearestPackageJson(filePath), null);
    });
});

// findPackageJsonFolder (shallowest-first BFS) was commented out; it was not the agreed search order.
// test("test_findPackageJsonFolder_returnsTheShallowestFolder", () => {});
