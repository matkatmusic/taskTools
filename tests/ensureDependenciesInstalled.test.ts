// Behavioral checks for ensureDependenciesInstalled.ts. Run: node --test tests/ensureDependenciesInstalled.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDependenciesInstalled } from "../scripts/shared/ensureDependenciesInstalled.ts";

test("test_ensureDependenciesInstalled_installsOnceThenSkipsOnASecondCall", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "ensure-deps-installed-"));
    try {
        execFileSync("git", ["-C", repoPath, "init", "-q"]);
        // npm install leaves no node_modules folder at all when there is nothing to install.
        writeFileSync(join(repoPath, "package.json"), JSON.stringify({
            name: "scratch", version: "1.0.0", dependencies: { picocolors: "1.0.0" },
        }));
        const nodeModulesPath = join(repoPath, "node_modules");
        assert.equal(existsSync(nodeModulesPath), false);

        ensureDependenciesInstalled(repoPath);
        assert.equal(existsSync(nodeModulesPath), true);

        const secondCallStart = Date.now();
        ensureDependenciesInstalled(repoPath);
        const secondCallDurationMs = Date.now() - secondCallStart;
        assert.equal(existsSync(nodeModulesPath), true);
        assert.ok(secondCallDurationMs < 2000, `expected the second call to skip installing, took ${secondCallDurationMs}ms`);
    } finally {
        rmSync(repoPath, { recursive: true, force: true });
    }
});
