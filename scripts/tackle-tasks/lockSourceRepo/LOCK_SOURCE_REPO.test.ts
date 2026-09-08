// The LOCK_SOURCE_REPO box runs inside run-step, so it tries once and never waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./LOCK_SOURCE_REPO.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "LOCK_SOURCE_REPO.template.json");
const LOCK_WAIT_STARTED_AT = "2024-01-01T00:00:00.000Z";

const projectRootWithGit = (): string => {
    const root = mkdtempSync(join(tmpdir(), "LOCK_SOURCE_REPO-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
};

const BASE_INPUT = { taskNumber: 1, worktree: "/wt", branch: "task-1", exitType: "", exitNote: "" };

test("test_lockSourceRepo_takesTheLockWhenNobodyHoldsIt", () => {
    // Setup: a repo whose lock is free.
    const projectRoot = projectRootWithGit();

    // Test action: ask for the lock.
    const result = main(JSON.stringify({
        ...BASE_INPUT, runId: "run-a", projectRoot, lockWaitStartedAt: LOCK_WAIT_STARTED_AT,
    }));

    // Verification: it is held by this run.
    assert.equal(result.box, "LOCK_SOURCE_REPO");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.acquired, true);
    assert.equal(result.heldByOwner, "");
    assert.equal(result.runId, "run-a");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.projectRoot, projectRoot);
    assert.equal(result.worktree, "/wt");
    assert.equal(result.branch, "task-1");
    assert.equal(result.lockWaitStartedAt, LOCK_WAIT_STARTED_AT);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, result), []);
});

test("test_lockSourceRepo_returnsAtOnceWhenAnotherRunHoldsTheLock", () => {
    // Setup: another run already owns the lock, and its heartbeat is fresh.
    const projectRoot = projectRootWithGit();
    const rival = buildLockOwner("run-rival", 9);
    assert.equal(acquireSourceRepoLock(projectRoot, rival).status, "acquired");

    // Test action: ask for the lock, timing how long the answer takes.
    const startedAt = Date.now();
    const result = main(JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot, lockWaitStartedAt: LOCK_WAIT_STARTED_AT }));
    const elapsedMs = Date.now() - startedAt;

    // Verification: it reports the holder instead of polling, so a hook's budget survives.
    assert.equal(result.acquired, false);
    assert.equal(result.heldByOwner, rival);
    assert.ok(elapsedMs < 1_000, `waited ${elapsedMs}ms instead of answering at once`);
});

test("test_lockSourceRepo_stampsTheWaitClockOnceOnFirstEntry", () => {
    // Setup: fresh entry into the diagram, no lockWaitStartedAt yet.
    const projectRoot = projectRootWithGit();

    // Test action: ask for the lock without a wait clock.
    const before = Date.now();
    const result = main(JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot }));

    // Verification: it stamps the clock to now.
    assert.ok(Date.parse(result.lockWaitStartedAt as string) >= before);
});

test("test_lockSourceRepo_rejectsARelativeProjectRoot", () => {
    assert.throws(() => main(JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot: "relative/path", lockWaitStartedAt: LOCK_WAIT_STARTED_AT })));
});

test("test_LOCK_SOURCE_REPO_runsTwiceWithTheSameInput", () => {
    // Setup: a repo whose lock is free.
    const projectRoot = projectRootWithGit();
    const input = JSON.stringify({ ...BASE_INPUT, runId: "run-a", projectRoot, lockWaitStartedAt: LOCK_WAIT_STARTED_AT });

    // Test action: acquire the lock, then run the same block again (a resumed run re-taking its own lock).
    const firstOutput = main(input);
    const secondOutput = main(input);

    // Verification: the second call still reports the lock as its own, no throw, same answer.
    assert.deepEqual(secondOutput, firstOutput);
    assert.equal(secondOutput.acquired, true);
});
