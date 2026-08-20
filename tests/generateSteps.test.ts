import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boxesInDiagram, generateSteps } from "../scripts/generateSteps.ts";

function generateFrom(diagram: string) {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramPath = join(folder, "pipeline.mmd");
    const configPath = join(folder, "steps.json");
    writeFileSync(diagramPath, diagram);
    const stepsDirectory = join(folder, "steps");
    const config = generateSteps(diagramPath, stepsDirectory, configPath);
    return { config, stepsDirectory, diagramPath, configPath, readConfig: () => readFileSync(configPath, "utf8") };
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

test("test_generateSteps_writesOneConfigEntryPerBox", () => {
    const { config } = generateFrom("flowchart TD\n    A --> B\n");
    assert.deepEqual(config.map(entry => entry.box), ["A", "B"]);
    assert.match(config[0]!.script, /steps\/A\.ts$/);
});

test("test_generateSteps_writesAStubForABoxWithNoScript", () => {
    const { stepsDirectory } = generateFrom("flowchart TD\n    NEW_BOX --> B\n");
    assert.match(readFileSync(join(stepsDirectory, "NEW_BOX.ts"), "utf8"), /NEW_BOX has no script yet/);
});

test("test_generateSteps_leavesAnExistingScriptAlone", () => {
    const { stepsDirectory, diagramPath, configPath } = generateFrom("flowchart TD\n    A --> B\n");
    writeFileSync(join(stepsDirectory, "A.ts"), "// mine\n");
    generateSteps(diagramPath, stepsDirectory, configPath);
    assert.equal(readFileSync(join(stepsDirectory, "A.ts"), "utf8"), "// mine\n");
});

test("test_generateSteps_dropsABoxTheDiagramNoLongerNames", () => {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramPath = join(folder, "pipeline.mmd");
    const configPath = join(folder, "steps.json");
    const stepsDirectory = join(folder, "steps");
    writeFileSync(diagramPath, "flowchart TD\n    A --> GONE\n");
    generateSteps(diagramPath, stepsDirectory, configPath);
    writeFileSync(diagramPath, "flowchart TD\n    A --> B\n");
    assert.deepEqual(generateSteps(diagramPath, stepsDirectory, configPath).map(entry => entry.box), ["A", "B"]);
});

test("test_generateSteps_writesTheConfigAsBoxAndScriptPairs", () => {
    const { readConfig } = generateFrom("flowchart TD\n    A --> B\n");
    const parsed = JSON.parse(readConfig());
    assert.deepEqual(Object.keys(parsed[0]), ["box", "script"]);
});
