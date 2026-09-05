// relatedTests.ts: jot's post_tool_batch_test_hook.py, ported to batch by owning occurrence.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { getOwningOccurrence } from "./repositoryGraph.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";
import { discoverTestPolicy } from "./testPolicy.ts";
import { createEmptyResolutionManifest } from "./resolutionRequests.ts";
import { loadRepositoryManifest } from "./prepareTasks.ts";
import type { ResolutionManifest } from "./resolutionRequests.ts";

type ToolCall = { tool_name?: string; tool_input?: { file_path?: string } };
// A Stop payload names the session; the turn flag file holds the paths edited this turn.
type HookInput = { session_id?: string; cwd?: string; stop_hook_active?: boolean };

const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type LanguageConfig = {
    isTest: (name: string) => boolean;
    candidates: (occurrenceCwd: string, name: string, sourceDir: string) => string[];
};

const LANGUAGES: Record<string, LanguageConfig> = {
    ".py": {
        isTest: (name) => name.startsWith("test_"),
        candidates: (cwd, name) => [join(cwd, "tests", `test_${name}.py`)],
    },
    ".js": {
        isTest: (name) => name.startsWith("test-") || name.endsWith(".test"),
        candidates: (cwd, name) => [join(cwd, "tests", `test-${name}.js`), join(cwd, "tests", `${name}.test.js`)],
    },
    ".ts": {
        isTest: (name) => name.startsWith("test-") || name.endsWith(".test"),
        candidates: (cwd, name, sourceDir) => [
            join(cwd, "tests", `test-${name}.ts`),
            join(cwd, "tests", `${name}.test.ts`),
            join(sourceDir, `${name}.test.ts`),
        ],
    },
};

export function extractEditedFiles(toolCalls: ToolCall[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const call of toolCalls) {
        if (!FILE_MODIFYING_TOOLS.has(call.tool_name ?? "")) continue;
        const filePath = call.tool_input?.file_path ?? "";
        if (!filePath || seen.has(filePath)) continue;
        seen.add(filePath);
        result.push(filePath);
    }
    return result;
}

// Root-relative path for a file inside rootPath, or null if outside it (inlines jot's in_project).
export function toRootRelativePath(filePath: string, rootPath: string): string | null {
    if (!filePath) return null;
    const rel = relative(resolve(rootPath), resolve(filePath));
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel;
}

function findTestFile(
    filePath: string,
    occurrenceCwd: string,
    langConfig: LanguageConfig,
): { testFile: string } | { searched: string } {
    const name = basename(filePath, extname(filePath));
    if (langConfig.isTest(name)) return { testFile: filePath };
    const sourceDir = dirname(filePath);
    const candidates = langConfig.candidates(occurrenceCwd, name, sourceDir);
    for (const candidate of candidates) {
        if (existsSync(candidate)) return { testFile: candidate };
    }
    return { searched: candidates.map((c) => relative(occurrenceCwd, c)).join(" and ") };
}

export type OccurrenceBatch = {
    occurrence: RepositoryOccurrence;
    byExtension: Map<string, { sources: string[]; tests: string[] }>;
};

export type GroupResult = { batches: Map<string, OccurrenceBatch>; warnings: string[] };

// Groups edited files by owning occurrence (sub-keyed by extension), resolving each file's test file.
export function groupEditsByOccurrence(
    editedFiles: string[],
    rootPath: string,
    manifest: RepositoryManifest,
): GroupResult {
    const batches = new Map<string, OccurrenceBatch>();
    const warnings: string[] = [];
    for (const filePath of editedFiles) {
        const rootRelativePath = toRootRelativePath(filePath, rootPath);
        if (rootRelativePath === null) continue;
        const langConfig = LANGUAGES[extname(filePath)];
        if (!langConfig) continue;
        const owner = getOwningOccurrence(rootRelativePath, manifest);
        if (!owner) continue;
        const occurrenceCwd = resolve(rootPath, owner.checkoutPath);
        const found = findTestFile(filePath, occurrenceCwd, langConfig);
        if ("searched" in found) {
            warnings.push(`WARNING: No test file found for ${filePath} (looked for ${found.searched})`);
            continue;
        }
        const batch = batches.get(owner.occurrenceId) ?? { occurrence: owner, byExtension: new Map() };
        const extBatch = batch.byExtension.get(extname(filePath)) ?? { sources: [], tests: [] };
        extBatch.sources.push(filePath);
        if (!extBatch.tests.includes(found.testFile)) extBatch.tests.push(found.testFile);
        batch.byExtension.set(extname(filePath), extBatch);
        batches.set(owner.occurrenceId, batch);
    }
    return { batches, warnings };
}

function runOccurrenceTests(
    occurrenceCwd: string,
    batch: OccurrenceBatch,
    resolutionManifest: ResolutionManifest,
): string | null {
    const allSources = [...batch.byExtension.values()].flatMap((b) => b.sources);
    const policyResult = discoverTestPolicy(batch.occurrence.occurrenceId, occurrenceCwd, resolutionManifest);
    if (policyResult.status === "needsResolution") {
        return `WARNING: No test policy resolved for ${batch.occurrence.checkoutPath} after editing ${allSources.join(", ")}`;
    }
    try {
        execSync(policyResult.policy.relatedTestCommand, { cwd: occurrenceCwd, encoding: "utf8" });
        return null;
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
        const logDir = join(".plate", "hook-logs");
        mkdirSync(logDir, { recursive: true });
        const logFile = join(logDir, `${batch.occurrence.occurrenceId}_${Date.now()}.log`);
        writeFileSync(logFile, output);
        const tail = output.split("\n").slice(-20).join("\n");
        return `Tests FAILED after editing ${allSources.join(", ")}. Full log: ${logFile}\n${tail}`;
    }
}

export function runRelatedTests(
    editedFiles: string[],
    rootPath: string,
    manifest: RepositoryManifest,
    resolutionManifest: ResolutionManifest,
): string[] {
    const { batches, warnings } = groupEditsByOccurrence(editedFiles, rootPath, manifest);
    for (const batch of batches.values()) {
        const occurrenceCwd = resolve(rootPath, batch.occurrence.checkoutPath);
        const warning = runOccurrenceTests(occurrenceCwd, batch, resolutionManifest);
        if (warning) warnings.push(warning);
        if (batch.byExtension.has(".ts")) {
            const typeErrors = execSync("npx tsc --noEmit 2>&1 | head -30", { cwd: occurrenceCwd, encoding: "utf8" }).trim();
            if (typeErrors !== "") warnings.push(`Type errors after editing ${batch.byExtension.get(".ts")!.sources.join(", ")}:\n${typeErrors}`);
        }
    }
    return warnings;
}

// Entry point: reads a Stop payload {session_id, cwd} from stdin, exits 2 on failure.
function main(): void {
    const hookInput: HookInput = JSON.parse(readFileSync(0, "utf8"));
    if (hookInput.stop_hook_active) process.exit(0);
    if (!hookInput.session_id) throw new Error("relatedTests hook input requires session_id");
    // ponytail: stage-and-summarize-stop.ts deletes this flag when it finishes; read it first thing.
    const flag = join(process.env.HOME ?? "", ".claude", "turn-flags", hookInput.session_id);
    if (!existsSync(flag)) process.exit(0);
    // realpath: git reports the real root, and a /var symlink path would look like it is outside it.
    const editedFiles = [...new Set(readFileSync(flag, "utf8").split("\n").filter(Boolean))].map((file) => realpathSync(file));
    if (editedFiles.length === 0) process.exit(0);
    if (!hookInput.cwd) throw new Error("relatedTests hook input requires cwd");
    const rootPath = execFileSync("git", ["-C", hookInput.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const rootBranch = execFileSync("git", ["-C", rootPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const manifest = loadRepositoryManifest(rootPath, rootBranch);
    const warnings = runRelatedTests(editedFiles, rootPath, manifest, createEmptyResolutionManifest());
    if (warnings.length > 0) {
        process.stderr.write(warnings.join("\n") + "\n");
        process.exit(2);
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
