// Turns every .mmd in a folder into stub scripts and a box-to-script config.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ANSWER_TEMPLATE } from "./contracts.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REGENERATE_DELAY_MS = 50;

// Every box name a diagram may draw, mapped to the one folder under scripts/tackle-tasks/ that owns its script.
const BLOCK_OWNER_FOLDER: Record<string, string> = {
    PREAMBLE_STATUS_CHECK: "preambleStatusCheck",
    DOCUMENT_GENERATION: "preambleStatusCheck",
    PLAN_THE_TASK: "preambleStatusCheck",
    WHAT_DID_THE_PLANNER_RETURN: "whatDidThePlannerReturn",
    CODEX_REVIEWS_PLAN: "whatDidThePlannerReturn",
    WHAT_IS_REVIEW_VERDICT: "whatIsReviewVerdict",
    IMPLEMENT_TASK: "whatIsReviewVerdict",
    COMMIT_IMPLEMENTATION_IF_NEEDED: "commitImplementationIfNeeded",
    CODEX_REVIEWS_TESTS: "commitImplementationIfNeeded",
    ARE_TESTS_FLAGGED: "areTestsFlagged",
    LOCK_SOURCE_REPO: "areTestsFlagged",
    REBASE_ONTO_TARGET_BRANCH: "areTestsFlagged",
    FIX_CONFLICTS: "areTestsFlagged",
    COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: "commitMergeConflictFixIfNeeded",
    RUN_FULL_SUITE: "runFullSuite",
    FIX_THE_CODEBASE_FOR_SUITE: "runFullSuite",
    FAILURES_EXIT: "exits",
    REPORT_ONLY_EXIT: "exits",
    STOP: "exits",
};

// next holds bare box ids for same-diagram arrows and "other.mmd::BOX" when the arrow crosses into another diagram.
export type StepConfigEntry = { box: string; script: string; template: string; producesPrompt: boolean; mutating?: boolean; next: string[] };
// Keyed by diagram file name; two diagrams naming the same box share its script but keep separate entries.
export type StepConfig = Record<string, StepConfigEntry[]>;
export type DiagramEdges = { boxes: string[]; next: Record<string, string[]> };
export type BlockTemplate = { input: unknown; output?: unknown; agentAnswer?: unknown };

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
        // A dotted arrow is a side note, not an edge; each side parses alone.
        for (const segment of statement.split("-.->")) {
            const boxChain = segment.split("-->").map(getBoxIdFromArrowSide).filter(Boolean);
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
    }
    return { boxes, next };
}

export function getBoxesInDiagram(diagram: string): string[] {
    return getEdgesInDiagram(diagram).boxes;
}

// "class A,B returns_a_prompt" in the diagram marks the boxes whose script prints a prompt.
export function getPromptBoxesInDiagram(diagram: string): string[] {
    const promptBoxes: string[] = [];
    for (const line of diagram.split("\n")) {
        const statement = line.split("%%")[0]!.trim();
        const classMatch = statement.match(/^class\s+(\S+)\s+returns_a_prompt$/);
        if (classMatch) {
            promptBoxes.push(...classMatch[1]!.split(","));
        }
    }
    return promptBoxes;
}

function buildStubScript(box: string, diagramFile: string, producesPrompt: boolean): string {
    const resultLine = producesPrompt
        ? `return { box: "${box}", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: \`stub prompt from \${basename(fileURLToPath(import.meta.url))}\` };`
        : `return { box: "${box}", scriptSignal: SCRIPT_SIGNAL.CONTINUE, note: \`\${basename(fileURLToPath(import.meta.url))} for ${box}\`, input };`;
    return `// ${box}, from ${diagramFile}
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    ${resultLine}
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
`;
}

// Seed output matches the stub script's print; a prompt block declares none, contracts.ts fixes its shape.
function buildStubTemplate(box: string, producesPrompt: boolean): string {
    const template = producesPrompt
        ? { input: {} }
        : { input: {}, output: { box, scriptSignal: "continue", note: `${box}.ts for ${box}`, input: "" } };
    return `${JSON.stringify(template, null, 4)}\n`;
}

// A new block's input is copied from its predecessor's output, or the answer shape.
function seedInputTemplatesFromPredecessors(config: StepConfig, newTemplatePaths: Set<string>): void {
    const outputByStepKey = new Map<string, unknown>();
    for (const [diagramFile, entries] of Object.entries(config)) {
        for (const entry of entries) {
            if (entry.producesPrompt) {
                outputByStepKey.set(`${diagramFile}::${entry.box}`, AGENT_ANSWER_TEMPLATE);
                continue;
            }
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

// The mutating flag is hand-written, so regenerating from the arrows must not drop it.
function getMutatingFromPreviousConfig(configPath: string): Record<string, boolean> {
    if (!existsSync(configPath)) {
        return {};
    }
    const previousConfig = JSON.parse(readFileSync(configPath, "utf8")) as StepConfig;
    const mutatingByStepKey: Record<string, boolean> = {};
    for (const [diagramFile, entries] of Object.entries(previousConfig)) {
        for (const entry of entries) {
            if (entry.mutating) {
                mutatingByStepKey[`${diagramFile}::${entry.box}`] = true;
            }
        }
    }
    return mutatingByStepKey;
}

// A leading underscore marks a spec diagram: it is drawn and served, but never generated from.
function getDiagramFileNames(diagramFolder: string): string[] {
    return readdirSync(diagramFolder).filter(name => name.endsWith(".mmd") && !name.startsWith("_")).sort();
}

type ParsedDiagram = DiagramEdges & { promptBoxes: string[] };

// Every diagram's boxes, edges, and prompt-marked boxes, parsed once up front.
function parseDiagrams(diagramFolder: string): Map<string, ParsedDiagram> {
    const parsedByDiagramFile = new Map<string, ParsedDiagram>();
    for (const diagramFile of getDiagramFileNames(diagramFolder)) {
        const diagram = readFileSync(join(diagramFolder, diagramFile), "utf8");
        const { boxes, next } = getEdgesInDiagram(diagram);
        parsedByDiagramFile.set(diagramFile, { boxes, next, promptBoxes: getPromptBoxesInDiagram(diagram) });
    }
    return parsedByDiagramFile;
}

// An arrow into a box with no outgoing arrows here, that opens another diagram, exits into that diagram.
function remapNextAcrossDiagrams(diagramFile: string, next: Record<string, string[]>, firstBoxByDiagram: Map<string, string>): Record<string, string[]> {
    const remapped: Record<string, string[]> = {};
    for (const [box, targets] of Object.entries(next)) {
        remapped[box] = targets.map(target => {
            if (next[target]!.length > 0) {
                return target;
            }
            for (const [otherDiagramFile, firstBox] of firstBoxByDiagram) {
                if (otherDiagramFile === diagramFile) {
                    continue;
                }
                if (firstBox === target) {
                    return `${otherDiagramFile}::${target}`;
                }
            }
            return target;
        });
    }
    return remapped;
}

// A stub file on disk whose box name no diagram draws any more is a rename or deletion the caller missed.
function assertNoOrphanBoxScripts(stepsRoot: string, allBoxNames: Set<string>): void {
    if (!existsSync(stepsRoot)) {
        return;
    }
    const orphans: string[] = [];
    for (const ownerFolder of readdirSync(stepsRoot, { withFileTypes: true })) {
        if (!ownerFolder.isDirectory()) {
            continue;
        }
        if (ownerFolder.name === "shared") {
            continue;
        }
        for (const file of readdirSync(join(stepsRoot, ownerFolder.name))) {
            if (!file.endsWith(".ts")) {
                continue;
            }
            if (file.startsWith("_")) {
                continue;
            }
            if (file.endsWith(".test.ts")) {
                continue;
            }
            if (allBoxNames.has(basename(file, ".ts"))) {
                continue;
            }
            orphans.push(join(ownerFolder.name, file));
        }
    }
    if (orphans.length === 0) {
        return;
    }
    const lines = orphans.map(path => `${path} is named by no diagram; git mv it to the new name or delete it`);
    throw new Error(lines.join("\n"));
}

// A box outside the real 19 (only possible from a synthetic diagram) is owned by whichever diagram names it first.
function getDefaultOwnerFolder(box: string, parsedDiagrams: Map<string, ParsedDiagram>): string {
    for (const [diagramFile, data] of parsedDiagrams) {
        if (data.boxes.includes(box)) {
            return basename(diagramFile, ".mmd");
        }
    }
    // Structurally impossible: box always comes from some diagram's own boxes list.
    throw new Error(`${box} is drawn by no diagram`);
}

export function generateSteps(diagramFolder: string, stepsRoot: string, configPath: string): StepConfig {
    const mutatingByStepKey = getMutatingFromPreviousConfig(configPath);
    const parsedDiagrams = parseDiagrams(diagramFolder);

    const firstBoxByDiagram = new Map<string, string>();
    const allBoxNames = new Set<string>();
    for (const [diagramFile, data] of parsedDiagrams) {
        firstBoxByDiagram.set(diagramFile, data.boxes[0]!);
        for (const box of data.boxes) {
            allBoxNames.add(box);
        }
    }
    assertNoOrphanBoxScripts(stepsRoot, allBoxNames);

    const newTemplatePaths = new Set<string>();
    const config: StepConfig = {};
    for (const [diagramFile, data] of parsedDiagrams) {
        const remappedNext = remapNextAcrossDiagrams(diagramFile, data.next, firstBoxByDiagram);
        const entries: StepConfigEntry[] = [];
        for (const box of data.boxes) {
            const ownerFolder = BLOCK_OWNER_FOLDER[box] ?? getDefaultOwnerFolder(box, parsedDiagrams);
            const stepsDirectory = join(stepsRoot, ownerFolder);
            mkdirSync(stepsDirectory, { recursive: true });
            const producesPrompt = data.promptBoxes.includes(box);
            const scriptPath = join(stepsDirectory, `${box}.ts`);
            const templatePath = join(stepsDirectory, `${box}.template.json`);
            // An existing file is the author's, so only a missing one gets written.
            if (!existsSync(scriptPath)) {
                writeFileSync(scriptPath, buildStubScript(box, diagramFile, producesPrompt));
            }
            if (!existsSync(templatePath)) {
                writeFileSync(templatePath, buildStubTemplate(box, producesPrompt));
                newTemplatePaths.add(relative(PROJECT_ROOT, templatePath));
            }
            const mutating = mutatingByStepKey[`${diagramFile}::${box}`];
            entries.push({
                box,
                script: relative(PROJECT_ROOT, scriptPath),
                template: relative(PROJECT_ROOT, templatePath),
                producesPrompt,
                ...(mutating ? { mutating } : {}),
                next: remappedNext[box] ?? [],
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
    const stepsRoot = join(PROJECT_ROOT, "scripts/tackle-tasks");
    const configPath = join(PROJECT_ROOT, "scripts/steps.json");
    console.log(getConfigSummary(generateSteps(diagramFolder, stepsRoot, configPath)));

    if (commandArguments.includes("--watch")) {
        watchDiagramFolder(diagramFolder, stepsRoot, configPath);
    }
}
