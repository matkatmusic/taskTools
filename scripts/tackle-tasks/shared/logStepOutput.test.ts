// Behavioral checks for scripts/tackle-tasks/logStepOutput.ts. Run: node --test tests/logStepOutput.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logStepOutput, stepOutputDirectory } from "./logStepOutput.ts";

test("test_logStepOutput_twoScriptsInSameRunAppendToOneRunLogInCallOrder", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "logStepOutput-"));
    const identity = { projectRoot, taskNumber: 169, runId: "run-abc" };

    logStepOutput(identity, {
        boxId: "LOCK_SOURCE_REPO",
        source: "scripts/tackle-tasks/lockSourceRepo.ts:19: lockSourceRepo",
        input: { taskNumber: 169 },
        command: "node lockSourceRepo.ts <<'TTLOCK'\n{}\nTTLOCK",
        commandOutput: '{"acquired":true}\n',
        output: { acquired: true },
    });
    logStepOutput(identity, {
        boxId: "DID_CHANGES_STAY_INSIDE_FENCE",
        source: "scripts/tackle-tasks/checkTaskFileFence.ts:76: checkTaskFileFence",
        input: { taskNumber: 169 },
        command: "node checkTaskFileFence.ts <<'TTFENCE'\n{}\nTTFENCE",
        commandOutput: '{"inside":true}\n',
        output: { inside: true },
    });

    const logPath = join(stepOutputDirectory(identity), "run-log.md");
    const log = readFileSync(logPath, "utf8");

    const firstHeaderIndex = log.indexOf("======= LOCK_SOURCE_REPO ======");
    const secondHeaderIndex = log.indexOf("======= DID_CHANGES_STAY_INSIDE_FENCE ======");
    assert.notEqual(firstHeaderIndex, -1, "first script's header not found");
    assert.notEqual(secondHeaderIndex, -1, "second script's header not found");
    assert.ok(firstHeaderIndex < secondHeaderIndex, "blocks are not in call order");
});
