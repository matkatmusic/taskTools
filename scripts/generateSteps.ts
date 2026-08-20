// Reads a .mmd diagram, writes a stub script for every box that has none, and rewrites the box-to-script config.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export type StepConfigEntry = { box: string; script: string };

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

export function generateSteps(diagramPath: string, stepsDirectory: string, configPath: string): StepConfigEntry[] {
    const boxes = boxesInDiagram(readFileSync(diagramPath, "utf8"));
    mkdirSync(stepsDirectory, { recursive: true });
    const config = boxes.map(box => {
        const scriptPath = join(stepsDirectory, `${box}.ts`);
        // An existing script is the author's, so only a missing one gets written.
        if (!existsSync(scriptPath)) writeFileSync(scriptPath, `// ${box}\nconsole.log("${box} has no script yet");\n`);
        return { box, script: relative(PROJECT_ROOT, scriptPath) };
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`);
    return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const diagramPath = process.argv[2] ?? join(PROJECT_ROOT, "plans/diagrams/pipeline.mmd");
    const config = generateSteps(diagramPath, join(PROJECT_ROOT, "scripts/steps"), join(PROJECT_ROOT, "scripts/steps.json"));
    console.log(`${config.length} boxes: ${config.map(entry => entry.box).join(", ")}`);
}
