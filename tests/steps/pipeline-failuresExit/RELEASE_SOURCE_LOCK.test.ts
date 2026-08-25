// Behavioral checks for scripts/steps/pipeline-failuresExit/RELEASE_SOURCE_LOCK.ts.  Ported from tests/releaseTaskRunHolds.test.ts. Run: node --test tests/steps/pipeline-failuresExit/RELEASE_SOURCE_LOCK.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-failuresExit/RELEASE_SOURCE_LOCK.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-failuresExit/RELEASE_SOURCE_LOCK.template.json");

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "releaseSourceLock-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
}

function packet(projectRoot: string) {
    return JSON.stringify({
        box: "DOES_RUN_HOLD_SOURCE_LOCK", scriptSignal: "continue", next: "RELEASE_SOURCE_LOCK",
        taskNumber: 1, runId: "run-a", projectRoot, worktree: join(projectRoot, "worktree"),
        sourceBranch: "master", exitType: "run-failed", exitNote: "boom", publicationState: "NONE LANDED",
        modifiedFiles: [], active: false, endedAt: "2026-08-01T00:00:00-07:00",
        leaseReleased: true, leaseRetained: false, lockReleased: false,
    });
}

test("test_RELEASE_SOURCE_LOCK_releasesTheLockThisRunOwns", () => {
    const root = makeProjectRoot();
    acquireSourceRepoLock(root, buildLockOwner("run-a", 1));

    const output = main(packet(root));

    assert.equal(output.lockReleased, true);
    assert.equal(readSourceRepoLock(root), null);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});
