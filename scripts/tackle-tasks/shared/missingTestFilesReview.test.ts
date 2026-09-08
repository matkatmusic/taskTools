import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingTestFilesReview } from "./missingTestFilesReview.ts";

const SCRIPT_PATH = fileURLToPath(new URL("./missingTestFilesReview.ts", import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-tests-error-template.json", import.meta.url));

test("test_missingTestFilesReview_fillsMissingFilesAndKeepsEveryOtherTemplateKey", () => {
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    const review = JSON.parse(missingTestFilesReview(["/wt/plans/brief-99.md", "/wt/tests/thing.test.ts"]));
    assert.deepEqual(review, { ...template, missingFiles: ["/wt/plans/brief-99.md", "/wt/tests/thing.test.ts"] });
});

test("test_missingTestFilesReview_cliPrintsTheJsonForTheGivenPaths", () => {
    const stdout = execFileSync("node", [SCRIPT_PATH, "/wt/plans/brief-99.md"], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(stdout).missingFiles, ["/wt/plans/brief-99.md"]);
});
