// One path-aware JSON reader for every pipeline-owned or agent-owned state file. Missing and empty files
// name their own path; a non-empty malformed file's SyntaxError is left unwrapped, per the no-try/catch rule.
import { readFileSync } from "node:fs";

export function readJsonFile(path: string): unknown {
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") throw new Error(`readJsonFile: ${path} is empty`);
    return JSON.parse(text);
}
