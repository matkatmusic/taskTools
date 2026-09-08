import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReviewAnswer } from "./writeReviewAnswer.ts";

const SCRIPT_PATH = fileURLToPath(new URL("./writeReviewAnswer.ts", import.meta.url));

function makePacketFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "write-review-answer-"));
    const packetFile = join(dir, "A-1.json");
    writeFileSync(packetFile, JSON.stringify({ box: "A", taskNumber: 7, prompt: "answer", startedAt: 123 }));
    return packetFile;
}

test("test_writeReviewAnswer_writesTheReviewFilePathAsAdditionalData", () => {
    const packetFile = makePacketFile();
    writeReviewAnswer(packetFile, "/wt/plans/codex-review-7.json");
    const written = JSON.parse(readFileSync(packetFile, "utf8"));
    assert.deepEqual(written, { box: "A", taskNumber: 7, prompt: "answer", startedAt: 123, message: "", additionalData: { reviewFile: "/wt/plans/codex-review-7.json" } });
});

test("test_writeReviewAnswer_cliTakesThePacketAndReviewFileAsArgs", () => {
    const packetFile = makePacketFile();
    const stdout = execFileSync("node", [SCRIPT_PATH, packetFile, "/wt/plans/codex-review-7.json"], { encoding: "utf8" });
    assert.equal(stdout, `answer recorded in ${packetFile}\n`);
    assert.equal(JSON.parse(readFileSync(packetFile, "utf8")).additionalData.reviewFile, "/wt/plans/codex-review-7.json");
});
