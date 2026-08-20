// One test per block in steps.json: feed the block its input template, check what it prints against its output template.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepConfig } from "../scripts/generateSteps.ts";
import { getTemplateShapeMismatches } from "../scripts/templateShape.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(PROJECT_ROOT, "scripts/steps.json");

type BlockTemplate = { input: unknown; output: unknown };

function readBlockTemplate(templatePath: string): BlockTemplate {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, templatePath), "utf8")) as BlockTemplate;
}

// The block's result is the last line it prints, the same rule the hook uses.
function runBlockScript(scriptPath: string, input: unknown): { commandOutput: string; result: unknown } {
    const spawnResult = spawnSync("node", ["--no-inspect", scriptPath, JSON.stringify(input)], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
    });
    const commandOutput = `${spawnResult.stdout ?? ""}${spawnResult.stderr ?? ""}`.trimEnd();
    const lastLine = commandOutput.split("\n").at(-1) ?? "";
    try {
        return { commandOutput, result: JSON.parse(lastLine) };
    } catch {
        return { commandOutput, result: null };
    }
}

const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StepConfig;

for (const [diagramFile, entries] of Object.entries(config)) {
    for (const entry of entries) {
        test(`test_stepTemplate_${diagramFile.replace(".mmd", "")}_${entry.box}_producesItsOutputTemplate`, () => {
            const template = readBlockTemplate(entry.template);
            const { commandOutput, result } = runBlockScript(entry.script, template.input);
            assert.notEqual(result, null, `${entry.box} printed no result object:\n${commandOutput}`);
            const mismatches = getTemplateShapeMismatches(template.output, result);
            assert.deepEqual(mismatches, [], `${entry.box} does not match ${entry.template}:\n${mismatches.join("\n")}`);
        });
    }
}

// The edge contract: what a block hands on must be exactly what the next block says it takes.
for (const [diagramFile, entries] of Object.entries(config)) {
    for (const entry of entries) {
        for (const target of entry.next) {
            const targetKey = target.includes("::") ? target : `${diagramFile}::${target}`;
            const [targetDiagram = "", targetBox = ""] = targetKey.split("::");
            const targetEntry = config[targetDiagram]?.find(candidate => candidate.box === targetBox);

            test(`test_stepEdge_${entry.box}_to_${targetBox}_agreesOnTheShape`, () => {
                assert.notEqual(targetEntry, undefined, `${targetKey} is not in steps.json`);
                const producedTemplate = readBlockTemplate(entry.template);
                const acceptedTemplate = readBlockTemplate(targetEntry!.template);
                const mismatches = getTemplateShapeMismatches(acceptedTemplate.input, producedTemplate.output);
                assert.deepEqual(mismatches, [], `${targetBox} input does not match ${entry.box} output:\n${mismatches.join("\n")}`);
            });
        }
    }
}
