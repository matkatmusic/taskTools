import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAgentAnswer } from "./writeAgentAnswer.ts";

const SCRIPT_PATH = fileURLToPath(new URL("./writeAgentAnswer.ts", import.meta.url));

function makePacketFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "write-agent-answer-"));
    const packetFile = join(dir, "A-1.json");
    writeFileSync(packetFile, JSON.stringify({ box: "A", taskNumber: 7, prompt: "answer", startedAt: 123 }));
    return packetFile;
}

test("test_writeAgentAnswer_mergesTheAnswerAndKeepsEveryExistingKey", () => {
    const packetFile = makePacketFile();
    writeAgentAnswer(packetFile, JSON.stringify({ message: "", additionalData: { outcome: "PLAN" } }));
    const written = JSON.parse(readFileSync(packetFile, "utf8"));
    assert.deepEqual(written, { box: "A", taskNumber: 7, prompt: "answer", startedAt: 123, message: "", additionalData: { outcome: "PLAN" } });
});

test("test_writeAgentAnswer_throwsOnMalformedAnswerJsonAndLeavesThePacketUntouched", () => {
    const packetFile = makePacketFile();
    const before = readFileSync(packetFile, "utf8");
    assert.throws(() => writeAgentAnswer(packetFile, '{"message": "", "additionalData": {"q": "truncated'));
    assert.equal(readFileSync(packetFile, "utf8"), before);
});

test("test_writeAgentAnswer_throwsWhenMessageOrAdditionalDataIsMissing", () => {
    const packetFile = makePacketFile();
    assert.throws(() => writeAgentAnswer(packetFile, JSON.stringify({ additionalData: {} })), /no string "message"/);
    assert.throws(() => writeAgentAnswer(packetFile, JSON.stringify({ message: "" })), /no object "additionalData"/);
});

test("test_writeAgentAnswer_cliReadsTheAnswerFromStdin", () => {
    const packetFile = makePacketFile();
    const stdout = execFileSync("node", [SCRIPT_PATH, packetFile], {
        input: JSON.stringify({ message: "", additionalData: { outcome: "PLAN" } }),
        encoding: "utf8",
    });
    assert.equal(stdout, `answer recorded in ${packetFile}\n`);
    assert.equal(JSON.parse(readFileSync(packetFile, "utf8")).additionalData.outcome, "PLAN");
});
