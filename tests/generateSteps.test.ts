import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSteps, getBoxesInDiagram, getEdgesInDiagram, resolveDiagramFolderSetting } from "../scripts/tackle-tasks/generateSteps.ts";
import type { StepConfigEntry } from "../scripts/tackle-tasks/generateSteps.ts";
import { skillBody } from "../scripts/tackle-tasks/shared/SkillBodyEmitter.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Every fixture diagram here is never named "start", so a fixture's own config value is always an entry array.
type NarrowConfig = Record<string, StepConfigEntry[]>;
function narrow(config: Record<string, StepConfigEntry[] | string>): NarrowConfig {
    return config as NarrowConfig;
}

// Builds a diagram folder from {fileName: contents} and generates against it.
function generateFrom(diagrams: Record<string, string>) {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramFolder = join(folder, "diagrams");
    const stepsRoot = join(folder, "steps");
    const configPath = join(folder, "steps.json");
    mkdirSync(diagramFolder);
    // A stub imports SCRIPT_SIGNAL from two folders up plus shared/, so the throwaway project needs those files too.
    mkdirSync(join(folder, "shared"));
    copyFileSync(join(PROJECT_ROOT, "scripts/shared/contracts.ts"), join(folder, "shared", "contracts.ts"));
    copyFileSync(join(PROJECT_ROOT, "scripts/shared/templateShape.ts"), join(folder, "shared", "templateShape.ts"));
    for (const [name, contents] of Object.entries(diagrams)) writeFileSync(join(diagramFolder, name), contents);
    const run = () => narrow(generateSteps(diagramFolder, stepsRoot, configPath));
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
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n    B --> C\n", "two.mmd": "flowchart TD\n    C --> D\n" });
    assert.deepEqual(Object.keys(config).sort(), ["one.mmd", "start", "two.mmd"]);
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["A", "B"]);
});

test("test_generateSteps_ignoresAFileThatIsNotADiagram", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "notes.md": "# not a diagram\n" });
    assert.deepEqual(Object.keys(config).sort(), ["one.mmd", "start"]);
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

// RETIRED (task 220): asserted assertNoOrphanBoxScripts's throw; that check is retired.
// test("test_generateSteps_throwsWhenADroppedBoxesStubIsStillOnDisk", () => {
//     const { diagramFolder, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> GONE\n" });
//     writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
//     assert.throws(run, /one\/GONE\.ts is named by no diagram/);
// });

test("test_generateSteps_writesTheConfigAsBoxAndScriptPairs", () => {
    const { readConfig } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.deepEqual(Object.keys(readConfig()["one.mmd"][0]), ["box", "script", "template", "producesPrompt", "next"]);
});

test("test_generateSteps_reportsOneDeadLinkWithDiagramBlockAndTarget", () => {
    // b.mmd draws only B and C; a.mmd's signpost names a box, GHOST, that b.mmd never draws.
    const { diagramFolder, run } = generateFrom({
        "a.mmd": "flowchart TD\n    A --> B\n",
        "b.mmd": "flowchart TD\n    B --> C\n",
    });
    writeFileSync(join(diagramFolder, "a.mmd"), "flowchart TD\n    A --> SIGNPOST\n    SIGNPOST[\"signpost<br/>block:b.mmd::GHOST\"]\n");
    assert.throws(run, /a\.mmd::A -> b\.mmd::GHOST/);
});

test("test_generateSteps_reportsBothDeadLinksInOneError", () => {
    // Two signposts, each naming a box its target diagram never draws; one Error must list both.
    const { diagramFolder, run } = generateFrom({
        "a.mmd": "flowchart TD\n    A --> B\n",
        "b.mmd": "flowchart TD\n    B --> C\n",
    });
    writeFileSync(
        join(diagramFolder, "a.mmd"),
        "flowchart TD\n    A --> SIGNPOST1\n    A --> SIGNPOST2\n    SIGNPOST1[\"one<br/>block:b.mmd::GHOST1\"]\n    SIGNPOST2[\"two<br/>block:b.mmd::GHOST2\"]\n",
    );
    assert.throws(run, (error: Error) => {
        assert.match(error.message, /a\.mmd::A -> b\.mmd::GHOST1/);
        assert.match(error.message, /a\.mmd::A -> b\.mmd::GHOST2/);
        return true;
    });
});

test("test_generateSteps_realPreambleHasNoDeadLinkKeepsExistingScriptsAndStubsTheNewOnes", () => {
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-preamble-dead-link-")), "steps.json");
    const config = narrow(generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false));
    const preambleBoxes = config["pipeline-preambleStatusCheck.mmd"]!.map(entry => entry.box);
    assert.ok(preambleBoxes.includes("Q_PREAMBLE_STATUS_CHECK"));
    assert.ok(preambleBoxes.includes("B_LOCK_STAGING_FOR_CATCH_UP"));
});

test("test_generateSteps_startIsTheNewPreamblesStartBlock", () => {
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-preamble-start-")), "steps.json");
    const config = generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false);
    assert.equal(config.start, "pipeline-preambleStatusCheck.mmd::Q_PREAMBLE_STATUS_CHECK");
});

test("test_getEdgesInDiagram_recordsWhatEachBoxPointsAt", () => {
    assert.deepEqual(getEdgesInDiagram("flowchart TD\n    A --> B --> C\n").next, { A: ["B"], B: ["C"], C: [] });
});

test("test_getEdgesInDiagram_ignoresAnEdgeLabel", () => {
    assert.deepEqual(getEdgesInDiagram("flowchart TD\n    A -->|yes| B\n").next, { A: ["B"], B: [] });
});

test("test_getEdgesInDiagram_anInvisibleLinkMakesNoBoxAndNoEdge", () => {
    const edges = getEdgesInDiagram("flowchart TD\n    A --> B\n    main ~~~ B\n");
    assert.deepEqual(edges.boxes, ["A", "B"]);
    assert.deepEqual(edges.next, { A: ["B"], B: [] });
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

// RETIRED (task 224): mutating flag is retired; shared/taskRunState.ts owns run-once now.
// test("test_generateSteps_keepsAHandWrittenMutatingFlag", () => {
//     const { config, configPath, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
//     config["one.mmd"]![1]!.mutating = true;
//     writeFileSync(configPath, JSON.stringify(config, null, 4));
//     assert.equal(run()["one.mmd"]![1]!.mutating, true);
// });

// RETIRED (task 220): asserted assertNoOrphanBoxScripts's throw; that check is retired.
// test("test_generateSteps_throwsWhenARenamedBoxesOldStubIsStillOnDisk", () => {
//     const { diagramFolder, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
//     writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> C\n");
//     assert.throws(run, /one\/B\.ts is named by no diagram/);
// });

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

// B has no outgoing arrow in one.mmd but has one in two.mmd, so A's arrow into it crosses diagrams.
test("test_generateSteps_seedsANewInputTemplateAcrossDiagrams", () => {
    const { config, stepsRoot } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "two.mmd": "flowchart TD\n    B --> C\n" });
    assert.deepEqual(config["one.mmd"]![0]!.next, ["two.mmd::B"]);
    const bTemplate = JSON.parse(readFileSync(join(stepsRoot, "one/B.template.json"), "utf8"));
    const aTemplate = JSON.parse(readFileSync(join(stepsRoot, "one/A.template.json"), "utf8"));
    assert.deepEqual(bTemplate.input, aTemplate.output);
});

test("test_generateSteps_rewritesAnArrowIntoABoxWithArrowsInAnotherDiagram", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n    A --> X\n", "two.mmd": "flowchart TD\n    X --> B\n    B --> C\n" });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["two.mmd::B", "two.mmd::X"]);
});

test("test_generateSteps_writesNoEntryForABoxThatOnlyPointsIntoAnotherDiagram", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "two.mmd": "flowchart TD\n    B --> C\n" });
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["A"]);
    assert.deepEqual(config["two.mmd"]!.map(entry => entry.box), ["B", "C"]);
});

test("test_generateSteps_leavesArrowBareWhenTargetHasItsOwnOutgoingArrow", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n    B --> C\n", "two.mmd": "flowchart TD\n    B --> D\n    D --> B\n" });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["B"]);
});

test("test_generateSteps_leavesArrowBareWhenTargetHasNoArrowsAnywhere", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> DEAD_END\n    A --> X\n", "two.mmd": "flowchart TD\n    X --> DEAD_END\n" });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["DEAD_END", "two.mmd::X"]);
});

test("test_generateSteps_sharesOneScriptForABoxTwoDiagramsBothDraw", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    SHARED --> B\n", "two.mmd": "flowchart TD\n    SHARED --> C\n    C --> SHARED\n" });
    const oneEntry = config["one.mmd"]!.find(entry => entry.box === "SHARED")!;
    const twoEntry = config["two.mmd"]!.find(entry => entry.box === "SHARED")!;
    assert.equal(oneEntry.script, twoEntry.script);
    assert.equal(oneEntry.template, twoEntry.template);
});

// RETIRED (task 220): asserted assertNoOrphanBoxScripts's throw; that check is retired.
// test("test_generateSteps_throwsOnAnOrphanBoxScript", () => {
//     const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
//     writeFileSync(join(stepsRoot, "one/GHOST.ts"), "// stray\n");
//     assert.throws(() => run(), (error: Error) => error.message.includes("GHOST.ts") && error.message.includes("is named by no diagram"));
// });

// RETIRED (task 220): asserted assertNoOrphanBoxScripts's throw; that check is retired.
// test("test_generateSteps_throwsOnAStubOutsideItsOwnerFolder", () => {
//     const { stepsRoot, run } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n", "two.mmd": "flowchart TD\n    C --> D\n" });
//     mkdirSync(join(stepsRoot, "two"), { recursive: true });
//     writeFileSync(join(stepsRoot, "two/A.ts"), "// moved by hand\n");
//     assert.throws(() => run(), (error: Error) => error.message.includes("two/A.ts belongs in one/"));
// });

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

test("test_resolveDiagramFolderSetting_defaultsToTheRealPipelineWhenNoSettingsFile", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "diagram-folder-setting-"));
    const setting = resolveDiagramFolderSetting(fixtureRoot, false, "");
    assert.deepEqual(setting, {
        diagramFolder: join(PROJECT_ROOT, "diagrams/tackle-tasks"),
        stepsRoot: join(PROJECT_ROOT, "scripts/tackle-tasks"),
        allowStubs: true,
    });
});

test("test_resolveDiagramFolderSetting_fastPicksTheFastPipelineWhenThereIsNoSettingsFile", () => {
    // Step: the fast flag alone picks the built-in fast diagram folder.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "diagram-folder-setting-fast-"));
    assert.deepEqual(resolveDiagramFolderSetting(fixtureRoot, true, ""), {
        diagramFolder: join(PROJECT_ROOT, "diagrams/tackle-tasks-fast"),
        stepsRoot: join(PROJECT_ROOT, "scripts/tackle-tasks"),
        allowStubs: true,
    });
});

test("test_resolveDiagramFolderSetting_fastWinsOverACustomDiagramFolderInSettings", () => {
    // Setup: a project that customizes its normal pipeline through .taskTools/settings.json.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "diagram-folder-setting-fast-custom-"));
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    const diagramFolder = join(fixtureRoot, "diagrams");
    mkdirSync(diagramFolder, { recursive: true });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
    writeFileSync(join(fixtureRoot, ".taskTools/settings.json"), JSON.stringify({ diagramFolder }));

    // Test action: the same project asks for a fast run.
    const setting = resolveDiagramFolderSetting(fixtureRoot, true, "");

    // Verification: the custom folder is left out; fast is one pipeline for every project.
    assert.deepEqual(setting, {
        diagramFolder: join(PROJECT_ROOT, "diagrams/tackle-tasks-fast"),
        stepsRoot: join(PROJECT_ROOT, "scripts/tackle-tasks"),
        allowStubs: true,
    });
});

// RETIRED (task 222): the fast diagram folder has many start boxes; it will be redone later.
// test("test_generateSteps_generatesTheFourteenFastDiagrams", () => {
//     // Step: the fast folder generates against the real block scripts, with no stub allowed.
//     const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-fast-")), "steps.json");
//     const config = generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks-fast"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false);
//     assert.equal(Object.keys(config).length, 14);
//     assert.ok(Object.keys(config).includes("pipeline-mergeSucceededExit.mmd"));
//     assert.ok(!Object.keys(config).includes("pipeline-codexReviewsPlan.mmd"));
// });

// RETIRED (task 222): the fast diagram folder has many start boxes; it will be redone later.
// test("test_generateSteps_addsTheFastNextBlockOverrideOnAreTaskTestsSkipped", () => {
//     // Step: the fast pipeline leaves out the per-task test loop through one nextBlock override.
//     const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-fast-override-")), "steps.json");
//     const config = generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks-fast"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false);
//     const entry = config["pipeline-commitImplementationIfNeeded.mmd"]!.find(candidate => candidate.box === "ARE_TASK_TESTS_SKIPPED_Q")!;
//     assert.equal(entry.nextBlock, "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO");
// });

test("test_generateSteps_leavesTheFastNextBlockOverrideOffTheDefaultDiagramFolder", () => {
    // Step: the default pipeline keeps its per-task test loop.
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-default-override-")), "steps.json");
    const config = narrow(generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false));
    const entry = config["pipeline-commitImplementationIfNeeded.mmd"]!.find(candidate => candidate.box === "ARE_TASK_TESTS_SKIPPED_Q")!;
    assert.equal(entry.nextBlock, undefined);
});

test("test_generateSteps_defaultDoesNotWriteToDiagramFolder", () => {
    // Setup: a previous config that disagrees with the diagram, which already carries the takesSourceLock label.
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-no-sync-")), "steps.json");
    writeFileSync(tempConfigPath, JSON.stringify({
        "pipeline-lockSourceRepo.mmd": [
            { box: "LOCK_SOURCE_REPO", script: "scripts/tackle-tasks/lockSourceRepo/LOCK_SOURCE_REPO.ts", template: "scripts/tackle-tasks/lockSourceRepo/LOCK_SOURCE_REPO.template.json", producesPrompt: false, takesSourceLock: false, next: [] },
        ],
    }));
    const realDiagramPath = join(PROJECT_ROOT, "diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd");
    const before = readFileSync(realDiagramPath, "utf8");

    // Test action: regenerate against the real default diagram folder with the default syncDiagramFiles (false).
    generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath);

    // Verification: the real diagram file on disk never changed, even though the config disagreed with it.
    assert.equal(readFileSync(realDiagramPath, "utf8"), before);
});

test("test_resolveDiagramFolderSetting_readsACustomDiagramFolderFromSettings", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "diagram-folder-setting-"));
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    const diagramFolder = join(fixtureRoot, "diagrams");
    mkdirSync(diagramFolder, { recursive: true });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
    writeFileSync(join(fixtureRoot, ".taskTools/settings.json"), JSON.stringify({ diagramFolder }));
    const setting = resolveDiagramFolderSetting(fixtureRoot, false, "");
    assert.deepEqual(setting, { diagramFolder, stepsRoot: diagramFolder, allowStubs: false });
});

test("test_resolveDiagramFolderSetting_throwsWhenTheDiagramFolderDoesNotExist", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "diagram-folder-setting-"));
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    const diagramFolder = join(fixtureRoot, "missing");
    writeFileSync(join(fixtureRoot, ".taskTools/settings.json"), JSON.stringify({ diagramFolder }));
    assert.throws(() => resolveDiagramFolderSetting(fixtureRoot, false, ""), (error: Error) => error.message.includes(diagramFolder));
});

test("test_resolveDiagramFolderSetting_throwsWhenTheDiagramFolderHoldsNoMmd", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "diagram-folder-setting-"));
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    const diagramFolder = join(fixtureRoot, "diagrams");
    mkdirSync(diagramFolder, { recursive: true });
    writeFileSync(join(fixtureRoot, ".taskTools/settings.json"), JSON.stringify({ diagramFolder }));
    assert.throws(() => resolveDiagramFolderSetting(fixtureRoot, false, ""), (error: Error) => error.message.includes(diagramFolder));
});

test("test_resolveDiagramFolderSetting_folderWordWinsOverSettingsJson", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    mkdirSync(join(fixtureRoot, "a"), { recursive: true });
    mkdirSync(join(fixtureRoot, "b"), { recursive: true });
    writeFileSync(join(fixtureRoot, "a", "one.mmd"), "flowchart TD\n    A[\"A\"]\n");
    writeFileSync(join(fixtureRoot, "b", "one.mmd"), "flowchart TD\n    A[\"A\"]\n");
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(fixtureRoot, ".taskTools", "settings.json"), JSON.stringify({ diagramFolder: "a" }));
    const setting = resolveDiagramFolderSetting(fixtureRoot, false, "b");
    assert.equal(setting.diagramFolder, join(fixtureRoot, "b"));
});

test("test_resolveDiagramFolderSetting_folderWordWithNoSettingsJson", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    mkdirSync(join(fixtureRoot, "b"), { recursive: true });
    writeFileSync(join(fixtureRoot, "b", "one.mmd"), "flowchart TD\n    A[\"A\"]\n");
    const setting = resolveDiagramFolderSetting(fixtureRoot, false, "b");
    assert.equal(setting.diagramFolder, join(fixtureRoot, "b"));
});

test("test_resolveDiagramFolderSetting_throwsForAMissingFolder", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    assert.throws(
        () => resolveDiagramFolderSetting(fixtureRoot, false, "missing"),
        (error: Error) => error.message.includes(join(fixtureRoot, "missing")) && error.message.includes("does not exist or holds no .mmd files"),
    );
});

test("test_resolveDiagramFolderSetting_throwsForAnEmptyFolder", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    mkdirSync(join(fixtureRoot, "empty"), { recursive: true });
    assert.throws(
        () => resolveDiagramFolderSetting(fixtureRoot, false, "empty"),
        (error: Error) => error.message.includes(join(fixtureRoot, "empty")) && error.message.includes("does not exist or holds no .mmd files"),
    );
});

test("test_resolveDiagramFolderSetting_throwsWhenFolderWordIsOutsideTheProject", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    assert.throws(
        () => resolveDiagramFolderSetting(fixtureRoot, false, "../other"),
        (error: Error) => error.message.includes(resolve(fixtureRoot, "../other")) && error.message.includes("is outside the project"),
    );
});

test("test_resolveDiagramFolderSetting_throwsForAnAbsolutePathOutsideTheProject", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    assert.throws(
        () => resolveDiagramFolderSetting(fixtureRoot, false, "/etc"),
        (error: Error) => error.message.includes("/etc") && error.message.includes("is outside the project"),
    );
});

test("test_resolveDiagramFolderSetting_throwsWhenSettingsJsonDiagramFolderIsOutsideTheProject", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(fixtureRoot, ".taskTools", "settings.json"), JSON.stringify({ diagramFolder: "../other" }));
    assert.throws(
        () => resolveDiagramFolderSetting(fixtureRoot, false, ""),
        (error: Error) => error.message.includes(resolve(fixtureRoot, "../other")) && error.message.includes("is outside the project"),
    );
});

// Regression guard: default branch (no folder word or settings.json) must keep writing to the plugin's scripts/tackle-tasks.
test("test_generateSteps_writesToTheFoldersOwnStepsJson", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "resolve-folder-"));
    const setting = resolveDiagramFolderSetting(fixtureRoot, false, "");
    assert.deepEqual(setting, {
        diagramFolder: join(PROJECT_ROOT, "diagrams/tackle-tasks"),
        stepsRoot: join(PROJECT_ROOT, "scripts/tackle-tasks"),
        allowStubs: true,
    });
});

test("test_generateSteps_throwsOnAMissingScriptWhenStubsAreNotAllowed", () => {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramFolder = join(folder, "diagrams");
    const stepsRoot = join(folder, "steps");
    const configPath = join(folder, "steps.json");
    mkdirSync(diagramFolder, { recursive: true });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
    assert.throws(() => generateSteps(diagramFolder, stepsRoot, configPath, false), /A\.ts is missing/);
});

test("test_generateSteps_usesAuthoredScriptsInACustomFolderWithoutThrowing", () => {
    const folder = mkdtempSync(join(tmpdir(), "generate-steps-"));
    const diagramFolder = join(folder, "diagrams");
    const configPath = join(folder, "steps.json");
    mkdirSync(diagramFolder, { recursive: true });
    writeFileSync(join(diagramFolder, "one.mmd"), "flowchart TD\n    A --> B\n");
    mkdirSync(join(diagramFolder, "one"), { recursive: true });
    writeFileSync(join(diagramFolder, "one/A.ts"), "// authored\n");
    writeFileSync(join(diagramFolder, "one/A.template.json"), `{"input":{},"output":{"box":"A"}}`);
    writeFileSync(join(diagramFolder, "one/B.ts"), "// authored\n");
    writeFileSync(join(diagramFolder, "one/B.template.json"), `{"input":{},"output":{"box":"B"}}`);
    assert.doesNotThrow(() => generateSteps(diagramFolder, diagramFolder, configPath, false));
    assert.equal(readFileSync(join(diagramFolder, "one/A.ts"), "utf8"), "// authored\n");
});

test("test_tackleTasks_walksACustomDiagramFoldersBlocksAndNoneOfTheDefaultPipeline", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tackle-tasks-custom-"));
    mkdirSync(join(fixtureRoot, ".taskTools"), { recursive: true });
    writeFileSync(join(fixtureRoot, ".taskTools/tasks.json"), JSON.stringify([{ taskNumber: 999999, difficulty: 1 }]));
    const diagramFolder = join(fixtureRoot, "diagrams");
    mkdirSync(diagramFolder, { recursive: true });
    writeFileSync(join(fixtureRoot, ".taskTools/settings.json"), JSON.stringify({ diagramFolder }));
    writeFileSync(
        join(diagramFolder, "pipeline-preambleStatusCheck.mmd"),
        "flowchart TD\n    Q_PREAMBLE_STATUS_CHECK --> SECOND_BOX\n",
    );

    const preambleFolder = join(diagramFolder, "preambleStatusCheck");
    mkdirSync(preambleFolder, { recursive: true });
    writeFileSync(
        join(preambleFolder, "preambleStatusCheck.ts"),
        `console.log(JSON.stringify({ box: "Q_PREAMBLE_STATUS_CHECK", scriptSignal: "continue", note: "preambleStatusCheck.ts for Q_PREAMBLE_STATUS_CHECK", input: "" }));\n`,
    );
    writeFileSync(
        join(preambleFolder, "preambleStatusCheck.template.json"),
        `${JSON.stringify({ input: {}, output: { box: "Q_PREAMBLE_STATUS_CHECK", scriptSignal: "continue", note: "preambleStatusCheck.ts for Q_PREAMBLE_STATUS_CHECK", input: "" } }, null, 4)}\n`,
    );

    const secondBoxFolder = join(diagramFolder, "pipeline-preambleStatusCheck");
    mkdirSync(secondBoxFolder, { recursive: true });
    writeFileSync(
        join(secondBoxFolder, "SECOND_BOX.ts"),
        `console.log(JSON.stringify({ box: "SECOND_BOX", scriptSignal: "stop", note: "SECOND_BOX.ts for SECOND_BOX", input: "" }));\n`,
    );
    writeFileSync(
        join(secondBoxFolder, "SECOND_BOX.template.json"),
        `${JSON.stringify({ input: {}, output: { box: "SECOND_BOX", scriptSignal: "stop", note: "SECOND_BOX.ts for SECOND_BOX", input: "" } }, null, 4)}\n`,
    );

    const stepsConfigPath = join(fixtureRoot, ".taskTools/workflows/999999/steps.json");
    skillBody("999999", fixtureRoot);

    const runLogPath = join(fixtureRoot, "run-log.json");
    const command = `/run-step pipeline-preambleStatusCheck.mmd::Q_PREAMBLE_STATUS_CHECK ${JSON.stringify({ taskNumber: 999999, tasksFile: join(fixtureRoot, ".taskTools/tasks.json") })}`;
    execFileSync("node", ["--no-inspect", join(PROJECT_ROOT, "scripts/hooks/runStepHook.ts")], {
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "SubagentStart", prompt: command }),
        env: { ...process.env, RUN_STEP_CONFIG: stepsConfigPath, RUN_STEP_LOG: runLogPath },
    });

    const runLog = JSON.parse(readFileSync(runLogPath, "utf8")) as Array<{ block: string }>;
    assert.deepEqual(runLog.map(entry => entry.block), [
        "pipeline-preambleStatusCheck.mmd::Q_PREAMBLE_STATUS_CHECK",
        "pipeline-preambleStatusCheck.mmd::SECOND_BOX",
    ]);
});

// A stale committed steps.json fails here; npm run steps regenerates it.
test("test_generateSteps_theCommittedStepsJsonIsUpToDate", () => {
    const committedStepsJsonPath = join(PROJECT_ROOT, "scripts/tackle-tasks/diagram-steps.json");
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-committed-")), "steps.json");
    // Seeds the previous-config read so hand-written `mutating: true` flags carry forward.
    copyFileSync(committedStepsJsonPath, tempConfigPath);
    generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false);
    assert.equal(readFileSync(tempConfigPath, "utf8"), readFileSync(committedStepsJsonPath, "utf8"));
});

// The override is keyed by the full diagram-entry identifier, generated only for the repo's own default diagram folder.
test("test_generateSteps_addsANextBlockOverrideOnThePreamblesFirstBlock", () => {
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-next-block-")), "steps.json");
    const config = narrow(generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false));
    const preambleEntry = config["pipeline-preambleStatusCheck.mmd"]!.find(candidate => candidate.box === "PREAMBLE_STATUS_CHECK")!;
    assert.equal(preambleEntry.nextBlock, "IS_TASK_BLOCKED_Q");
});

// A synthetic diagram with the same file and box name, outside the default folder, skips the nextBlock override.
test("test_generateSteps_leavesTheNextBlockOverrideOffOutsideTheDefaultDiagramFolder", () => {
    const { config } = generateFrom({ "pipeline-preambleStatusCheck.mmd": "flowchart TD\n    PREAMBLE_STATUS_CHECK --> SECOND_BOX\n" });
    const preambleEntry = config["pipeline-preambleStatusCheck.mmd"]!.find(candidate => candidate.box === "PREAMBLE_STATUS_CHECK")!;
    assert.equal(preambleEntry.nextBlock, undefined);
});

// The nextBlock override's translator is identity, generated only for the repo's own default diagram folder.
test("test_generateSteps_addsATranslatorOverrideOnThePreamblesFirstBlock", () => {
    const tempConfigPath = join(mkdtempSync(join(tmpdir(), "generate-steps-translator-")), "steps.json");
    const config = narrow(generateSteps(join(PROJECT_ROOT, "diagrams/tackle-tasks"), join(PROJECT_ROOT, "scripts/tackle-tasks"), tempConfigPath, false));
    const preambleEntry = config["pipeline-preambleStatusCheck.mmd"]!.find(candidate => candidate.box === "PREAMBLE_STATUS_CHECK")!;
    assert.equal(preambleEntry.translator, "scripts/tackle-tasks/shared/identityTranslator.ts");
});

// A synthetic diagram with the same file and box name, outside the default folder, skips the translator override.
test("test_generateSteps_leavesTheTranslatorOverrideOffOutsideTheDefaultDiagramFolder", () => {
    const { config } = generateFrom({ "pipeline-preambleStatusCheck.mmd": "flowchart TD\n    PREAMBLE_STATUS_CHECK --> SECOND_BOX\n" });
    const preambleEntry = config["pipeline-preambleStatusCheck.mmd"]!.find(candidate => candidate.box === "PREAMBLE_STATUS_CHECK")!;
    assert.equal(preambleEntry.translator, undefined);
});

test("test_generateSteps_foldsAQChoiceTargetIntoTheDecisionsNext", () => {
    const { config, stepsRoot } = generateFrom({
        "one.mmd": "flowchart TD\n    Q_DECISION --> Q_CHOICE_DECISION_Y\n    Q_CHOICE_DECISION_Y --> B_YES\n    Q_DECISION --> Q_CHOICE_DECISION_N\n    Q_CHOICE_DECISION_N --> B_NO\n",
    });
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["Q_DECISION", "B_YES", "B_NO"]);
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "Q_DECISION")!.next, ["B_YES", "B_NO"]);
    assert.equal(existsSync(join(stepsRoot, "one/Q_CHOICE_DECISION_Y.ts")), false);
    assert.equal(existsSync(join(stepsRoot, "one/Q_CHOICE_DECISION_Y.template.json")), false);
    assert.equal(existsSync(join(stepsRoot, "one/Q_CHOICE_DECISION_N.ts")), false);
    assert.equal(existsSync(join(stepsRoot, "one/Q_CHOICE_DECISION_N.template.json")), false);
});

test("test_generateSteps_keepsThePrefixInTheBoxName", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    B_LOCK_SOURCE_REPO --> B_NEXT\n" });
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["B_LOCK_SOURCE_REPO", "B_NEXT"]);
});

test("test_generateSteps_stillParsesAPlainIdDiagram", () => {
    const { config } = generateFrom({ "one.mmd": "flowchart TD\n    A --> B\n" });
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["A", "B"]);
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["B"]);
});

test("test_generateSteps_treatsABlockLabelAsASignpost", () => {
    const { config, stepsRoot } = generateFrom({
        "one.mmd": "flowchart TD\n    B_SIGNPOST[\"SIGNPOST<br/>block:two.mmd::TARGET\"]\n    A --> B\n",
    });
    assert.deepEqual(config["one.mmd"]!.map(entry => entry.box), ["A", "B"]);
    assert.equal(existsSync(join(stepsRoot, "one/B_SIGNPOST.ts")), false);
    assert.equal(existsSync(join(stepsRoot, "one/B_SIGNPOST.template.json")), false);
});

test("test_generateSteps_pointsAnArrowIntoASignpostAtItsCrossDiagramTarget", () => {
    const { config } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B_SIGNPOST\n    B_SIGNPOST[\"SIGNPOST<br/>block:two.mmd::TARGET\"]\n",
    });
    assert.deepEqual(config["one.mmd"]!.find(entry => entry.box === "A")!.next, ["two.mmd::TARGET"]);
});

test("test_generateSteps_readsAFileLineAsARepoRootRelativeScript", () => {
    const { config, stepsRoot } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>file:scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.ts\"]\n",
    });
    const entry = config["one.mmd"]!.find(candidate => candidate.box === "A")!;
    assert.equal(entry.script, "scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.ts");
    assert.equal(entry.template, "scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.template.json");
    assert.equal(existsSync(join(stepsRoot, "one/A.ts")), false);
    assert.equal(existsSync(join(stepsRoot, "one/A.template.json")), false);
});

test("test_generateSteps_writesACamelCaseFileLineForANewBlock", () => {
    const { config, run, diagramFolder } = generateFrom({
        "one.mmd": "flowchart TD\n    B_NEW_BLOCK --> B_SECOND\n    B_NEW_BLOCK[\"NEW_BLOCK\"]\n    B_SECOND[\"SECOND\"]\n",
    });
    const entry = config["one.mmd"]!.find(candidate => candidate.box === "B_NEW_BLOCK")!;
    assert.ok(entry.script.endsWith("one/newBlock.ts"));
    const diagram = readFileSync(join(diagramFolder, "one.mmd"), "utf8");
    assert.ok(diagram.includes(`B_NEW_BLOCK["NEW_BLOCK<br/>file:${entry.script}"]`));

    const secondConfig = run();
    assert.deepEqual(secondConfig, config);
    assert.equal(readFileSync(join(diagramFolder, "one.mmd"), "utf8"), diagram);
});

test("test_generateSteps_writesAStubThatThrowsNotImplemented", () => {
    const { stepsRoot } = generateFrom({
        "one.mmd": "flowchart TD\n    B_NEW_BLOCK --> B_SECOND\n    B_NEW_BLOCK[\"NEW_BLOCK\"]\n    B_SECOND[\"SECOND\"]\n",
    });
    assert.throws(
        () => execFileSync("node", ["--no-inspect", join(stepsRoot, "one/newBlock.ts")], { encoding: "utf8" }),
        (error: any) => error.stderr.includes("block B_NEW_BLOCK in one.mmd is not implemented"),
    );
});

test("test_generateSteps_leavesAQChoiceNodeWithNoFileLineUnmodified", () => {
    const { diagramFolder, stepsRoot } = generateFrom({
        "one.mmd": "flowchart TD\n    Q_DECISION --> Q_CHOICE_DECISION_Y\n    Q_CHOICE_DECISION_Y --> B_YES\n    Q_DECISION[\"DECISION\"]\n    Q_CHOICE_DECISION_Y[\"YES\"]\n    B_YES[\"YES_BLOCK\"]\n",
    });
    const diagram = readFileSync(join(diagramFolder, "one.mmd"), "utf8");
    assert.match(diagram, /Q_CHOICE_DECISION_Y\["YES"\]/);
    assert.equal(existsSync(join(stepsRoot, "one/Q_CHOICE_DECISION_Y.ts")), false);
    assert.equal(existsSync(join(stepsRoot, "one/qChoiceDecisionY.ts")), false);
});

test("test_generateSteps_throwsWhenAnEntrysScriptFileIsMissing", () => {
    assert.throws(
        () => generateFrom({
            "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>file:scripts/tackle-tasks/mermaid5MissingScriptFixture/NOPE.ts\"]\n",
        }),
        /does not exist on disk/,
    );
});

test("test_generateSteps_rewritesTheFileLineWhenDiagramStepsJsonScriptDiffers", () => {
    const { config, configPath, diagramFolder, run, readConfig } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>file:scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.ts\"]\n",
    });
    const entry = config["one.mmd"]!.find(candidate => candidate.box === "A")!;
    entry.script = "scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE.ts";
    entry.template = "scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE.template.json";
    writeFileSync(configPath, JSON.stringify(config, null, 4));

    run();
    const diagram = readFileSync(join(diagramFolder, "one.mmd"), "utf8");
    assert.equal(
        diagram,
        "flowchart TD\n    A --> B\n    A[\"A<br/>file:scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE.ts\"]\n",
    );
    const syncedEntry = readConfig()["one.mmd"].find((candidate: { box: string }) => candidate.box === "A")!;
    assert.equal(syncedEntry.script, "scripts/tackle-tasks/preambleStatusCheck/TAKE_WORKTREE_LEASE.ts");
});

test("test_generateSteps_readsATakesSourceLockLabelIntoTheEntry", () => {
    const { config } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B\"]\n",
    });
    const entryA = config["one.mmd"]!.find(candidate => candidate.box === "A")!;
    const entryB = config["one.mmd"]!.find(candidate => candidate.box === "B")!;
    assert.equal(entryA.takesSourceLock, true);
    assert.equal(entryB.takesSourceLock, undefined);
});

test("test_generateSteps_syncsTakesSourceLockBackIntoTheDiagramWhenConfigDiffers", () => {
    const { config, configPath, diagramFolder, run } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A\"]\n    B[\"B\"]\n",
    });
    const entry = config["one.mmd"]!.find(candidate => candidate.box === "A")!;
    entry.takesSourceLock = true;
    writeFileSync(configPath, JSON.stringify(config, null, 4));

    run();
    const diagram = readFileSync(join(diagramFolder, "one.mmd"), "utf8");
    assert.equal(diagram, "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B\"]\n");
});

test("test_generateSteps_movesTheTakesSourceLockLabelWhenTheStepListMovesTheFlag", () => {
    const { config, configPath, diagramFolder, run } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B\"]\n",
    });
    const entryA = config["one.mmd"]!.find(candidate => candidate.box === "A")!;
    const entryB = config["one.mmd"]!.find(candidate => candidate.box === "B")!;
    delete entryA.takesSourceLock;
    entryB.takesSourceLock = true;
    writeFileSync(configPath, JSON.stringify(config, null, 4));

    run();
    const diagram = readFileSync(join(diagramFolder, "one.mmd"), "utf8");
    assert.equal(diagram, "flowchart TD\n    A --> B\n    A[\"A\"]\n    B[\"B<br/>takesSourceLock:true\"]\n");
    const secondConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const syncedA = secondConfig["one.mmd"].find((candidate: { box: string }) => candidate.box === "A")!;
    const syncedB = secondConfig["one.mmd"].find((candidate: { box: string }) => candidate.box === "B")!;
    assert.equal(syncedA.takesSourceLock, undefined);
    assert.equal(syncedB.takesSourceLock, true);
});

test("test_generateSteps_aDiagramOnlyEditToTakesSourceLockLosesToTheStepList", () => {
    const { diagramFolder, configPath, run } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B\"]\n",
    });
    const diagramPath = join(diagramFolder, "one.mmd");
    writeFileSync(diagramPath, "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B<br/>takesSourceLock:true\"]\n");

    run();
    const diagram = readFileSync(diagramPath, "utf8");
    assert.equal(diagram, "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B\"]\n");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const syncedA = config["one.mmd"].find((candidate: { box: string }) => candidate.box === "A")!;
    const syncedB = config["one.mmd"].find((candidate: { box: string }) => candidate.box === "B")!;
    assert.equal(syncedA.takesSourceLock, true);
    assert.equal(syncedB.takesSourceLock, undefined);
});

test("test_generateSteps_leavesTakesSourceLockDiagramByteIdenticalWhenBothSidesAgree", () => {
    const { diagramFolder, run } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>takesSourceLock:true\"]\n    B[\"B\"]\n",
    });
    const diagramPath = join(diagramFolder, "one.mmd");
    const diagram = readFileSync(diagramPath, "utf8");
    run();
    assert.equal(readFileSync(diagramPath, "utf8"), diagram);
});

test("test_generateSteps_leavesTheDiagramByteIdenticalWhenScriptMatchesTheFileLine", () => {
    const { diagramFolder, run } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    A[\"A<br/>file:scripts/tackle-tasks/preambleStatusCheck/CREATE_WORKTREE.ts\"]\n",
    });
    const diagram = readFileSync(join(diagramFolder, "one.mmd"), "utf8");
    run();
    assert.equal(readFileSync(join(diagramFolder, "one.mmd"), "utf8"), diagram);
});

test("test_generateSteps_writesTheStartBlockForTheOneBoxNoArrowPointsAt", () => {
    const { config } = generateFrom({
        "one.mmd": "flowchart TD\n    A --> B\n    B --> C\n",
    });
    assert.equal(config.start, "one.mmd::A");
});

test("test_generateSteps_throwsNamingEveryCandidateWhenMoreThanOneBoxHasNoArrowIntoIt", () => {
    assert.throws(() => {
        generateFrom({
            "one.mmd": "flowchart TD\n    A --> B\n    X --> B\n",
        });
    }, /one\.mmd::A.*one\.mmd::X|one\.mmd::X.*one\.mmd::A/s);
});

test("test_generateSteps_throwsNamingZeroCandidatesWhenEveryBoxHasAnArrowIntoIt", () => {
    assert.throws(() => {
        generateFrom({
            "one.mmd": "flowchart TD\n    A --> B\n    B --> A\n",
        });
    }, /expected exactly one start block, found 0: ?$/);
});
