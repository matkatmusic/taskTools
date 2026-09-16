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
    // Calls mermaidForFile with a path and empty source; expects a two-line flowchart with one box.
    const result = mermaidForFile("scripts/foo/main.ts", "");
    // Checks the exact string: box id replaces non-identifier characters in the path with underscores.
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

test("test_mermaidForFile_parsesFunctionNamesAndChainsCallStatements", () => {
    // Scenario: a file of five functions where three have empty bodies and two chain their call statements.  Step: call it with the multipleCalls/singleCall source from task 190.
    const source = 'function a() {}\nfunction b() {}\nfunction c() {}\nfunction multipleCalls() { a(); b(); c(); a(); }\nfunction singleCall() { a(); b(); }\n';
    const result = mermaidForFile("f.ts", source);
    // Verify: a, b, c get no top box since their bodies are empty; repeated calls get a running number counted across the whole file; each function chains its own calls in source order.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_f_ts["f.ts"]\n' +
        'B_a1["a()"]\n' +
        'B_a2["a()"]\n' +
        'B_a3["a()"]\n' +
        'B_b1["b()"]\n' +
        'B_b2["b()"]\n' +
        'B_c["c()"]\n' +
        'B_multipleCalls["multipleCalls()"]\n' +
        'B_singleCall["singleCall()"]\n' +
        'B_multipleCalls --> B_a1 --> B_b1 --> B_c --> B_a2\n' +
        'B_singleCall --> B_a3 --> B_b2\n'
    );
});

test("test_mermaidForFile_labelsAClassMethodWithClassNameAndMethodName", () => {
    // Scenario: a class with one method bar gets a top box labelled Foo::bar(), followed by its own statement boxes.  Step: call it with a one-method class source.
    const source = 'class Foo {\n  bar() {\n    const a = 1;\n    const b = 2;\n  }\n}\n';
    const result = mermaidForFile("g.ts", source);
    // Verify: the method box id joins the class name and method name with an underscore; each body statement gets its own box chained from the method box.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_g_ts["g.ts"]\n' +
        'B_Foo_bar["Foo::bar()"]\n' +
        'B_a_is_1["const a = 1"]\n' +
        'B_b_is_2["const b = 2"]\n' +
        'B_Foo_bar --> B_a_is_1 --> B_b_is_2\n'
    );
});

test("test_mermaidForFile_chainsTopLevelStatementsFromTheFileBox", () => {
    // Scenario: a pure script file with two top-level statements and no functions chains both statements from the file box.  Step: call it with two const declarations.
    const source = 'const a = 1;\nconst b = 2;\n';
    const result = mermaidForFile("h.ts", source);
    // Verify: no function boxes exist; both statements chain in source order starting at the file box.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_h_ts["h.ts"]\n' +
        'B_a_is_1["const a = 1"]\n' +
        'B_b_is_2["const b = 2"]\n' +
        'B_h_ts --> B_a_is_1 --> B_b_is_2\n'
    );
});

test("test_mermaidForFile_chainsAnExpressionBodiedArrowConstFromItsTopBox", () => {
    // Scenario: an arrow-function const with an expression body (no braces) gets a top box and one expression box chained from it.  Step: call it with such a const.
    const source = 'const double = (x) => x * 2;\n';
    const result = mermaidForFile("i.ts", source);
    // Verify: the top box is named for the const, and the expression itself becomes one box chained from it.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_i_ts["i.ts"]\n' +
        'B_double["double(x)"]\n' +
        'B_x_2["x * 2"]\n' +
        'B_double --> B_x_2\n'
    );
});

test("test_mermaidForFile_addsRelativeImportPathAsSecondLabelLineForAConstAssignmentCall", () => {
    // Scenario: a const-assignment call to a function imported from a relative specifier gets a second label line; a property-access call to a global does not.  Step: call it with an import declaration plus a two-statement function body.
    const source = 'import { readTask } from "../shared/tasks.ts";\nfunction main() { const t = readTask(1); console.log(t); }\n';
    const result = mermaidForFile("j.ts", source);
    // Verify: the readTask call box gains <br/>../shared/tasks.ts; the console.log box gains no second line; the import declaration produces no box.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_j_ts["j.ts"]\n' +
        'B_console_log_t["console.log(t)"]\n' +
        'B_main["main()"]\n' +
        'B_t_is_readTask_1["const t = readTask(1)<br/>../shared/tasks.ts"]\n' +
        'B_main --> B_t_is_readTask_1 --> B_console_log_t\n'
    );
});

test("test_mermaidForFile_addsRelativeImportPathForABareCallStatement", () => {
    // Scenario: a bare call statement to a relative-imported function gets the import path as a second label line.  Step: call it with an import and a one-statement function body.
    const source = 'import { setup } from "./setup.ts";\nfunction g() { setup(); }\n';
    const result = mermaidForFile("k.ts", source);
    // Verify: the setup() call box gains <br/>./setup.ts.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_k_ts["k.ts"]\n' +
        'B_g["g()"]\n' +
        'B_setup["setup()<br/>./setup.ts"]\n' +
        'B_g --> B_setup\n'
    );
});

test("test_mermaidForFile_addsRelativeImportPathForAReturnCall", () => {
    // Scenario: a return statement whose expression is a relative-imported call gets the import path as a second label line.  Step: call it with an import and a returning function body.
    const source = 'import { pick } from "./pick.ts";\nfunction m() { return pick(); }\n';
    const result = mermaidForFile("l.ts", source);
    // Verify: the return pick() box gains <br/>./pick.ts.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_l_ts["l.ts"]\n' +
        'B_m["m()"]\n' +
        'B_return_pick["return pick()<br/>./pick.ts"]\n' +
        'B_m --> B_return_pick\n'
    );
});

test("test_mermaidForFile_addsRelativeImportPathForAnAwaitCall", () => {
    // Scenario: an await expression statement wrapping a relative-imported call gets the import path as a second label line.  Step: call it with an import and an async function body.
    const source = 'import { flush } from "../io.ts";\nasync function n() { await flush(); }\n';
    const result = mermaidForFile("m.ts", source);
    // Verify: the await flush() box gains <br/>../io.ts.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_m_ts["m.ts"]\n' +
        'B_flush["await flush()<br/>../io.ts"]\n' +
        'B_n["n()"]\n' +
        'B_n --> B_flush\n'
    );
});

test("test_mermaidForFile_addsRelativeImportPathForADefaultImportCall", () => {
    // Scenario: a call to a function imported as a default import from a relative specifier gets the import path as a second label line.  Step: call it with a default import and a one-statement function body.
    const source = 'import run from "./run.ts";\nfunction q() { run(); }\n';
    const result = mermaidForFile("o.ts", source);
    // Verify: the run() call box gains <br/>./run.ts.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_o_ts["o.ts"]\n' +
        'B_q["q()"]\n' +
        'B_run["run()<br/>./run.ts"]\n' +
        'B_q --> B_run\n'
    );
});

test("test_mermaidForFile_addsNoSecondLabelLineForANodeModuleImportCall", () => {
    // Scenario: a call to a function imported from a non-relative (node module) specifier gets no second label line.  Step: call it with a node import and a one-statement function body.
    const source = 'import { execFileSync } from "node:child_process";\nfunction p() { execFileSync(); }\n';
    const result = mermaidForFile("n.ts", source);
    // Verify: the execFileSync() call box has no <br/> second line.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_n_ts["n.ts"]\n' +
        'B_execFileSync["execFileSync()"]\n' +
        'B_p["p()"]\n' +
        'B_p --> B_execFileSync\n'
    );
});
