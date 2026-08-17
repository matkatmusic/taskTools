// Writes skills/tackle-tasks/tackle-tasks.workflow.js from the template beside this file.
//
// The sandbox forbids import, so validators are spliced in as source text, not copied by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = fileURLToPath(new URL("./tackle-tasks.workflow.template.js", import.meta.url));
const PLAN_ARTIFACTS_PATH = fileURLToPath(new URL("./planArtifacts.ts", import.meta.url));
const WORKFLOW_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));
const MARKER = "// GENERATED VALIDATORS";

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

export function generatedWorkflow(): string {
    const stripped = stripTypeScriptTypes(readFileSync(PLAN_ARTIFACTS_PATH, "utf8"));
    const validators = SPLICED_FROM_PLAN_ARTIFACTS.map((name) => declarationOf(stripped, name)).join("\n\n");
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    if (!template.includes(MARKER)) throw new Error(`generateTaskWorkflow: the template has no ${MARKER} line`);
    return template.replace(MARKER, validators);
}

if (process.argv[1]?.endsWith("generateTaskWorkflow.ts")) {
    writeFileSync(WORKFLOW_PATH, generatedWorkflow());
    process.stdout.write(`${WORKFLOW_PATH}\n`);
}
