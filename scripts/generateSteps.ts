// Turns every .mmd in a folder into stub scripts and a box-to-script config.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REGENERATE_DELAY_MS = 50;

// next holds bare box ids for same-diagram arrows and "other.mmd::BOX" for a hand-written seam.
export type StepConfigEntry = { box: string; script: string; template: string; next: string[] };
// Keyed by diagram file name, so two diagrams may name the same box without sharing a script.
export type StepConfig = Record<string, StepConfigEntry[]>;
export type DiagramEdges = { boxes: string[]; next: Record<string, string[]> };
export type BlockTemplate = { input: unknown; output: unknown; agentOutput?: unknown };

const DIAGRAM_KEYWORDS = /^(flowchart|graph|subgraph|end|classDef|class|style|direction|click)\b/;

// A box id ends where its label starts. Mermaid puts an edge label after the arrow or before it.
function getBoxIdFromArrowSide(arrowSide: string): string {
    const withoutLabelAfterArrow = arrowSide.trim().replace(/^\|[^|]*\|/, "").trim();
    const withoutLabelBeforeArrow = withoutLabelAfterArrow.replace(/\s--\s.*$/, "").trim();
    return withoutLabelBeforeArrow.split(/[[({]/)[0]!.trim();
}

// Every box the diagram names, in order, with the boxes each one points at.
export function getEdgesInDiagram(diagram: string): DiagramEdges {
    const boxes: string[] = [];
    const next: Record<string, string[]> = {};
    for (const line of diagram.split("\n")) {
        const statement = line.split("%%")[0]!.trim();
        if (!statement || DIAGRAM_KEYWORDS.test(statement)) {
            continue;
        }
        const boxChain = statement.split("-->").map(getBoxIdFromArrowSide).filter(Boolean);
        for (const [position, box] of boxChain.entries()) {
            if (!boxes.includes(box)) {
                boxes.push(box);
            }
            next[box] ??= [];
            const target = boxChain[position + 1];
            if (target && !next[box]!.includes(target)) {
                next[box]!.push(target);
            }
        }
    }
    return { boxes, next };
}

export function getBoxesInDiagram(diagram: string): string[] {
    return getEdgesInDiagram(diagram).boxes;
}

function buildStubScript(box: string, diagramFile: string): string {
    return `// ${box}, from ${diagramFile}
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNAL } from "../../signal.ts";

export function main(input: string): Record<string, unknown> {
    return { box: "${box}", signal: SIGNAL.CONTINUE, note: \`\${basename(fileURLToPath(import.meta.url))} for ${box}\`, input };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url))) 
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
`;
}

// The seed output matches what buildStubScript prints, so a new block is green before anyone edits it.
function buildStubTemplate(box: string): string {
    const template = {
        input: {},
        output: { box, signal: "continue", note: `${box}.ts for ${box}`, input: "" },
    };
    return `${JSON.stringify(template, null, 4)}\n`;
}

// A new block's input contract is whatever the block before it produces, so copy that rather than guess.
function seedInputTemplatesFromPredecessors(config: StepConfig, newTemplatePaths: Set<string>): void {
    const outputByStepKey = new Map<string, unknown>();
    for (const [diagramFile, entries] of Object.entries(config)) {
        for (const entry of entries) {
            const template = JSON.parse(readFileSync(join(PROJECT_ROOT, entry.template), "utf8")) as BlockTemplate;
            outputByStepKey.set(`${diagramFile}::${entry.box}`, template.output);
        }
    }
    for (const [diagramFile, entries] of Object.entries(config)) {
        for (const entry of entries) {
            for (const target of entry.next) {
                const targetKey = target.includes("::") ? target : `${diagramFile}::${target}`;
                const targetPath = getTemplatePathForStepKey(config, targetKey);
                if (!targetPath || !newTemplatePaths.has(targetPath)) {
                    continue;
                }
                const targetFile = join(PROJECT_ROOT, targetPath);
                const targetTemplate = JSON.parse(readFileSync(targetFile, "utf8")) as BlockTemplate;
                targetTemplate.input = outputByStepKey.get(`${diagramFile}::${entry.box}`);
                writeFileSync(targetFile, `${JSON.stringify(targetTemplate, null, 4)}\n`);
            }
        }
    }
}

function getTemplatePathForStepKey(config: StepConfig, stepKey: string): string | undefined {
    const [diagramFile = "", box = ""] = stepKey.split("::");
    return config[diagramFile]?.find(entry => entry.box === box)?.template;
}

// A seam into another diagram is hand-written, so regenerating from the arrows must not drop it.
function getSeamsFromPreviousConfig(configPath: string): Record<string, string[]> {
    if (!existsSync(configPath)) {
        return {};
    }
    const previousConfig = JSON.parse(readFileSync(configPath, "utf8")) as StepConfig;
    const seamsByStepKey: Record<string, string[]> = {};
    for (const [diagramFile, entries] of Object.entries(previousConfig)) {
        for (const entry of entries) {
            seamsByStepKey[`${diagramFile}::${entry.box}`] = entry.next.filter(target => target.includes("::"));
        }
    }
    return seamsByStepKey;
}

// A leading underscore marks a spec diagram: it is drawn and served, but never generated from.
function getDiagramFileNames(diagramFolder: string): string[] {
    return readdirSync(diagramFolder).filter(name => name.endsWith(".mmd") && !name.startsWith("_")).sort();
}

export function generateSteps(diagramFolder: string, stepsRoot: string, configPath: string): StepConfig {
    const seamsByStepKey = getSeamsFromPreviousConfig(configPath);
    const newTemplatePaths = new Set<string>();
    const config: StepConfig = {};
    for (const diagramFile of getDiagramFileNames(diagramFolder)) {
        const stepsDirectory = join(stepsRoot, basename(diagramFile, ".mmd"));
        mkdirSync(stepsDirectory, { recursive: true });
        const { boxes, next } = getEdgesInDiagram(readFileSync(join(diagramFolder, diagramFile), "utf8"));
        const entries: StepConfigEntry[] = [];
        for (const box of boxes) {
            const scriptPath = join(stepsDirectory, `${box}.ts`);
            const templatePath = join(stepsDirectory, `${box}.template.json`);
            // An existing file is the author's, so only a missing one gets written.
            if (!existsSync(scriptPath)) {
                writeFileSync(scriptPath, buildStubScript(box, diagramFile));
            }
            if (!existsSync(templatePath)) {
                writeFileSync(templatePath, buildStubTemplate(box));
                newTemplatePaths.add(relative(PROJECT_ROOT, templatePath));
            }
            const seams = seamsByStepKey[`${diagramFile}::${box}`] ?? [];
            entries.push({
                box,
                script: relative(PROJECT_ROOT, scriptPath),
                template: relative(PROJECT_ROOT, templatePath),
                next: [...next[box]!, ...seams],
            });
        }
        config[diagramFile] = entries;
    }
    seedInputTemplatesFromPredecessors(config, newTemplatePaths);
    writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`);
    return config;
}

function getConfigSummary(config: StepConfig): string {
    const lines: string[] = [];
    for (const [diagramFile, entries] of Object.entries(config)) {
        lines.push(`${diagramFile}: ${entries.map(entry => entry.box).join(", ")}`);
    }
    return lines.join("\n");
}

function watchDiagramFolder(diagramFolder: string, stepsRoot: string, configPath: string): void {
    let pendingRegenerate: NodeJS.Timeout | undefined;
    watch(diagramFolder, (_event, name) => {
        if (name && !name.endsWith(".mmd")) {
            return;
        }
        // One save fires several events, so the last one wins after a short pause.
        clearTimeout(pendingRegenerate);
        pendingRegenerate = setTimeout(() => {
            console.log(getConfigSummary(generateSteps(diagramFolder, stepsRoot, configPath)));
        }, REGENERATE_DELAY_MS);
    });
    console.log(`watching ${relative(PROJECT_ROOT, diagramFolder)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const commandArguments = process.argv.slice(2);
    const diagramFolder = commandArguments.find(argument => !argument.startsWith("--")) ?? join(PROJECT_ROOT, "plans/diagrams");
    const stepsRoot = join(PROJECT_ROOT, "scripts/steps");
    const configPath = join(PROJECT_ROOT, "scripts/steps.json");
    console.log(getConfigSummary(generateSteps(diagramFolder, stepsRoot, configPath)));

    if (commandArguments.includes("--watch")) {
        watchDiagramFolder(diagramFolder, stepsRoot, configPath);
    }
}
