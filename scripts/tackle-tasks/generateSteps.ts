// Turns every .mmd in a folder into stub scripts and a box-to-script config.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ANSWER_TEMPLATE } from "../shared/contracts.ts";

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REGENERATE_DELAY_MS = 50;

// The one folder under scripts/tackle-tasks/ that owns each block's script: the diagram the block belongs to.
const BLOCKS_BY_OWNER_FOLDER: Record<string, string[]> = {
    preambleStatusCheck: [
        "PREAMBLE_STATUS_CHECK", "IS_TASK_BLOCKED_Q", "IS_TASK_ACTIVE_Q", "PREFLIGHT_OK_Q", "MARK_TASK_ACTIVE", "DOES_WORKTREE_EXIST_Q",
        "CREATE_WORKTREE", "TAKE_WORKTREE_LEASE", "IS_WORKTREE_SAFE_TO_USE_Q", "TAKE_WORKTREE_LEASE_BEFORE_RESET",
        "RESET_WORKTREE", "IS_PREVIOUS_RUN_RESUMABLE_Q", "REBASE_RESUMED_WORKTREE_ONTO_STAGING", "DOES_FENCE_COVER_WORKTREE_Q", "INIT_SUBMODULES_RECURSIVELY",
        "DOCUMENT_GENERATION",
    ],
    reportOnlyExit: ["REPORT_ONLY_EXIT", "STOP"],
    planTheTask: ["IS_DIFFICULTY_7_PLUS_Q", "PLAN_THE_TASK", "PLAN_THE_TASK_CODEX"],
    whatDidThePlannerReturn: ["WHAT_DID_THE_PLANNER_RETURN", "ARE_2_CLARIFY_ROUNDS_DONE_Q", "WRITE_CLARIFY_REQUEST"],
    codexReviewsPlan: [
        "IS_PLAN_APPROVED_BY_DEFAULT_Q", "CODEX_REVIEWS_PLAN", "DID_CODEX_REVIEW_SUCCEED_Q",
        "CODEX_REVIEW_FALLBACK_FABLE", "DID_FABLE_REVIEW_SUCCEED_Q", "CODEX_REVIEW_FALLBACK_OPUS",
    ],
    whatIsReviewVerdict: ["WHAT_IS_REVIEW_VERDICT", "UPDATE_TASKS_JSON", "TWO_CODEX_REVIEWS_COMPLETED_Q"],
    implementTask: ["IMPLEMENT_TASK"],
    commitImplementationIfNeeded: [
        "COMMIT_IMPLEMENTATION_IF_NEEDED", "COMMIT_TEST_FIX_IF_NEEDED", "ARE_TASK_TESTS_SKIPPED_Q", "RUN_TASK_TESTS", "DO_TASK_TESTS_PASS_Q",
        "ARE_2_TEST_FIXES_DONE_Q", "AMEND_ENTRY_WITH_FAILING_TESTS",
    ],
    fixImplementTaskTests: ["FIX_IMPLEMENT_TASK_TESTS"],
    codexReviewsTests: [
        "CODEX_REVIEWS_TESTS", "DID_CODEX_TEST_REVIEW_SUCCEED_Q", "CODEX_TEST_REVIEW_FALLBACK_FABLE",
        "DID_FABLE_TEST_REVIEW_SUCCEED_Q", "CODEX_TEST_REVIEW_FALLBACK_OPUS",
    ],
    areTestsFlagged: ["ARE_TESTS_FLAGGED", "ARE_2_TEST_REVIEWS_DONE_Q", "AMEND_ENTRY_WITH_CODEX_NOTES"],
    lockSourceRepo: ["LOCK_SOURCE_REPO", "WAS_LOCK_ACQUIRED_Q", "HAS_LOCK_WAIT_DEADLINE_PASSED_Q", "WAIT_FOR_LOCK"],
    rebase: ["REBASE_ONTO_TARGET_BRANCH", "DID_REBASE_REPORT_CONFLICTS_Q", "ARE_2_CONFLICT_FIXES_DONE_Q"],
    fixConflicts: ["FIX_CONFLICTS"],
    commitMergeConflictFixIfNeeded: ["COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", "CONTINUE_REBASE", "IS_REBASE_FINISHED_Q"],
    runFullSuite: [
        "COMMIT_SUITE_FIX_IF_NEEDED", "RUN_FULL_SUITE", "DO_ALL_TESTS_PASS_Q", "ARE_2_SUITE_FIXES_DONE_Q",
        "DID_CHANGES_STAY_INSIDE_FENCE_Q", "MERGE_WORKTREES", "READ_MERGE_PUBLICATION_STATE",
        "WHAT_IS_PUBLICATION_STATE_Q", "ARE_2_MERGE_ATTEMPTS_DONE_Q",
    ],
    fixTheCodebaseForSuite: ["FIX_THE_CODEBASE_FOR_SUITE"],
    mergeSucceededExit: [
        "MERGE_SUCCEEDED_EXIT", "RECORD_MERGE_COMMIT_HASHES", "WRITE_EXIT_TYPE_COMPLETED", "RECORD_MODIFIED_FILES_SUCCESS",
        "CLEAN_UP_WORKTREES", "BUILD_CLOSURE_NOTE", "MARK_TASK_INACTIVE_SUCCESS", "ARCHIVE_TASK", "REPORT_CLOSURE_NOTE",
    ],
    failuresExit: [
        "FAILURES_EXIT", "READ_FAILURES_PUBLICATION_STATE", "DID_ANY_WORK_LAND_Q", "WRITE_PUBLICATION_OUTCOME",
        "WRITE_EXIT_TYPE_AND_NOTE", "RECORD_MODIFIED_FILES_FAILURE", "MARK_TASK_INACTIVE_FAILURE", "DOES_RUN_HOLD_LEASE_Q",
        "RELEASE_WORKTREE_LEASE", "DOES_RUN_HOLD_SOURCE_LOCK_Q", "RELEASE_SOURCE_LOCK", "REPORT_EXIT_TYPE_AND_NOTE",
    ],
};
const BLOCK_OWNER_FOLDER: Record<string, string> = Object.fromEntries(
    Object.entries(BLOCKS_BY_OWNER_FOLDER).flatMap(([folder, blocks]) => blocks.map(block => [block, folder])),
);

// next holds bare box ids for same-diagram arrows and "other.mmd::BOX" when the arrow crosses into another diagram.
export type AgentOptions = { model: string; effort: string; agentType?: string };
export type StepConfigEntry = { box: string; script: string; template: string; producesPrompt: boolean; mutating?: boolean; agent?: AgentOptions; next: string[] };
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
        // An invisible link only places boxes on the page; it is not an edge.
        if (statement.includes("~~~")) {
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
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";

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

export type DiagramFolderSetting = { diagramFolder: string; stepsRoot: string; allowStubs: boolean };

// .taskTools/settings.json in the target project names a diagramFolder; an absent file or key means the default pipeline.
export function resolveDiagramFolderSetting(projectRoot: string): DiagramFolderSetting {
    const settingsPath = join(projectRoot, ".taskTools/settings.json");
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) as { diagramFolder?: string } : {};
    if (!settings.diagramFolder) {
        return { diagramFolder: join(PROJECT_ROOT, "diagrams/tackle-tasks"), stepsRoot: join(PROJECT_ROOT, "scripts/tackle-tasks"), allowStubs: true };
    }
    const diagramFolder = resolve(projectRoot, settings.diagramFolder);
    if (!existsSync(diagramFolder) || getDiagramFileNames(diagramFolder).length === 0) {
        throw new Error(`diagramFolder ${diagramFolder} does not exist or holds no .mmd files`);
    }
    return { diagramFolder, stepsRoot: diagramFolder, allowStubs: false };
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

// The first diagram, in file order, that draws arrows out of this box; undefined when none does.
function getDiagramWhereBoxHasArrows(box: string, parsedDiagrams: Map<string, ParsedDiagram>, exceptDiagramFile: string): string | undefined {
    for (const [diagramFile, data] of parsedDiagrams) {
        if (diagramFile === exceptDiagramFile) {
            continue;
        }
        if ((data.next[box] ?? []).length > 0) {
            return diagramFile;
        }
    }
    return undefined;
}

// An arrow into a box with no arrows here crosses into the diagram where that box does have some.
function remapNextAcrossDiagrams(diagramFile: string, next: Record<string, string[]>, parsedDiagrams: Map<string, ParsedDiagram>): Record<string, string[]> {
    const remapped: Record<string, string[]> = {};
    for (const [box, targets] of Object.entries(next)) {
        remapped[box] = targets.map(target => {
            if (next[target]!.length > 0) {
                return target;
            }
            const homeDiagramFile = getDiagramWhereBoxHasArrows(target, parsedDiagrams, diagramFile);
            return homeDiagramFile === undefined ? target : `${homeDiagramFile}::${target}`;
        });
    }
    return remapped;
}

// A stray stub script means a rename; one in the wrong folder means a move.
function assertNoOrphanBoxScripts(stepsRoot: string, allBoxNames: Set<string>, getOwnerFolder: (box: string) => string): void {
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
            const box = basename(file, ".ts");
            if (!allBoxNames.has(box)) {
                orphans.push(`${join(ownerFolder.name, file)} is named by no diagram; git mv it to the new name or delete it`);
                continue;
            }
            if (getOwnerFolder(box) !== ownerFolder.name) {
                orphans.push(`${join(ownerFolder.name, file)} belongs in ${getOwnerFolder(box)}/; git mv it there`);
            }
        }
    }
    if (orphans.length === 0) {
        return;
    }
    throw new Error(orphans.join("\n"));
}

// A synthetic box (outside the real 19) is owned by whichever diagram names it first.
function getDefaultOwnerFolder(box: string, parsedDiagrams: Map<string, ParsedDiagram>): string {
    for (const [diagramFile, data] of parsedDiagrams) {
        if (data.boxes.includes(box)) {
            return basename(diagramFile, ".mmd");
        }
    }
    // Structurally impossible: box always comes from some diagram's own boxes list.
    throw new Error(`${box} is drawn by no diagram`);
}

export function generateSteps(diagramFolder: string, stepsRoot: string, configPath: string, allowStubs: boolean = true): StepConfig {
    const mutatingByStepKey = getMutatingFromPreviousConfig(configPath);
    const parsedDiagrams = parseDiagrams(diagramFolder);

    const allBoxNames = new Set<string>();
    for (const data of parsedDiagrams.values()) {
        for (const box of data.boxes) {
            allBoxNames.add(box);
        }
    }
    const getOwnerFolder = (box: string): string => BLOCK_OWNER_FOLDER[box] ?? getDefaultOwnerFolder(box, parsedDiagrams);
    assertNoOrphanBoxScripts(stepsRoot, allBoxNames, getOwnerFolder);

    const newTemplatePaths = new Set<string>();
    const config: StepConfig = {};
    for (const [diagramFile, data] of parsedDiagrams) {
        const remappedNext = remapNextAcrossDiagrams(diagramFile, data.next, parsedDiagrams);
        const entries: StepConfigEntry[] = [];
        for (const box of data.boxes) {
            // A dashed box only points into another diagram; that diagram holds the step.
            if (data.next[box]!.length === 0 && getDiagramWhereBoxHasArrows(box, parsedDiagrams, diagramFile) !== undefined) {
                continue;
            }
            const ownerFolder = getOwnerFolder(box);
            const stepsDirectory = join(stepsRoot, ownerFolder);
            mkdirSync(stepsDirectory, { recursive: true });
            const producesPrompt = data.promptBoxes.includes(box);
            const scriptPath = join(stepsDirectory, `${box}.ts`);
            const templatePath = join(stepsDirectory, `${box}.template.json`);
            // An existing file is the author's, so only a missing one gets written.
            if (!existsSync(scriptPath)) {
                if (!allowStubs) {
                    throw new Error(`${scriptPath} is missing; a custom diagram folder must author its own block scripts`);
                }
                writeFileSync(scriptPath, buildStubScript(box, diagramFile, producesPrompt));
            }
            if (!existsSync(templatePath)) {
                if (!allowStubs) {
                    throw new Error(`${templatePath} is missing; a custom diagram folder must author its own block templates`);
                }
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

function watchDiagramFolder(diagramFolder: string, stepsRoot: string, configPath: string, allowStubs: boolean): void {
    let pendingRegenerate: NodeJS.Timeout | undefined;
    watch(diagramFolder, (_event, name) => {
        if (name && !name.endsWith(".mmd")) {
            return;
        }
        // One save fires several events, so the last one wins after a short pause.
        clearTimeout(pendingRegenerate);
        pendingRegenerate = setTimeout(() => {
            console.log(getConfigSummary(generateSteps(diagramFolder, stepsRoot, configPath, allowStubs)));
        }, REGENERATE_DELAY_MS);
    });
    console.log(`watching ${relative(PROJECT_ROOT, diagramFolder)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const commandArguments = process.argv.slice(2);
    const { diagramFolder, stepsRoot, allowStubs } = resolveDiagramFolderSetting(PROJECT_ROOT);
    const configPath = join(PROJECT_ROOT, "scripts/tackle-tasks/diagram-steps.json");
    console.log(getConfigSummary(generateSteps(diagramFolder, stepsRoot, configPath, allowStubs)));

    if (commandArguments.includes("--watch")) {
        watchDiagramFolder(diagramFolder, stepsRoot, configPath, allowStubs);
    }
}
