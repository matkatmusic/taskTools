// One test per block in steps.json: feed the block its input template, check what it prints against its contract.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepConfig, StepConfigEntry } from "../scripts/generateSteps.ts";
import { AGENT_ANSWER_TEMPLATE, buildPromptOutputTemplate } from "../scripts/contracts.ts";
import { getTemplateShapeMismatches } from "../scripts/templateShape.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(PROJECT_ROOT, "scripts/steps.json");

type BlockTemplate = { input: unknown; output?: unknown };

function readBlockTemplate(templatePath: string): BlockTemplate {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, templatePath), "utf8")) as BlockTemplate;
}

// A prompt block prints the canonical prompt shape; any other block prints its template's output.
function getExpectedOutput(entry: StepConfigEntry, template: BlockTemplate): unknown {
    if (entry.producesPrompt) {
        return { ...buildPromptOutputTemplate(entry.box), ...(template.output as Record<string, unknown> | undefined ?? {}) };
    }
    return template.output;
}

// What a block hands to the next block: the agent's answer for a prompt block, its printed output otherwise.
function getHandedOnShape(entry: StepConfigEntry, template: BlockTemplate): unknown {
    return entry.producesPrompt ? AGENT_ANSWER_TEMPLATE : template.output;
}

// The block's result is the last line it prints, the same rule the hook uses.
function runBlockScript(scriptPath: string, input: unknown, cwd: string): { commandOutput: string; result: unknown } {
    const spawnResult = spawnSync("node", ["--no-inspect", scriptPath, JSON.stringify(input)], {
        cwd,
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
        // Mutating blocks write real files; their own test under tests/steps/<diagram>/ covers the contract instead.
        if (entry.mutating) {
            continue;
        }
        test(`test_stepTemplate_${diagramFile.replace(".mmd", "")}_${entry.box}_producesItsOutputContract`, () => {
            const template = readBlockTemplate(entry.template);
            const { commandOutput, result } = runBlockScript(join(PROJECT_ROOT, entry.script), template.input, PROJECT_ROOT);
            assert.notEqual(result, null, `${entry.box} printed no result object:\n${commandOutput}`);
            const mismatches = getTemplateShapeMismatches(getExpectedOutput(entry, template), result);
            assert.deepEqual(mismatches, [], `${entry.box} does not match its contract:\n${mismatches.join("\n")}`);
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
                const mismatches = getTemplateShapeMismatches(acceptedTemplate.input, getHandedOnShape(entry, producedTemplate));
                assert.deepEqual(mismatches, [], `${targetBox} input does not match what ${entry.box} hands on:\n${mismatches.join("\n")}`);
            });
        }
    }
}
