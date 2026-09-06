// Every hook command, SKILL.md path, relative import, and computed script path must resolve to a real file.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMergePhaseScriptPath, resolveMergeScriptPath } from "../scripts/shared/prepareTasks.ts";
import { reviewPlanRulingScriptPath } from "../scripts/review-plan/reviewPlanBrief.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_PLUGIN_ROOT_PREFIX = "${CLAUDE_PLUGIN_ROOT}/";

// Pre-existing broken references in planPrompt.ts to retired files, unrelated to this reorg; see plans/implementation-notes-113.md.
const PREEXISTING_BROKEN_REFERENCES = new Set([
    "scripts/tackle-tasks/shared/planPrompt.ts::./writeClarifyRequest.ts",
    "scripts/tackle-tasks/shared/planPrompt.ts::./updateTaskDocs.ts",
]);

function readTree(directory: string, predicate: (path: string) => boolean): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "fixtures") continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) results.push(...readTree(full, predicate));
        else if (predicate(full)) results.push(full);
    }
    return results;
}

function isInsideProject(path: string): boolean {
    return !relative(PROJECT_ROOT, path).startsWith("..");
}

function assertExistingReference(reference: string, sourceFile: string): void {
    const resolved = reference.startsWith(CLAUDE_PLUGIN_ROOT_PREFIX)
        ? join(PROJECT_ROOT, reference.slice(CLAUDE_PLUGIN_ROOT_PREFIX.length))
        : resolve(dirname(sourceFile), reference);
    assert.ok(existsSync(resolved), `${sourceFile} references "${reference}" which does not exist at ${resolved}`);
}

// Walks any JSON value, collecting every string found under a "command" key.
function collectHookCommands(node: unknown): string[] {
    if (Array.isArray(node)) return node.flatMap(collectHookCommands);
    if (node && typeof node === "object") {
        return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
            key === "command" && typeof value === "string" ? [value] : collectHookCommands(value));
    }
    return [];
}

type SkillCommandLine = { text: string; lineNumber: number };

// Inline !`command` spans and content lines inside a ```! ... ``` fence: the two forms Claude Code executes.
function extractSkillCommandLines(skillMdPath: string): SkillCommandLine[] {
    const lines = readFileSync(skillMdPath, "utf8").split("\n");
    const collected: SkillCommandLine[] = [];
    let inBangFence = false;
    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const trimmed = line.trim();
        if (!inBangFence && trimmed.startsWith("```!")) {
            inBangFence = true;
            return;
        }
        if (inBangFence && trimmed.startsWith("```")) {
            inBangFence = false;
            return;
        }
        if (inBangFence) {
            collected.push({ text: line, lineNumber });
            return;
        }
        const inlineMatch = line.match(/!`([^`]*)`/);
        if (inlineMatch) collected.push({ text: inlineMatch[1]!, lineNumber });
    });
    return collected;
}

// A quoted string that looks like an executable path: ${CLAUDE_PLUGIN_ROOT}/..., /abs, ./rel, or ../rel.
function extractPathTokens(commandText: string): string[] {
    const tokens: string[] = [];
    const quotedRe = /["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = quotedRe.exec(commandText))) {
        const candidate = match[1]!;
        if (candidate.startsWith(CLAUDE_PLUGIN_ROOT_PREFIX) || candidate.startsWith("/") || /^(?:\.\.?\/)/.test(candidate)) {
            tokens.push(candidate);
        }
    }
    return tokens;
}

// Removes template-literal bodies and comments so embedded example text never reads as a real import.
function stripNonCode(content: string): string {
    return content
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
        .replace(/\/\*[\s\S]*?\*\//g, "/**/")
        .replace(/\/\/.*$/gm, "");
}

type StringLiteral = { start: number; content: string };

// Scans strings in one pass so a quoted path inside a string literal isn't mistaken for a real import.
function findStringLiterals(code: string): StringLiteral[] {
    const literals: StringLiteral[] = [];
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '"' || ch === "'") {
            const quote = ch;
            const start = i;
            i++;
            let content = "";
            while (i < code.length && code[i] !== quote) {
                if (code[i] === "\\") {
                    content += code[i] + (code[i + 1] ?? "");
                    i += 2;
                    continue;
                }
                content += code[i];
                i++;
            }
            i++;
            literals.push({ start, content });
            continue;
        }
        i++;
    }
    return literals;
}

// Static import/export-from, side-effect import, dynamic import(...), and new URL(..., import.meta.url).
function isImportSitedLiteral(code: string, literal: StringLiteral): boolean {
    const before = code.slice(0, literal.start).replace(/\s+$/, "");
    if (/from$/.test(before)) return true;
    if (/import\($/.test(before)) return true;
    if (/new\s+URL\($/.test(before)) return true;
    if (/(?:^|[;\n{}(\s])import$/.test(before)) return true;
    return false;
}

function extractRelativeSpecifiers(content: string): string[] {
    const code = stripNonCode(content);
    const specs = new Set<string>();
    for (const literal of findStringLiterals(code)) {
        if (!/^\.\.?\//.test(literal.content)) continue;
        if (isImportSitedLiteral(code, literal)) specs.add(literal.content);
    }
    return [...specs];
}

test("every hook command points at an existing file", () => {
    const hooksFile = join(PROJECT_ROOT, "hooks/hooks.json");
    const hooksJson = JSON.parse(readFileSync(hooksFile, "utf8"));
    const commands = collectHookCommands(hooksJson);
    assert.ok(commands.length > 0, "expected at least one hook command");
    const tokens = commands.flatMap(command => [...command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/[^"\s]+/g)].map(m => m[0]));
    assert.ok(tokens.length > 0, "expected at least one ${CLAUDE_PLUGIN_ROOT} path token");
    for (const token of tokens) assertExistingReference(token, hooksFile);
});

test("every skill command points at an existing file", () => {
    const skillMdFiles = readTree(join(PROJECT_ROOT, "skills"), path => path.endsWith("SKILL.md"));
    assert.ok(skillMdFiles.length > 0, "expected at least one SKILL.md file");
    let checkedCount = 0;
    for (const skillMdFile of skillMdFiles) {
        for (const { text, lineNumber } of extractSkillCommandLines(skillMdFile)) {
            for (const token of extractPathTokens(text)) {
                if (token.startsWith("/") && !isInsideProject(token)) continue;
                checkedCount++;
                try {
                    assertExistingReference(token, skillMdFile);
                } catch (error) {
                    throw new Error(`${skillMdFile}:${lineNumber} ${(error as Error).message}`);
                }
            }
        }
    }
    assert.ok(checkedCount > 0, "expected at least one repository-owned skill command path");
});

test("every relative typescript import points at an existing file", () => {
    const sourceFiles = [
        ...readTree(join(PROJECT_ROOT, "scripts"), path => path.endsWith(".ts")),
        ...readTree(join(PROJECT_ROOT, "tests"), path => path.endsWith(".ts")),
    ];
    assert.ok(sourceFiles.length > 0, "expected at least one .ts source file");
    let totalCaptures = 0;
    for (const file of sourceFiles) {
        const fileKey = relative(PROJECT_ROOT, file);
        for (const spec of extractRelativeSpecifiers(readFileSync(file, "utf8"))) {
            totalCaptures++;
            if (PREEXISTING_BROKEN_REFERENCES.has(`${fileKey}::${spec}`)) continue;
            assertExistingReference(spec, file);
        }
    }
    assert.ok(totalCaptures > 0, "expected at least one relative TypeScript specifier");
});

test("the reference sweep rejects a broken path", () => {
    assert.throws(
        () => assertExistingReference("./definitely-missing-script.ts", join(PROJECT_ROOT, "tests/scriptReferences.test.ts")),
        /definitely-missing-script/,
    );
});

test("computed runtime paths point at existing files", () => {
    assert.ok(existsSync(resolveMergeScriptPath()));
    assert.ok(existsSync(resolveMergePhaseScriptPath()));
    assert.ok(existsSync(reviewPlanRulingScriptPath));
});
