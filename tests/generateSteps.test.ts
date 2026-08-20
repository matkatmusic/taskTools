import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boxesInDiagram, generateSteps } from "../scripts/generateSteps.ts";

// Builds a diagram folder from {fileName: contents} and generates against it.
function generateFrom(diagrams: Record<string, string>) {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramFolder = join(folder, "diagrams");
    const stepsRoot = join(folder, "steps");
    const configPath = join(folder, "steps.json");
    mkdirSync(diagramFolder);
    for (const [name, contents] of Object.entries(diagrams)) writeFileSync(join(diagramFolder, name), contents);
    const run = () => generateSteps(diagramFolder, stepsRoot, configPath);
    return { config: run(), run, diagramFolder, stepsRoot, readConfig: () => JSON.parse(readFileSync(configPath, "utf8")) };
}

test("test_boxesInDiagram_findsBothSidesOfAnArrow", () => {
    assert.deepEqual(boxesInDiagram("flowchart TD\n    A[first] --> B[second]\n"), ["A", "B"]);
});

test("test_boxesInDiagram_namesABoxOnceWhenItAppearsTwice", () => {
    assert.deepEqual(boxesInDiagram("flowchart TD\n    A --> B\n    B --> C\n"), ["A", "B", "C"]);
});

test("test_boxesInDiagram_ignoresCommentsAndDiagramKeywords", () => {
    assert.deepEqual(boxesInDiagram("%% a note\nflowchart TD\n    direction LR\n    A --> B %% trailing\n"), ["A", "B"]);
});

test("test_boxesInDiagram_stripsRoundAndCurlyLabels", () => {
    assert.deepEqual(boxesInDiagram("flowchart TD\n    A(round) --> B{diamond}\n"), ["A", "B"]);
});

test("test_generateSteps_keysTheConfigByDiagramFileName", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "two.mmd": "flowchart TD\n    C --> D\n" });
    assert.deepEqual(Object.keys(config), ["one.mmd", "two.mmd"]);
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["A", "B"]);
});

test("test_generateSteps_ignoresAFileThatIsNotADiagram", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "notes.md": "# not a diagram\n" });
    assert.deepEqual(Object.keys(config), ["one.mmd"]);
});

test("test_generateSteps_givesEachDiagramItsOwnScriptFolder", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    SHARED --> B\n", "two.mmd": "flowchart TD\n    SHARED --> C\n" });
    assert.match(config["one.mmd"]![0]!.script, /steps\/one\/SHARED\.ts$/);
    assert.match(config["two.mmd"]![0]!.script, /steps\/two\/SHARED\.ts$/);
});

test("test_generateSteps_writesAStubForABoxWithNoScript", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    NEW_BOX --> B\n" });
    const stub = readFileSync(join(stepsRoot, "one/NEW_BOX.ts"), "utf8");
    assert.match(stub, /export function main\(\): void/);
    assert.match(stub, /realpathSync\(process\.argv\[1\]!\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)\) main\(\);/);
});

test("test_generateSteps_writesAStubThatEchoesItsFileNameAndBox", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    NEW_BOX --> B\n" });
    const printed = execFileSync("node", ["--no-inspect", join(stepsRoot, "one/NEW_BOX.ts")], { encoding: "utf8" });
    assert.equal(printed, "NEW_BOX.ts for NEW_BOX\n");
});

test("test_generateSteps_leavesAnExistingScriptAlone", () => {
    const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    writeFileSync(join(stepsRoot, "one/A.ts"), "// mine\n");
    run();
    assert.equal(readFileSync(join(stepsRoot, "one/A.ts"), "utf8"), "// mine\n");
});

test("test_generateSteps_dropsABoxTheDiagramNoLongerNames", () => {
    const { diagramFolder, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> GONE\n" });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
    assert.deepEqual(run()["one.mmd"]!.map(entry => entry.box), ["A", "B"]);
});

test("test_generateSteps_writesTheConfigAsBoxAndScriptPairs", () => {
    const { readConfig } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.deepEqual(Object.keys(readConfig()["one.mmd"][0]), ["box", "script"]);
});
