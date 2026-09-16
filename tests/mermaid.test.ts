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
    // A path with a dash, slashes, and dots becomes an id joined only by underscores.
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
    // Five functions: three have empty bodies; two chain their call statements in order.
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

test("test_mermaidForFile_parsesAnIfWithEarlyReturnIntoADiamondWithTwoChoices", () => {
    // Scenario: the load(path) example — an if with only a then-arm that returns, followed by two more statements.  Step: call it with that function body.
    const source = 'function load(path: string) {\n  if (!exists(path)) {\n    return null;\n  }\n  const raw = read(path);\n  return parse(raw);\n}\n';
    const result = mermaidForFile("p.ts", source);
    // Verify: the diamond id and both choice ids come from computeBaseId of the condition text; the Y arm ends in return and stops; the N arm (no else) falls through and chains the remaining statements.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_p_ts["p.ts"]\n' +
        'B_load["load(path: string)"]\n' +
        'B_raw_is_read_path["const raw = read(path)"]\n' +
        'B_return["return null"]\n' +
        'B_return_parse_raw["return parse(raw)"]\n' +
        'Q_CHOICE_not_exists_path_N["exists(path)"]\n' +
        'Q_CHOICE_not_exists_path_Y["!exists(path)"]\n' +
        'Q_not_exists_path{"if( !exists(path) )"}\n' +
        'B_load --> Q_not_exists_path\n' +
        'Q_not_exists_path --> Q_CHOICE_not_exists_path_Y --> B_return\n' +
        'Q_not_exists_path --> Q_CHOICE_not_exists_path_N --> B_raw_is_read_path --> B_return_parse_raw\n'
    );
});

test("test_mermaidForFile_bothIfElseArmsRejoinAtTheStatementAfterTheIf", () => {
    // Scenario: an if/else whose arms both continue (neither returns); both must rejoin at the same next-statement box, declared once but referenced by two edges.  Step: call it with that function body.
    const source = 'function g(flag) {\n  if (flag) {\n    doA();\n  } else {\n    doB();\n  }\n  doNext();\n}\n';
    const result = mermaidForFile("r.ts", source);
    // Verify: doNext() is declared once but both the Y-arm chain and the N-arm chain end with "--> B_doNext"; the opposite of a bare identifier condition (no operator) is "!(text)".
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_r_ts["r.ts"]\n' +
        'B_doA["doA()"]\n' +
        'B_doB["doB()"]\n' +
        'B_doNext["doNext()"]\n' +
        'B_g["g(flag)"]\n' +
        'Q_CHOICE_flag_N["!(flag)"]\n' +
        'Q_CHOICE_flag_Y["flag"]\n' +
        'Q_flag{"if( flag )"}\n' +
        'B_g --> Q_flag\n' +
        'Q_flag --> Q_CHOICE_flag_Y --> B_doA --> B_doNext\n' +
        'Q_flag --> Q_CHOICE_flag_N --> B_doB --> B_doNext\n'
    );
});

test("test_mermaidForFile_greaterThanConditionFlipsToLessThanOrEqualOnTheNoArm", () => {
    // Scenario: `if (count > 3)` with no else; verifies the id-from-condition rule and the operator-flip table entry for ">".  Step: call it with that function body.
    const source = 'function f(count) {\n  if (count > 3) {\n    doThing();\n  }\n}\n';
    const result = mermaidForFile("q.ts", source);
    // Verify: the diamond id is Q_count_greater_than_3; the _N choice box is labelled "count <= 3".
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_q_ts["q.ts"]\n' +
        'B_doThing["doThing()"]\n' +
        'B_f["f(count)"]\n' +
        'Q_CHOICE_count_greater_than_3_N["count <= 3"]\n' +
        'Q_CHOICE_count_greater_than_3_Y["count > 3"]\n' +
        'Q_count_greater_than_3{"if( count > 3 )"}\n' +
        'B_f --> Q_count_greater_than_3\n' +
        'Q_count_greater_than_3 --> Q_CHOICE_count_greater_than_3_Y --> B_doThing\n' +
        'Q_count_greater_than_3 --> Q_CHOICE_count_greater_than_3_N\n'
    );
});

test("test_mermaidForFile_nestedIfRejoinsInnerArmsBeforeOuterArmRejoinsSeparately", () => {
    // Scenario: an if nested inside another if's then-arm; the inner if's two arms rejoin at the shared statement after it, and that rejoined path then continues to the statement after the outer if, while the outer if's no-arm connects straight to that same final statement.  Step: call it with that function body.
    const source = 'function f(x, y) {\n  if (x) {\n    if (y) {\n      a();\n    } else {\n      b();\n    }\n    c();\n  }\n  d();\n}\n';
    const result = mermaidForFile("s.ts", source);
    // Verify: Q_x and Q_y are distinct diamonds; Q_y's Y and N arms both join at B_c; B_c then connects to B_d; Q_x's N arm connects directly to B_d (not through B_c).
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_s_ts["s.ts"]\n' +
        'B_a["a()"]\n' +
        'B_b["b()"]\n' +
        'B_c["c()"]\n' +
        'B_d["d()"]\n' +
        'B_f["f(x, y)"]\n' +
        'Q_CHOICE_x_N["!(x)"]\n' +
        'Q_CHOICE_x_Y["x"]\n' +
        'Q_CHOICE_y_N["!(y)"]\n' +
        'Q_CHOICE_y_Y["y"]\n' +
        'Q_x{"if( x )"}\n' +
        'Q_y{"if( y )"}\n' +
        'B_f --> Q_x\n' +
        'Q_x --> Q_CHOICE_x_Y --> Q_y\n' +
        'Q_y --> Q_CHOICE_y_Y --> B_a --> B_c\n' +
        'Q_y --> Q_CHOICE_y_N --> B_b --> B_c\n' +
        'B_c --> B_d\n' +
        'Q_x --> Q_CHOICE_x_N --> B_d\n'
    );
});

test("test_mermaidForFile_forOfLoopBecomesADiamondWithABackEdge", () => {
    // Scenario: the sum(list) for-loop example from task 190 (without the while).  Step: call it with that function body.
    const source = 'function sum(list: number[]) {\n  let total = 0;\n  for (const x of list) {\n    total += x;\n  }\n  return total;\n}\n';
    const result = mermaidForFile("t.ts", source);
    // Verify: the diamond id is "for_" plus computeBaseId of the header; the Y arm enters the body and the last body box loops back to the diamond; the N arm goes to the statement after the loop.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_t_ts["t.ts"]\n' +
        'B_return_total["return total"]\n' +
        'B_sum["sum(list: number[])"]\n' +
        'B_total_is_0["let total = 0"]\n' +
        'B_total_plus_is_x["total += x"]\n' +
        'Q_CHOICE_for_x_of_list_N["i >= list.length"]\n' +
        'Q_CHOICE_for_x_of_list_Y["i < list.length; x = list[i];"]\n' +
        'Q_for_x_of_list{"for (const x of list)"}\n' +
        'B_sum --> B_total_is_0 --> Q_for_x_of_list\n' +
        'Q_for_x_of_list --> Q_CHOICE_for_x_of_list_Y --> B_total_plus_is_x --> Q_for_x_of_list\n' +
        'Q_for_x_of_list --> Q_CHOICE_for_x_of_list_N --> B_return_total\n'
    );
});

test("test_mermaidForFile_classicForConditionAndItsFlippedOppositeBecomeTheChoiceLabels", () => {
    // Scenario: a classic `for (let i = 0; i < 3; i++)` with a one-statement body and nothing after it.  Step: call it with that function body.
    const source = 'function count() {\n  for (let i = 0; i < 3; i++) {\n    log(i);\n  }\n}\n';
    const result = mermaidForFile("u.ts", source);
    // Verify: the _Y choice is labelled with the condition text; the _N choice is labelled with the table-flipped opposite; the loop's only open path (the _N arm) is flushed at the end since nothing follows it.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_u_ts["u.ts"]\n' +
        'B_count["count()"]\n' +
        'B_log_i["log(i)"]\n' +
        'Q_CHOICE_for_i_is_0_i_less_than_3_i_N["i >= 3"]\n' +
        'Q_CHOICE_for_i_is_0_i_less_than_3_i_Y["i < 3"]\n' +
        'Q_for_i_is_0_i_less_than_3_i{"for (let i = 0; i < 3; i++)"}\n' +
        'B_count --> Q_for_i_is_0_i_less_than_3_i\n' +
        'Q_for_i_is_0_i_less_than_3_i --> Q_CHOICE_for_i_is_0_i_less_than_3_i_Y --> B_log_i --> Q_for_i_is_0_i_less_than_3_i\n' +
        'Q_for_i_is_0_i_less_than_3_i --> Q_CHOICE_for_i_is_0_i_less_than_3_i_N\n'
    );
});

test("test_mermaidForFile_whileLoopBecomesADiamondWithABackEdge", () => {
    // Scenario: the full sum(list) example from task 190 - a for loop, then a while loop, then a return.  Step: call it with that function body.
    const source = 'function sum(list: number[]) {\n  let total = 0;\n  for (const x of list) {\n    total += x;\n  }\n  while (total > 100) {\n    total = halve(total);\n  }\n  return total;\n}\n';
    const result = mermaidForFile("v.ts", source);
    // Verify: the while diamond id is "while_" plus computeBaseId of the header; _Y is the condition and _N is its flipped opposite; the for loop _N arm now flows into the while diamond; the body box loops back to the while diamond; the while _N arm flows to the return.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_v_ts["v.ts"]\n' +
        'B_return_total["return total"]\n' +
        'B_sum["sum(list: number[])"]\n' +
        'B_total_is_0["let total = 0"]\n' +
        'B_total_is_halve_total["total = halve(total)"]\n' +
        'B_total_plus_is_x["total += x"]\n' +
        'Q_CHOICE_for_x_of_list_N["i >= list.length"]\n' +
        'Q_CHOICE_for_x_of_list_Y["i < list.length; x = list[i];"]\n' +
        'Q_CHOICE_while_total_greater_than_100_N["total <= 100"]\n' +
        'Q_CHOICE_while_total_greater_than_100_Y["total > 100"]\n' +
        'Q_for_x_of_list{"for (const x of list)"}\n' +
        'Q_while_total_greater_than_100{"while (total > 100)"}\n' +
        'B_sum --> B_total_is_0 --> Q_for_x_of_list\n' +
        'Q_for_x_of_list --> Q_CHOICE_for_x_of_list_Y --> B_total_plus_is_x --> Q_for_x_of_list\n' +
        'Q_for_x_of_list --> Q_CHOICE_for_x_of_list_N --> Q_while_total_greater_than_100\n' +
        'Q_while_total_greater_than_100 --> Q_CHOICE_while_total_greater_than_100_Y --> B_total_is_halve_total --> Q_while_total_greater_than_100\n' +
        'Q_while_total_greater_than_100 --> Q_CHOICE_while_total_greater_than_100_N --> B_return_total\n'
    );
});

test("test_mermaidForFile_doWhileLoopWalksTheBodyFirstThenLoopsBackOnTheCondition", () => {
    // Scenario: a do-while loop runs its body once unconditionally, then loops back to the body's first statement while the condition holds.  Step: call it with a function whose body is a let, a do-while, then a return.
    const source = 'function sum(list: number[]) {\n  let total = 0;\n  do {\n    total = halve(total);\n  } while (total > 100);\n  return total;\n}\n';
    const result = mermaidForFile("w.ts", source);
    // Verify: the body statement box is chained in before the diamond; the diamond's Y choice loops back to that same body box; the N choice falls through to the return.
    assert.equal(
        result,
        'flowchart TD\n' +
        'B_w_ts["w.ts"]\n' +
        'B_return_total["return total"]\n' +
        'B_sum["sum(list: number[])"]\n' +
        'B_total_is_0["let total = 0"]\n' +
        'B_total_is_halve_total["total = halve(total)"]\n' +
        'Q_CHOICE_while_total_greater_than_100_N["total <= 100"]\n' +
        'Q_CHOICE_while_total_greater_than_100_Y["total > 100"]\n' +
        'Q_while_total_greater_than_100{"while (total > 100)"}\n' +
        'B_sum --> B_total_is_0 --> B_total_is_halve_total --> Q_while_total_greater_than_100\n' +
        'Q_while_total_greater_than_100 --> Q_CHOICE_while_total_greater_than_100_Y --> B_total_is_halve_total\n' +
        'Q_while_total_greater_than_100 --> Q_CHOICE_while_total_greater_than_100_N --> B_return_total\n'
    );
});
