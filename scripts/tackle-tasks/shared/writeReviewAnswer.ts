// Builds the plan-review packet answer, so the agent stops hand-typing {message, additionalData} after codex writes the review file.
import { existsSync, statSync } from "node:fs";
import { writeAgentAnswer } from "./writeAgentAnswer.ts";

export function writeReviewAnswer(packetFile: string, reviewFile: string): void {
    // Codex succeeded only if it wrote the review after the hook wrote the packet; a round-one file is stale.
    const codexSucceeded = existsSync(reviewFile) && statSync(reviewFile).mtimeMs > statSync(packetFile).mtimeMs;
    writeAgentAnswer(packetFile, JSON.stringify({ message: "", additionalData: { reviewFile, codexSucceeded } }));
}

if (process.argv[1]?.endsWith("writeReviewAnswer.ts")) {
    const [packetFile, reviewFile] = process.argv.slice(2);
    if (packetFile === undefined || packetFile === "" || reviewFile === undefined || reviewFile === "") {
        process.stderr.write(`usage: node writeReviewAnswer.ts <packetFile> <reviewFile>\n`);
        process.exit(1);
    }
    writeReviewAnswer(packetFile, reviewFile);
    process.stdout.write(`answer recorded in ${packetFile}\n`);
}
