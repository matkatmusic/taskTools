// CLI behavior for validatePlanFile.ts: stdin JSON in, one line of JSON out.
// Run alone: node --test tests/tackle-tasks/validatePlanFile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlanFile } from "../../scripts/tackle-tasks/validatePlanFile.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/validatePlanFile.ts", import.meta.url));

function writeJsonFile(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "validate-plan-file-"));
    const filePath = join(dir, "plan.json");
    writeFileSync(filePath, JSON.stringify(value));
    return filePath;
}

function runCli(input: unknown, cwd?: string): unknown {
    const output = execFileSync("node", [cliPath], { input: JSON.stringify(input), encoding: "utf8", cwd });
    assert.equal(output.split("\n").filter((line) => line.length > 0).length, 1);
    return JSON.parse(output.trim());
}

test("test_validatePlanFile_reportsValidWithSectionIdsForAWellFormedPlan", () => {
    const planFilePath = writeJsonFile({
        task: 42,
        revision: 1,
        sections: [{ id: "problem", title: "Problem", body: "b" }, { id: "step-1", title: "Step", body: "b" }],
    });
    const output = validatePlanFile({ projectRoot: "/repo", planFilePath, taskNumber: 42 });
    assert.deepEqual(output, { valid: true, problem: null, sectionIds: ["problem", "step-1"] });
});

test("test_validatePlanFile_reportsInvalidWithAProblemAndNoSectionIds", () => {
    const planFilePath = writeJsonFile({ task: 42, revision: 1, sections: [] });
    const output = validatePlanFile({ projectRoot: "/repo", planFilePath, taskNumber: 42 });
    assert.equal(output.valid, false);
    assert.ok(typeof output.problem === "string");
    assert.deepEqual(output.sectionIds, []);
});

test("test_validatePlanFileCli_printsOneLineOfJsonOnStdout", () => {
    const planFilePath = writeJsonFile({
        task: 7,
        revision: 1,
        sections: [{ id: "problem", title: "Problem", body: "b" }],
    });
    const output = runCli({ projectRoot: "/repo", planFilePath, taskNumber: 7 });
    assert.deepEqual(output, { valid: true, problem: null, sectionIds: ["problem"] });
});

test("test_validatePlanFileCli_behavesIdenticallyFromAnUnrelatedCwd", () => {
    const planFilePath = writeJsonFile({
        task: 7,
        revision: 1,
        sections: [{ id: "problem", title: "Problem", body: "b" }],
    });
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-cwd-"));
    const output = runCli({ projectRoot: "/repo", planFilePath, taskNumber: 7 }, unrelatedCwd);
    assert.deepEqual(output, { valid: true, problem: null, sectionIds: ["problem"] });
});

test("test_validatePlanFileCli_rejectsARelativePlanFilePath", () => {
    const planFilePath = writeJsonFile({
        task: 7,
        revision: 1,
        sections: [{ id: "problem", title: "Problem", body: "b" }],
    });
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-cwd-"));
    const relativePlanFilePath = relative(unrelatedCwd, planFilePath);
    assert.throws(() =>
        execFileSync("node", [cliPath], {
            input: JSON.stringify({ projectRoot: "/repo", planFilePath: relativePlanFilePath, taskNumber: 7 }),
            encoding: "utf8",
            cwd: unrelatedCwd,
        }),
    );
});
