// codex sometimes wraps plans/codex-review.json in a markdown code fence; strip it before parsing.
import { readFileSync } from "node:fs";

export function readReviewJson(filePath: string): unknown {
    const text = readFileSync(filePath, "utf8").trim();
    let body = text;
    if (body.startsWith("```")) {
        const lines = body.split("\n");
        lines.shift();
        if (lines[lines.length - 1] === "```") {
            lines.pop();
        }
        body = lines.join("\n");
    }
    return JSON.parse(body);
}
