// Turns every .mmd in a folder into stub scripts and a box-to-script config.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// next holds bare box ids for same-diagram arrows and "other.mmd::BOX" for a hand-written seam.
export type StepConfigEntry = { box: string; script: string; next: string[] };
// Keyed by diagram file name, so two diagrams may name the same box without sharing a script.
export type StepConfig = Record<string, StepConfigEntry[]>;

// A box id ends where its label or its edge label starts.
function boxIdFrom(side: string): string {
    return side.trim().replace(/^\|[^|]*\|/, "").trim().split(/[[({]/)[0]!.trim();
}

// Every box the diagram names, in order, with the boxes each one points at.
export function edgesInDiagram(diagram: string): { boxes: string[]; next: Record<string, string[]> } {
    const boxes: string[] = [];
    const next: Record<string, string[]> = {};
    for (const line of diagram.split("\n")) {
        const statement = line.split("%%")[0]!.trim();
        if (!statement || /^(flowchart|graph|subgraph|end|classDef|class|style|direction|click)\b/.test(statement)) continue;
        const chain = statement.split("-->").map(boxIdFrom).filter(Boolean);
        for (const [position, box] of chain.entries()) {
            if (!boxes.includes(box)) boxes.push(box);
            next[box] ??= [];
            const target = chain[position + 1];
            if (target && !next[box]!.includes(target)) next[box]!.push(target);
        }
    }
    return { boxes, next };
}

export function boxesInDiagram(diagram: string): string[] {
    return edgesInDiagram(diagram).boxes;
}

function stubScript(box: string, diagramFile: string): string {
    return `// ${box}, from ${diagramFile}\n`
        + `import { realpathSync } from "node:fs";\n`
        + `import { basename } from "node:path";\n`
        + `import { fileURLToPath } from "node:url";\n`
        + `\n`
        + `export function main(input: string): Record<string, unknown> {\n`
        + `    return { box: "${box}", signal: "continue", note: \`\${basename(fileURLToPath(import.meta.url))} for ${box}\`, input };\n`
        + `}\n`
        + `\n`
        + `// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.\n`
        + `if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url))) console.log(JSON.stringify(main(process.argv[2] ?? "")));\n`;
}

// A seam into another diagram is hand-written, so regenerating from the arrows must not drop it.
function seamsAlreadyWritten(configPath: string): Record<string, string[]> {
    if (!existsSync(configPath)) return {};
    const previous = JSON.parse(readFileSync(configPath, "utf8")) as StepConfig;
    const seams: Record<string, string[]> = {};
    for (const [diagramFile, entries] of Object.entries(previous)) {
        for (const entry of entries) seams[`${diagramFile}::${entry.box}`] = entry.next.filter(target => target.includes("::"));
    }
    return seams;
}

export function generateSteps(diagramFolder: string, stepsRoot: string, configPath: string): StepConfig {
    const seams = seamsAlreadyWritten(configPath);
    const config: StepConfig = {};
    for (const diagramFile of readdirSync(diagramFolder).filter(name => name.endsWith(".mmd")).sort()) {
        const stepsDirectory = join(stepsRoot, basename(diagramFile, ".mmd"));
        mkdirSync(stepsDirectory, { recursive: true });
        const { boxes, next } = edgesInDiagram(readFileSync(join(diagramFolder, diagramFile), "utf8"));
        config[diagramFile] = boxes.map(box => {
            const scriptPath = join(stepsDirectory, `${box}.ts`);
            // An existing script is the author's, so only a missing one gets written.
            if (!existsSync(scriptPath)) writeFileSync(scriptPath, stubScript(box, diagramFile));
            return { box, script: relative(PROJECT_ROOT, scriptPath), next: [...next[box]!, ...(seams[`${diagramFile}::${box}`] ?? [])] };
        });
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`);
    return config;
}

function describe(config: StepConfig): string {
    return Object.entries(config).map(([diagramFile, entries]) => `${diagramFile}: ${entries.map(entry => entry.box).join(", ")}`).join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const diagramFolder = args.find(argument => !argument.startsWith("--")) ?? join(PROJECT_ROOT, "plans/diagrams");
    const stepsRoot = join(PROJECT_ROOT, "scripts/steps");
    const configPath = join(PROJECT_ROOT, "scripts/steps.json");
    console.log(describe(generateSteps(diagramFolder, stepsRoot, configPath)));

    if (args.includes("--watch")) {
        let pending: NodeJS.Timeout | undefined;
        watch(diagramFolder, (_event, name) => {
            if (name && !name.endsWith(".mmd")) return;
            // One save fires several events, so the last one wins after a short pause.
            clearTimeout(pending);
            pending = setTimeout(() => console.log(describe(generateSteps(diagramFolder, stepsRoot, configPath))), 50);
        });
        console.log(`watching ${relative(PROJECT_ROOT, diagramFolder)}`);
    }
}
