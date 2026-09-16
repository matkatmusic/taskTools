// Behavioral checks for scripts/mermaid/mermaid.ts. Run alone: node --test tests/mermaid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mermaidForFile, writeAllDiagrams } from "../scripts/mermaid/mermaid.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

test("test_mermaidForFile_emitsFlowchartAndOneBoxForThePath", () => {
    // Scenario: mermaidForFile returns a two-line diagram: `flowchart TD` and one B_ box labelled with the path.  Step: call it with a path and empty source text.
    const result = mermaidForFile("scripts/foo/main.ts", "");
    // Verify: the exact two-line string with a trailing newline; the id is the path with non-identifier chars replaced by _.
    assert.equal(result, 'flowchart TD\nB_scripts_foo_main_ts["scripts/foo/main.ts"]\n');
});

test("test_mermaidForFile_replacesEveryNonIdentifierCharInTheBoxId", () => {
    // Scenario: a path with a dash, slashes, and dots becomes an id joined only by _.  Step: call it with such a path.
    const result = mermaidForFile("a-b/c.d.ts", "");
    // Verify: dash, slash, and every dot become _; the label keeps the original path.
    assert.equal(result, 'flowchart TD\nB_a_b_c_d_ts["a-b/c.d.ts"]\n');
});

test("test_writeAllDiagrams_writesOnlyForNonTestTsFiles", () => {
    // Scenario: in a temp git repo with a.ts, a.test.ts, and tests/b.ts committed, only a.mmd is written.  Setup: create a temp git repo.
    const repoRoot = mkdtempSync(join(tmpdir(), "mermaid-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    // Setup: commit a.ts, a.test.ts, and tests/b.ts.
    writeFileSync(join(repoRoot, "a.ts"), "");
    writeFileSync(join(repoRoot, "a.test.ts"), "");
    mkdirSync(join(repoRoot, "tests"), { recursive: true });
    writeFileSync(join(repoRoot, "tests", "b.ts"), "");
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-q", "-m", "seed");
    // Test action: run the scanner against the temp repo.
    writeAllDiagrams(repoRoot);
    // Verify: only a.mmd is written under .taskTools/diagrams.
    const diagramsDir = join(repoRoot, ".taskTools", "diagrams");
    assert.deepEqual(readdirSync(diagramsDir), ["a.mmd"]);
    // Verify: the excluded files produced no diagram and no tests subdirectory.
    assert.ok(!existsSync(join(diagramsDir, "a.test.mmd")));
    assert.ok(!existsSync(join(diagramsDir, "tests")));
    // Verify: a.mmd holds exactly what mermaidForFile emits for a.ts.
    assert.equal(readFileSync(join(diagramsDir, "a.mmd"), "utf8"), mermaidForFile("a.ts", ""));
    // Cleanup.
    rmSync(repoRoot, { recursive: true, force: true });
});
