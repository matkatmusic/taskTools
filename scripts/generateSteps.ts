// Turns every .mmd in a folder into stub scripts and a box-to-script config.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export type StepConfigEntry = { box: string; script: string };
// Keyed by diagram file name, so two diagrams may name the same box without sharing a script.
export type StepConfig = Record<string, StepConfigEntry[]>;

// Every box id in the order the diagram names it, each one once.
export function boxesInDiagram(diagram: string): string[] {
    const boxes: string[] = [];
    for (const line of diagram.split("\n")) {
        const statement = line.split("%%")[0]!.trim();
        if (!statement || /^(flowchart|graph|subgraph|end|classDef|class|style|direction)\b/.test(statement)) continue;
        for (const side of statement.split("-->")) {
            // A box id ends where its label starts, so [ ( { all close the id.
            const box = side.trim().split(/[[({|]/)[0]!.trim();
            if (box && !boxes.includes(box)) boxes.push(box);
        }
    }
    return boxes;
}

function stubScript(box: string, diagramFile: string): string {
    return `// ${box}, from ${diagramFile}\n`
        + `import { realpathSync } from "node:fs";\n`
        + `import { basename } from "node:path";\n`
        + `import { fileURLToPath } from "node:url";\n`
        + `\n`
        + `export function main(): void {\n`
        + `    console.log(\`\${basename(fileURLToPath(import.meta.url))} for ${box}\`);\n`
        + `}\n`
        + `\n`
        + `// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.\n`
        + `if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url))) main();\n`;
}

export function generateSteps(diagramFolder: string, stepsRoot: string, configPath: string): StepConfig {
    const config: StepConfig = {};
    for (const diagramFile of readdirSync(diagramFolder).filter(name => name.endsWith(".mmd")).sort()) {
        const stepsDirectory = join(stepsRoot, basename(diagramFile, ".mmd"));
        mkdirSync(stepsDirectory, { recursive: true });
        config[diagramFile] = boxesInDiagram(readFileSync(join(diagramFolder, diagramFile), "utf8")).map(box => {
            const scriptPath = join(stepsDirectory, `${box}.ts`);
            // An existing script is the author's, so only a missing one gets written.
            if (!existsSync(scriptPath)) writeFileSync(scriptPath, stubScript(box, diagramFile));
            return { box, script: relative(PROJECT_ROOT, scriptPath) };
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
