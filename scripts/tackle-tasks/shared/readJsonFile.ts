// One path-aware JSON reader for every pipeline-owned or agent-owned state file. Missing, empty, and
// malformed files all name their own path; a malformed file's SyntaxError is rethrown as its cause.
import { readFileSync } from "node:fs";

export function readJsonFile(path: string): unknown {
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") throw new Error(`readJsonFile: ${path} is empty`);
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`readJsonFile: ${path} is not valid JSON`, { cause: error });
    }
}
