// CLI behavior for validateCodexReview.ts: stdin JSON in, one line of JSON out.
// Run alone: node --test tests/tackle-tasks/validateCodexReview.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCodexReview } from "../../scripts/tackle-tasks/validateCodexReview.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/validateCodexReview.ts", import.meta.url));

function writeJsonFile(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "validate-codex-review-"));
    const filePath = join(dir, "codex-review.json");
    writeFileSync(filePath, JSON.stringify(value));
    return filePath;
}

function runCli(input: unknown, cwd?: string): unknown {
    const output = execFileSync("node", [cliPath], { input: JSON.stringify(input), encoding: "utf8", cwd });
    assert.equal(output.split("\n").filter((line) => line.length > 0).length, 1);
    return JSON.parse(output.trim());
}

test("test_validateCodexReview_returnsTheScrapNotesForAScrapVerdict", () => {
    const reviewFilePath = writeJsonFile({ verdict: "scrap", notes: "step-2 needs a file target" });
    const output = validateCodexReview({ projectRoot: "/repo", reviewFilePath });
    assert.deepEqual(output, {
        valid: true,
        problem: null,
        verdict: "scrap",
        scrapNotes: "step-2 needs a file target",
    });
});

test("test_validateCodexReview_returnsNullScrapNotesForAnAmendVerdict", () => {
    const reviewFilePath = writeJsonFile({ verdict: "amend", amendments: [{ op: "remove", id: "step-1" }] });
    const output = validateCodexReview({ projectRoot: "/repo", reviewFilePath });
    assert.equal(output.verdict, "amend");
    assert.equal(output.scrapNotes, null);
});

test("test_validateCodexReview_reportsInvalidWithNullVerdictForAMalformedReview", () => {
    const reviewFilePath = writeJsonFile({ verdict: "amend", amendments: [] });
    const output = validateCodexReview({ projectRoot: "/repo", reviewFilePath });
    assert.equal(output.valid, false);
    assert.equal(output.verdict, null);
    assert.ok(typeof output.problem === "string");
});

test("test_validateCodexReviewCli_printsOneLineOfJsonOnStdout", () => {
    const reviewFilePath = writeJsonFile({ verdict: "scrap", notes: "start over" });
    const output = runCli({ projectRoot: "/repo", reviewFilePath });
    assert.deepEqual(output, { valid: true, problem: null, verdict: "scrap", scrapNotes: "start over" });
});

test("test_validateCodexReviewCli_behavesIdenticallyFromAnUnrelatedCwd", () => {
    const reviewFilePath = writeJsonFile({ verdict: "scrap", notes: "start over" });
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-cwd-"));
    const output = runCli({ projectRoot: "/repo", reviewFilePath }, unrelatedCwd);
    assert.deepEqual(output, { valid: true, problem: null, verdict: "scrap", scrapNotes: "start over" });
});

test("test_validateCodexReviewCli_rejectsARelativeReviewFilePath", () => {
    const reviewFilePath = writeJsonFile({ verdict: "scrap", notes: "start over" });
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-cwd-"));
    const relativeReviewFilePath = relative(unrelatedCwd, reviewFilePath);
    assert.throws(() =>
        execFileSync("node", [cliPath], {
            input: JSON.stringify({ projectRoot: "/repo", reviewFilePath: relativeReviewFilePath }),
            encoding: "utf8",
            cwd: unrelatedCwd,
        }),
    );
});
