// Behavioral checks for scripts/tackle-tasks/PreambleDataEmitter.ts.
// Run: node --test tests/PreambleDataEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitPreambleData } from "../scripts/tackle-tasks/PreambleDataEmitter.ts";

const cliPath = fileURLToPath(new URL("../scripts/tackle-tasks/PreambleDataEmitter.ts", import.meta.url));

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

// A plain project root with tasks.json/completedTasks.json — enough for the read-only,
// tasks.json-only modes. No git repo needed for these.
function makeProjectFixture(taskNumber: number): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "preamble-data-emitter-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{ taskNumber, title: "sample task", files: [] }]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    return projectRoot;
}

// A real git repo with one commit and the same task record, for the modes that create or
// inspect a real worktree (create-worktree, worktree-safe, generate-docs, init-submodules,
// run-resumable, update-docs, reset-worktree).
function makeGitProjectFixture(taskNumber: number): string {
    const projectRoot = mkdtempSync(join(tmpdir(), "preamble-data-emitter-git-"));
    git(projectRoot, "init", "-q", "-b", "main");
    git(projectRoot, "config", "user.email", "test@example.com");
    git(projectRoot, "config", "user.name", "Test");
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([{ taskNumber, title: "sample task", files: [] }]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    git(projectRoot, "add", "-A");
    git(projectRoot, "commit", "-q", "-m", "seed");
    return projectRoot;
}

function runCli(taskNumber: number, mode: string, payload: unknown): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("node", [cliPath, String(taskNumber), mode], {
        input: JSON.stringify(payload),
        encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Asserts the DATA section is the last thing in the prompt, and that it holds the raw result.
function assertDataIsLast(prompt: string): void {
    const marker = "---- DATA ----";
    const markerIndex = prompt.indexOf(marker);
    assert.ok(markerIndex >= 0, "prompt has no DATA marker");
    const afterMarker = prompt.slice(markerIndex + marker.length);
    // Nothing after the DATA section's own content should reopen instructions/prose.
    assert.ok(afterMarker.trim().startsWith("RESULT ="), "DATA section does not start with RESULT");
    assert.equal(prompt.lastIndexOf(marker), markerIndex, "more than one DATA marker");
}

let nextTaskNumber = 8001;

test("test_preambleDataEmitter_readOnlyModesProduceNonEmptyPromptsWithDataLast", () => {
    const taskNumber = nextTaskNumber++;
    const projectRoot = makeProjectFixture(taskNumber);
    const readOnlyModes: [string, unknown][] = [
        ["task-number-valid", { projectRoot }],
        ["task-blocked", { projectRoot }],
        ["worktree-exists", { projectRoot }],
        ["validate-active-task-receipt", {
            receipt: { taskNumber, worktree: "/abs/worktree", branch: "task-1", briefFile: "/abs/worktree/plans/brief-1.md", initialized: false },
        }],
    ];
    for (const [mode, payload] of readOnlyModes) {
        const prompt = emitPreambleData(taskNumber, mode, payload as any);
        assert.ok(prompt.length > 0, `mode "${mode}" produced an empty prompt`);
        assertDataIsLast(prompt);
    }
});

test("test_preambleDataEmitter_claimTaskProducesANonEmptyPromptWithDataLast", () => {
    const taskNumber = nextTaskNumber++;
    const projectRoot = makeProjectFixture(taskNumber);
    const prompt = emitPreambleData(taskNumber, "claim-task", { projectRoot, runId: "run-1" });
    assert.ok(prompt.length > 0);
    assert.match(prompt, /"status":"claimed"/);
    assertDataIsLast(prompt);
});

test("test_preambleDataEmitter_worktreeLifecycleModesProduceNonEmptyPromptsWithDataLast", () => {
    const taskNumber = nextTaskNumber++;
    const projectRoot = makeGitProjectFixture(taskNumber);
    const runId = "run-lifecycle-1";

    // create-worktree records task.run.worktree onto the active run — claim-task must run first,
    // same order the preamble pipeline itself follows.
    emitPreambleData(taskNumber, "claim-task", { projectRoot, runId });

    const createPrompt = emitPreambleData(taskNumber, "create-worktree", { projectRoot, runId });
    assert.ok(createPrompt.length > 0);
    assertDataIsLast(createPrompt);
    const created = JSON.parse(createPrompt.slice(createPrompt.indexOf("RESULT =\n") + "RESULT =\n".length)) as { worktree: string; branch: string };
    assert.equal(created.branch, `task-${taskNumber}`);

    const safePrompt = emitPreambleData(taskNumber, "worktree-safe", { worktreePath: created.worktree });
    assert.ok(safePrompt.length > 0);
    assert.match(safePrompt, /"safe":true/);
    assertDataIsLast(safePrompt);

    const docsPrompt = emitPreambleData(taskNumber, "generate-docs", { worktreePath: created.worktree, projectRoot });
    assert.ok(docsPrompt.length > 0);
    assert.match(docsPrompt, /brief-\d+\.md/);
    assertDataIsLast(docsPrompt);

    const updateDocsPrompt = emitPreambleData(taskNumber, "update-docs", { worktreePath: created.worktree, projectRoot });
    assert.ok(updateDocsPrompt.length > 0);
    assertDataIsLast(updateDocsPrompt);

    const submodulesPrompt = emitPreambleData(taskNumber, "init-submodules", {
        worktreePath: created.worktree, runId, projectRoot, stepId: "step-1",
    });
    assert.ok(submodulesPrompt.length > 0);
    assert.match(submodulesPrompt, /"initialized":false/);
    assertDataIsLast(submodulesPrompt);

    const resumablePrompt = emitPreambleData(taskNumber, "run-resumable", { worktreePath: created.worktree, runId, projectRoot });
    assert.ok(resumablePrompt.length > 0);
    assert.match(resumablePrompt, /"leaseEstablished":true/);
    assertDataIsLast(resumablePrompt);

    const resetPrompt = emitPreambleData(taskNumber, "reset-worktree", { projectRoot, runId });
    assert.ok(resetPrompt.length > 0);
    assertDataIsLast(resetPrompt);
});

test("test_preambleDataEmitterCli_exitsNonZeroOnAnUnknownMode", () => {
    const taskNumber = nextTaskNumber++;
    const projectRoot = makeProjectFixture(taskNumber);
    const result = runCli(taskNumber, "not-a-real-mode", { projectRoot });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown mode "not-a-real-mode"/);
});

test("test_preambleDataEmitter_unknownModeThrowsNamingTheMode", () => {
    const taskNumber = nextTaskNumber++;
    assert.throws(
        () => emitPreambleData(taskNumber, "not-a-real-mode", {}),
        /unknown mode "not-a-real-mode"/,
    );
});

test("test_preambleDataEmitterCli_failsLoudlyOnAPayloadMissingARequiredField", () => {
    const taskNumber = nextTaskNumber++;
    // task-open requires "projectRoot" — omit it entirely.
    const result = runCli(taskNumber, "task-blocked", {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /payload missing "projectRoot"/);
});

test("test_preambleDataEmitter_missingRequiredFieldThrowsForEveryMode", () => {
    const taskNumber = nextTaskNumber++;
    const projectRoot = makeProjectFixture(taskNumber);
    const fullPayloads: Record<string, unknown> = {
        "task-number-valid": { projectRoot },
        "claim-task": { projectRoot, runId: "run-1" },
        "task-blocked": { projectRoot },
        "worktree-exists": { projectRoot },
        "worktree-safe": { worktreePath: "/abs/worktree" },
        "run-resumable": { worktreePath: "/abs/worktree", runId: "run-1", projectRoot },
        "create-worktree": { runId: "run-1", projectRoot },
        "reset-worktree": { runId: "run-1", projectRoot },
        "generate-docs": { worktreePath: "/abs/worktree", projectRoot },
        "update-docs": { worktreePath: "/abs/worktree", projectRoot },
        "init-submodules": { worktreePath: "/abs/worktree", runId: "run-1", projectRoot, stepId: "step-1" },
        "validate-active-task-receipt": { receipt: {} },
    };
    for (const [mode, payload] of Object.entries(fullPayloads)) {
        for (const field of Object.keys(payload as object)) {
            const broken = { ...(payload as Record<string, unknown>) };
            delete broken[field];
            assert.throws(
                () => emitPreambleData(taskNumber, mode, broken),
                new RegExp(`missing "${field}"`),
                `mode "${mode}" did not fail loudly when "${field}" was missing`,
            );
        }
    }
});
