import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSteps, getBoxesInDiagram, getEdgesInDiagram } from "../scripts/generateSteps.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Builds a diagram folder from {fileName: contents} and generates against it.
function generateFrom(diagrams: Record<string, string>) {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramFolder = join(folder, "diagrams");
    const stepsRoot = join(folder, "steps");
    const configPath = join(folder, "steps.json");
    mkdirSync(diagramFolder);
    // A stub imports SCRIPT_SIGNAL from two folders up, so the throwaway project needs those files too.
    copyFileSync(join(PROJECT_ROOT, "scripts/contracts.ts"), join(folder, "contracts.ts"));
    copyFileSync(join(PROJECT_ROOT, "scripts/templateShape.ts"), join(folder, "templateShape.ts"));
    for (const [name, contents] of Object.entries(diagrams)) writeFileSync(join(diagramFolder, name), contents);
    const run = () => generateSteps(diagramFolder, stepsRoot, configPath);
    return { config: run(), run, diagramFolder, stepsRoot, configPath, readConfig: () => JSON.parse(readFileSync(configPath, "utf8")) };
}

test("test_getBoxesInDiagram_findsBothSidesOfAnArrow", () => {
    assert.deepEqual(getBoxesInDiagram("flowchart TD\n    A[first] --> B[second]\n"), ["A", "B"]);
});

test("test_getBoxesInDiagram_namesABoxOnceWhenItAppearsTwice", () => {
    assert.deepEqual(getBoxesInDiagram("flowchart TD\n    A --> B\n    B --> C\n"), ["A", "B", "C"]);
});

test("test_getBoxesInDiagram_ignoresCommentsAndDiagramKeywords", () => {
    assert.deepEqual(getBoxesInDiagram("%% a note\nflowchart TD\n    direction LR\n    A --> B %% trailing\n"), ["A", "B"]);
});

test("test_getBoxesInDiagram_stripsRoundAndCurlyLabels", () => {
    assert.deepEqual(getBoxesInDiagram("flowchart TD\n    A(round) --> B{diamond}\n"), ["A", "B"]);
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

test("test_generateSteps_writesAStubForABoxWithNoScript", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    NEW_BOX --> B\n" });
    const stub = readFileSync(join(stepsRoot, "one/NEW_BOX.ts"), "utf8");
    assert.match(stub, /export function main\(input: string\): Record<string, unknown>/);
    assert.match(stub, /scriptSignal: SCRIPT_SIGNAL\.CONTINUE/);
    assert.match(stub, /realpathSync\(process\.argv\[1\]!\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)\)/);
});

test("test_generateSteps_writesAStubThatPrintsItsBoxAndSignal", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    NEW_BOX --> B\n" });
    const printed = execFileSync("node", ["--no-inspect", join(stepsRoot, "one/NEW_BOX.ts")], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(printed), { box: "NEW_BOX", scriptSignal: "continue", note: "NEW_BOX.ts for NEW_BOX", input: "" });
});

test("test_generateSteps_leavesAnExistingScriptAlone", () => {
    const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    writeFileSync(join(stepsRoot, "one/A.ts"), "// mine\n");
    run();
    assert.equal(readFileSync(join(stepsRoot, "one/A.ts"), "utf8"), "// mine\n");
});

// The orphan guard replaces the old silent-drop behavior: a box a diagram no longer names throws.
test("test_generateSteps_throwsWhenADroppedBoxesStubIsStillOnDisk", () => {
    const { diagramFolder, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> GONE\n" });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
    assert.throws(run, /one\/GONE\.ts is named by no diagram/);
});

test("test_generateSteps_writesTheConfigAsBoxAndScriptPairs", () => {
    const { readConfig } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.deepEqual(Object.keys(readConfig()["one.mmd"][0]), ["box", "script", "template", "producesPrompt", "next"]);
});

test("test_getEdgesInDiagram_recordsWhatEachBoxPointsAt", () => {
    assert.deepEqual(getEdgesInDiagram("flowchart TD\n    A --> B --> C\n").next, { A: ["B"], B: ["C"], C: [] });
});

test("test_getEdgesInDiagram_ignoresAnEdgeLabel", () => {
    assert.deepEqual(getEdgesInDiagram("flowchart TD\n    A -->|yes| B\n").next, { A: ["B"], B: [] });
});

test("test_getEdgesInDiagram_aDottedArrowMakesNoEdge", () => {
    assert.deepEqual(getEdgesInDiagram("flowchart TD\n    A -.-> B[\"note\"] --> C\n").next, { A: [], B: ["C"], C: [] });
});

// The label sits before the arrow here, and reads as informational only. It is not a box.
test("test_getEdgesInDiagram_ignoresAnEdgeLabelWrittenBeforeTheArrow", () => {
    assert.deepEqual(getEdgesInDiagram(`flowchart TD\n    A -- "exit type: agent-failed<br/>nothing usable" --> B\n`).next, { A: ["B"], B: [] });
});

test("test_getEdgesInDiagram_ignoresAnUnquotedEdgeLabelBeforeTheArrow", () => {
    assert.deepEqual(getEdgesInDiagram("flowchart TD\n    A[first] -- yes --> B[second]\n").next, { A: ["B"], B: [] });
});

test("test_generateSteps_writesTheNextBoxFromTheArrows", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.next), [["B"], []]);
});

test("test_generateSteps_keepsAHandWrittenMutatingFlag", () => {
    const { config, configPath, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    config["one.mmd"]![1]!.mutating = true;
    writeFileSync(configPath, JSON.stringify(config, null, 4));
    assert.equal(run()["one.mmd"]![1]!.mutating, true);
});

// The orphan guard replaces the old silent-drop behavior: a renamed box's stale stub throws.
test("test_generateSteps_throwsWhenARenamedBoxesOldStubIsStillOnDisk", () => {
    const { diagramFolder, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> C\n");
    assert.throws(run, /one\/B\.ts is named by no diagram/);
});

test("test_generateSteps_writesAStubThatReadsItsInputArgument", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    NEW_BOX --> B\n" });
    const printed = execFileSync("node", ["--no-inspect", join(stepsRoot, "one/NEW_BOX.ts"), "the input"], { encoding: "utf8" });
    assert.equal(JSON.parse(printed).input, "the input");
});

test("test_generateSteps_writesATemplateForABoxWithNone", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    NEW_BOX --> B\n" });
    const template = JSON.parse(readFileSync(join(stepsRoot, "one/NEW_BOX.template.json"), "utf8"));
    assert.deepEqual(template, { input: {}, output: { box: "NEW_BOX", scriptSignal: "continue", note: "NEW_BOX.ts for NEW_BOX", input: "" } });
});

test("test_generateSteps_recordsTheTemplatePathBesideTheScript", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.match(config["one.mmd"]![0]!.template, /steps\/one\/A\.template\.json$/);
});

test("test_generateSteps_leavesAnExistingTemplateAlone", () => {
    const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    writeFileSync(join(stepsRoot, "one/A.template.json"), `{"input":{"box":"CALLER"},"output":{"box":"A","signal":"stop"}}`);
    run();
    assert.deepEqual(JSON.parse(readFileSync(join(stepsRoot, "one/A.template.json"), "utf8")).input, { box: "CALLER" });
});

test("test_generateSteps_seedsANewInputTemplateFromThePredecessorsOutput", () => {
    const { stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    const bTemplate = JSON.parse(readFileSync(join(stepsRoot, "one/B.template.json"), "utf8"));
    const aTemplate = JSON.parse(readFileSync(join(stepsRoot, "one/A.template.json"), "utf8"));
    assert.deepEqual(bTemplate.input, aTemplate.output);
});

// B has no outgoing arrow in one.mmd, and is two.mmd's first box, so A's arrow into it crosses diagrams.
test("test_generateSteps_seedsANewInputTemplateAcrossASeam", () => {
    const { config, stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "two.mmd": "flowchart TD\n    B --> C\n" });
    assert.deepEqual(config["one.mmd"]![0]!.next, ["two.mmd::B"]);
    const bTemplate = JSON.parse(readFileSync(join(stepsRoot, "one/B.template.json"), "utf8"));
    const aTemplate = JSON.parse(readFileSync(join(stepsRoot, "one/A.template.json"), "utf8"));
    assert.deepEqual(bTemplate.input, aTemplate.output);
});

test("test_generateSteps_rewritesAnArrowIntoAnotherDiagramsFirstBox", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "two.mmd": "flowchart TD\n    B --> C\n" });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["two.mmd::B"]);
});

test("test_generateSteps_leavesArrowBareWhenTargetHasItsOwnOutgoingArrow", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n    B --> C\n", "two.mmd": "flowchart TD\n    B --> D\n" });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["B"]);
});

test("test_generateSteps_leavesArrowBareWhenTargetIsNoDiagramsFirstBox", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> DEAD_END\n", "two.mmd": "flowchart TD\n    X --> DEAD_END\n" });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["DEAD_END"]);
});

test("test_generateSteps_sharesOneScriptForABoxTwoDiagramsBothDraw", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    SHARED --> B\n", "two.mmd": "flowchart TD\n    SHARED --> C\n" });
    const oneEntry = config["one.mmd"]!.find(entry => entry.box === "SHARED")!;
    const twoEntry = config["two.mmd"]!.find(entry => entry.box === "SHARED")!;
    assert.equal(oneEntry.script, twoEntry.script);
    assert.equal(oneEntry.template, twoEntry.template);
});

test("test_generateSteps_throwsOnAnOrphanBoxScript", () => {
    const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    writeFileSync(join(stepsRoot, "one/GHOST.ts"), "// stray\n");
    assert.throws(() => run(), (error: Error) => error.message.includes("GHOST.ts") && error.message.includes("is named by no diagram"));
});

test("test_generateSteps_doesNotThrowWhenEveryExistingScriptMatchesABox", () => {
    const { run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.doesNotThrow(() => run());
});

test("test_generateSteps_ignoresSharedFolderAndHiddenFilesInTheOrphanGuard", () => {
    const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    mkdirSync(join(stepsRoot, "shared"), { recursive: true });
    writeFileSync(join(stepsRoot, "shared/NOT_A_BOX.ts"), "// helper\n");
    writeFileSync(join(stepsRoot, "one/_packet.ts"), "// packet\n");
    writeFileSync(join(stepsRoot, "one/A.test.ts"), "// test\n");
    assert.doesNotThrow(() => run());
});
