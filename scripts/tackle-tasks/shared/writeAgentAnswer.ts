// Agents record answers only through this validated merge, never by hand-editing packet JSON.
import { readFileSync } from "node:fs";
import { writeJsonAtomically } from "../../taskStateLock.ts";

export function writeAgentAnswer(packetFile: string, answerJson: string): void {
    const answer = JSON.parse(answerJson) as Record<string, unknown>;
    if (typeof answer.message !== "string") throw new Error(`writeAgentAnswer: answer holds no string "message"`);
    if (answer.additionalData === null || typeof answer.additionalData !== "object" || Array.isArray(answer.additionalData)) {
        throw new Error(`writeAgentAnswer: answer holds no object "additionalData"`);
    }
    const packet = JSON.parse(readFileSync(packetFile, "utf8")) as Record<string, unknown>;
    writeJsonAtomically(packetFile, { ...packet, message: answer.message, additionalData: answer.additionalData });
}

if (process.argv[1]?.endsWith("writeAgentAnswer.ts")) {
    const packetFile = process.argv[2];
    if (packetFile === undefined || packetFile === "") {
        process.stderr.write(`usage: node writeAgentAnswer.ts <packetFile> <<'TTANSWER'\n{"message": "", "additionalData": {}}\nTTANSWER\n`);
        process.exit(1);
    }
    writeAgentAnswer(packetFile, readFileSync(0, "utf8"));
    process.stdout.write(`answer recorded in ${packetFile}\n`);
}
