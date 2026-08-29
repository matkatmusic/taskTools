// One test per block in steps.json: feed the block its input template, check what it prints against its contract.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { StepConfig, StepConfigEntry } from "../scripts/generateSteps.ts";
import { buildPromptOutputTemplate } from "../scripts/contracts.ts";
import { getTemplateShapeMismatches } from "../scripts/templateShape.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(PROJECT_ROOT, "scripts/steps.json");

type BlockTemplate = { input: unknown; output?: unknown; agentAnswer?: unknown };

function readBlockTemplate(templatePath: string): BlockTemplate {
    const raw = readFileSync(join(PROJECT_ROOT, templatePath), "utf8").replaceAll("{{PROJECT_ROOT}}", PROJECT_ROOT);
    return JSON.parse(raw) as BlockTemplate;
}

// A prompt block prints the canonical prompt shape; any other block prints its template's output.
function getExpectedOutput(entry: StepConfigEntry, template: BlockTemplate): unknown {
    if (entry.producesPrompt) {
        return { ...buildPromptOutputTemplate(entry.box), ...(template.output as Record<string, unknown> | undefined ?? {}) };
    }
    return template.output;
}

// What a block hands on: for a prompt block, the engine's merged payload; otherwise its printed output.
function getHandedOnShape(entry: StepConfigEntry, template: BlockTemplate): unknown {
    return entry.producesPrompt ? { ...(template.input as Record<string, unknown>), ...(template.agentAnswer as Record<string, unknown>) } : template.output;
}

// The block's result is the last line it prints, the same rule the hook uses.
function runBlockScript(scriptPath: string, input: unknown, cwd: string): { commandOutput: string; result: unknown } {
    const spawnResult = spawnSync("node", ["--no-inspect", scriptPath, JSON.stringify(input)], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_LOG: join(cwd, "step-templates-run-log.json") },
    });
    const commandOutput = `${spawnResult.stdout ?? ""}${spawnResult.stderr ?? ""}`.trimEnd();
    const lastLine = commandOutput.split("\n").at(-1) ?? "";
    try {
        return { commandOutput, result: JSON.parse(lastLine) };
    } catch {
        return { commandOutput, result: null };
    }
}

// A fixture .git makes git treat that folder as another repo, hiding its setup.sh from every git command.
after(() => {
    for (const pipelineDir of readdirSync(STEPS_DIR)) {
        const cleanupScript = join(STEPS_DIR, pipelineDir, "fixtures/cleanup.sh");
        if (!existsSync(cleanupScript)) continue;
        spawnSync("bash", [cleanupScript], { cwd: dirname(cleanupScript), encoding: "utf8" });
    }
});

// Rebuilds every fixture's disposable .git repo before the tests read it; a .git can never be committed.
const STEPS_DIR = join(PROJECT_ROOT, "scripts/tackle-tasks");
for (const pipelineDir of readdirSync(STEPS_DIR)) {
    const setupScript = join(STEPS_DIR, pipelineDir, "fixtures/setup.sh");
    if (!existsSync(setupScript)) continue;
    const setupResult = spawnSync("bash", [setupScript], { cwd: dirname(setupScript), encoding: "utf8" });
    if (setupResult.status !== 0) {
        throw new Error(`${setupScript} failed:\n${setupResult.stdout ?? ""}${setupResult.stderr ?? ""}`);
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

// next is routing metadata; every receiver discards it, so it is not part of the data contract.
function withoutNext(value: unknown): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const { next: _next, ...rest } = value as Record<string, unknown>;
    return rest;
}

// The edge contract: what a block hands on must cover every key the next block's input template lists.
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
                const mismatches = getTemplateShapeMismatches(withoutNext(acceptedTemplate.input), withoutNext(getHandedOnShape(entry, producedTemplate)));
                assert.deepEqual(mismatches, [], `${targetBox} input does not match what ${entry.box} hands on:\n${mismatches.join("\n")}`);
            });
        }
    }
}

// A prompt block is terminal for its agent; the engine carries the payload, not a next-step line.
for (const [diagramFile, entries] of Object.entries(config)) {
    for (const entry of entries) {
        if (!entry.producesPrompt) {
            continue;
        }
        test(`test_stepTemplate_${diagramFile.replace(".mmd", "")}_${entry.box}_promptHasNoContinuationInstructions`, () => {
            const template = readBlockTemplate(entry.template);
            const { commandOutput, result } = runBlockScript(join(PROJECT_ROOT, entry.script), template.input, PROJECT_ROOT);
            assert.notEqual(result, null, `${entry.box} printed no result object:\n${commandOutput}`);
            const prompt = String((result as Record<string, unknown>).prompt);
            assert.doesNotMatch(prompt, /\/run-step|invoke the skill/i);
        });
    }
}

// A block script picks its own branch, so every next: "X" literal it can print must be a declared edge.
const allowedNextByScript = new Map<string, { box: string; allowedNext: Set<string> }>();
for (const entries of Object.values(config)) {
    for (const entry of entries) {
        const existing = allowedNextByScript.get(entry.script) ?? { box: entry.box, allowedNext: new Set<string>() };
        for (const target of entry.next) {
            existing.allowedNext.add(target);
        }
        allowedNextByScript.set(entry.script, existing);
    }
}
for (const [scriptPath, { box, allowedNext }] of allowedNextByScript) {
    test(`test_stepTemplate_${box}_everyNextLiteralIsADeclaredEdge`, () => {
        const source = readFileSync(join(PROJECT_ROOT, scriptPath), "utf8");
        const literalNextValues = [...source.matchAll(/next:\s*"([\w.:-]+)"/g)].map(match => match[1]!);
        for (const value of literalNextValues) {
            assert.ok(allowedNext.has(value), `${scriptPath} returns next: "${value}", not one of ${[...allowedNext].join(", ")}`);
        }
    });
}

// A block after a prompt block inherits that block's packet, which still holds the next that routed into it.
// Source-only check: running these blocks would commit real repositories.
const boxesAfterAPromptBlock = new Map<string, string>();
for (const entries of Object.values(config)) {
    for (const entry of entries) {
        if (!entry.producesPrompt) continue;
        for (const target of entry.next) {
            const targetBox = target.slice(target.indexOf("::") + 2);
            for (const candidates of Object.values(config)) {
                for (const candidate of candidates) {
                    if (candidate.box === targetBox) boxesAfterAPromptBlock.set(candidate.script, candidate.box);
                }
            }
        }
    }
}
for (const [scriptPath, box] of boxesAfterAPromptBlock) {
    test(`test_stepTemplate_${box}_neverHandsOnAStaleNext`, () => {
        const source = readFileSync(join(PROJECT_ROOT, scriptPath), "utf8");
        const spreadsItsInput = /\.\.\.(packet|core)\b/.test(source);
        const dropsInheritedNext = /next:\s*_next/.test(source);
        const writesItsOwnNext = /next:\s*"/.test(source);
        assert.ok(!spreadsItsInput || dropsInheritedNext || writesItsOwnNext,
            `${scriptPath} follows a prompt block and spreads its input without dropping next; the walker will reject the inherited value`);
    });
}
