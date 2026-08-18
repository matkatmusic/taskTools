// Behavioral checks for scripts/tackle-tasks/runFullSuite.ts. Run: node --test tests/runFullSuite.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideFullSuiteVerdict } from "../scripts/tackle-tasks/runFullSuite.ts";

// A result file this script wrote, so the verdict has the full shape to narrow.
function makeResultFile(passed: boolean): string {
    const path = join(mkdtempSync(join(tmpdir(), "run-full-suite-")), "full-suite-35.json");
    writeFileSync(path, JSON.stringify({
        stepId: "run the full suite", passed,
        layers: [{ occurrenceId: "", passed }], output: "8000 chars of test output",
    }));
    return path;
}

test("test_decideFullSuiteVerdict_narrowsTheResultFileToPassedAlone", () => {
    // The agent relays this verbatim, so stepId, layers and output must not ride along.
    assert.deepEqual(decideFullSuiteVerdict(makeResultFile(false)), { passed: false });
    assert.deepEqual(decideFullSuiteVerdict(makeResultFile(true)), { passed: true });
});
