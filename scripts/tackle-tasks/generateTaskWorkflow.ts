// Writes the workflow from its template. The sandbox forbids import, so everything is spliced in.
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { L } from "../tracePipeline.ts";

const TEMPLATE_PATH = fileURLToPath(new URL("./tackle-tasks.workflow.template.js", import.meta.url));
const PLAN_ARTIFACTS_PATH = fileURLToPath(new URL("./planArtifacts.ts", import.meta.url));
const PIPELINES_PATH = fileURLToPath(new URL("./pipelines.ts", import.meta.url));
const WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));
const MARKER = "// GENERATED VALIDATORS";
const LABELS_MARKER = "// GENERATED LABELS";
const PIPELINES_MARKER = "// GENERATED PIPELINES";

// Each name is a top-level `const` or `function` declaration, taken whole from the stripped source.
const SPLICED_FROM_PLAN_ARTIFACTS = ["SECTION_ID_PATTERN", "isPlanProblem", "validatePlanShape"];

function declarationOf(strippedSource: string, name: string): string {
    const start = strippedSource.search(new RegExp(`^(?:export )?(?:const|function) ${name}\\b`, "m"));
    if (start === -1) throw new Error(`generateTaskWorkflow: no top-level declaration of ${name}`);
    const rest = strippedSource.slice(start);
    // A declaration ends at the first line that closes it at column 0, or at its own single line.
    const end = rest.startsWith("const ") ? rest.indexOf("\n") : rest.search(/^\}/m) + 1;
    return rest.slice(0, end).replace(/^export /, "");
}

// pipelines.ts is spliced whole: it has no import, so its stripped body runs inside the sandbox.
function splicedPipelines(): string {
    const stripped = stripTypeScriptTypes(readFileSync(PIPELINES_PATH, "utf8"));
    if (/^\s*import\s/m.test(stripped)) throw new Error("generateTaskWorkflow: pipelines.ts must not import");
    // `export` is a module keyword, so it is dropped; the declarations themselves are unchanged.
    return stripped.replace(/^export /gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Every diagram node the sources name as L("SOMETHING"), so a typo fails the build, not a run.
function splicedLabels(sources: string[]): string {
    const ids = [...new Set(
        sources.flatMap((source) => [...source.matchAll(/\bL\("([A-Z][A-Z0-9_]*)"\)/g)].map((match) => match[1]!)),
    )].sort();
    if (ids.length === 0) throw new Error("generateTaskWorkflow: the sources name no L(\"<NODE_ID>\") labels");
    const entries = ids.map((id) => `  ${id}: ${JSON.stringify(L(id))},`).join("\n");
    return `const LABELS = {\n${entries}\n}`;
}

export function generatedWorkflow(): string {
    const stripped = stripTypeScriptTypes(readFileSync(PLAN_ARTIFACTS_PATH, "utf8"));
    const validators = SPLICED_FROM_PLAN_ARTIFACTS.map((name) => declarationOf(stripped, name)).join("\n\n");
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    for (const marker of [MARKER, LABELS_MARKER, PIPELINES_MARKER]) {
        if (!template.includes(marker)) throw new Error(`generateTaskWorkflow: the template has no ${marker} line`);
    }
    const pipelines = splicedPipelines();
    return template
        .replace(MARKER, validators)
        .replace(LABELS_MARKER, splicedLabels([template, pipelines]))
        .replace(PIPELINES_MARKER, pipelines);
}

if (process.argv[1]?.endsWith("generateTaskWorkflow.ts")) {
    writeFileSync(WORKFLOW_PATH, generatedWorkflow());
    process.stdout.write(`${WORKFLOW_PATH}\n`);
}
