// ADD_MISSING_FILES_TO_CREATES_FILES.ts is "add each missing file to createsFiles in tasks.json" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/ADD_MISSING_FILES_TO_CREATES_FILES.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ADD_MISSING_FILES_TO_CREATES_FILES.ts";

test("test_B_ADD_MISSING_FILES_TO_CREATES_FILES_movesEveryMissingFileIntoCreatesFilesAndKeepsItInModifiableFiles", () => {
    // Setup: task 900601 lists new.ts, which Q_INIT_SUBMODULES_RECURSIVELY found missing.
    const projectRoot = mkdtempSync(join(tmpdir(), "ADD_MISSING_FILES_TO_CREATES_FILES-"));
    mkdirSync(join(projectRoot, ".taskTools"));
    const tasksPath = join(projectRoot, ".taskTools", "tasks.json");
    writeFileSync(tasksPath, `${JSON.stringify([{ taskNumber: 900601, title: "t", modifiableFiles: ["seed.txt", "new.ts"] }], null, 2)}\n`);

    // Action: run the block with the packet Q_INIT_SUBMODULES_RECURSIVELY hands on.
    const output = main(JSON.stringify({
        box: "Q_INIT_SUBMODULES_RECURSIVELY", scriptSignal: "continue", taskNumber: 900601, runId: "run-a",
        projectRoot, worktree: "/unused", branch: "task-900601", docsMode: "UPDATE",
        planFile: "", exitType: "owned-file-missing", exitNote: "", missingFiles: ["new.ts"],
        next: "B_ADD_MISSING_FILES_TO_CREATES_FILES",
    }));

    // Verification: new.ts is in createsFiles and still in modifiableFiles; the block names no next.
    const task = JSON.parse(readFileSync(tasksPath, "utf8"))[0];
    assert.deepEqual(task.createsFiles, ["new.ts"]);
    assert.deepEqual(task.modifiableFiles, ["seed.txt", "new.ts"]);
    assert.equal(output.box, "B_ADD_MISSING_FILES_TO_CREATES_FILES");
    assert.equal("next" in output, false);
});
