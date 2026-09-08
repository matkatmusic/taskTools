// Builds the plan-review packet answer, so the agent stops hand-typing {message, additionalData} after codex writes the review file.
import { writeAgentAnswer } from "./writeAgentAnswer.ts";

export function writeReviewAnswer(packetFile: string, reviewFile: string): void {
    writeAgentAnswer(packetFile, JSON.stringify({ message: "", additionalData: { reviewFile } }));
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
