import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../scripts/hooks/workflowLivenessHook.ts", import.meta.url));

function runHook(payload: unknown): string {
    return execFileSync("node", ["--no-inspect", hookPath], { input: JSON.stringify(payload), encoding: "utf8" });
}

function workflowPayload(projectRoot: string, task: number, cwd: string = projectRoot) {
    return {
        hook_event_name: "PostToolUse",
        tool_name: "Workflow",
        tool_input: { scriptPath: "/some/workflow.js", args: { task, tasksFile: join(projectRoot, ".taskTools", "tasks.json") } },
        cwd,
    };
}

function runsDirFor(projectRoot: string): string {
    const runsDir = join(projectRoot, ".taskTools", "runs");
    mkdirSync(runsDir, { recursive: true });
    return runsDir;
}

test("test_workflowLivenessHook_printsNoLogYetWhenNoneExists", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const stdout = runHook(workflowPayload(projectRoot, 7));
    const { additionalContext } = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(additionalContext, "no run log yet for task 7");
});

test("test_workflowLivenessHook_printsTheFirstBlockNameAndAgeFromTheNewestRunLog", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const stampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(
        join(stampDir, "task-7-run-log.json"),
        JSON.stringify([{ block: "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK", duration: "1 ms", durationMs: 1 }]),
    );
    const stdout = runHook(workflowPayload(projectRoot, 7));
    const { additionalContext } = JSON.parse(stdout).hookSpecificOutput;
    assert.match(additionalContext, /PREAMBLE_STATUS_CHECK/);
    assert.match(additionalContext, /\d+s old/);
});

test("test_workflowLivenessHook_picksTheNewestRunLogWhenMultipleExistForTheTask", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const runsDir = runsDirFor(projectRoot);
    const olderDir = join(runsDir, "2026-09-05T00-00-00-1");
    const newerDir = join(runsDir, "2026-09-05T00-05-00-2");
    mkdirSync(olderDir, { recursive: true });
    mkdirSync(newerDir, { recursive: true });
    const olderPath = join(olderDir, "task-7-run-log.json");
    const newerPath = join(newerDir, "task-7-run-log.json");
    writeFileSync(olderPath, JSON.stringify([{ block: "OLD_BLOCK", duration: "1 ms", durationMs: 1 }]));
    writeFileSync(newerPath, JSON.stringify([{ block: "NEW_BLOCK", duration: "1 ms", durationMs: 1 }]));
    const oldTime = new Date("2026-09-05T00:00:00Z");
    const newTime = new Date("2026-09-05T00:05:00Z");
    utimesSync(olderPath, oldTime, oldTime);
    utimesSync(newerPath, newTime, newTime);
    const stdout = runHook(workflowPayload(projectRoot, 7));
    const { additionalContext } = JSON.parse(stdout).hookSpecificOutput;
    assert.match(additionalContext, /NEW_BLOCK/);
    assert.doesNotMatch(additionalContext, /OLD_BLOCK/);
});

test("test_workflowLivenessHook_usesTasksFileNotCwdToFindTheProject", () => {
    // The session cwd points at an unrelated directory; args.tasksFile names the fixture repo.
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "workflow-liveness-unrelated-"));
    const stampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, "task-7-run-log.json"), JSON.stringify([{ block: "FROM_FIXTURE_REPO" }]));
    const stdout = runHook(workflowPayload(projectRoot, 7, unrelatedCwd));
    const { additionalContext } = JSON.parse(stdout).hookSpecificOutput;
    assert.match(additionalContext, /FROM_FIXTURE_REPO/);
});

test("test_workflowLivenessHook_reportsAStaleLogHonestlyWhenANewLaunchFailedBeforeWritingAnything", () => {
    // A stale log must be reported honestly, even after a new launch fails before writing anything.
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const staleStampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(staleStampDir, { recursive: true });
    const staleLogPath = join(staleStampDir, "task-7-run-log.json");
    writeFileSync(staleLogPath, JSON.stringify([{ block: "OLD_LAUNCH_BLOCK" }]));
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staleLogPath, oneHourAgo, oneHourAgo);
    const stdout = runHook(workflowPayload(projectRoot, 7));
    const { additionalContext } = JSON.parse(stdout).hookSpecificOutput;
    assert.match(additionalContext, /OLD_LAUNCH_BLOCK/);
    const ageSeconds = Number(additionalContext.match(/(\d+)s old/)![1]);
    assert.ok(ageSeconds >= 3500, `reported age was only ${ageSeconds}s`);
});

test("test_workflowLivenessHook_staysSilentForAToolThatIsNotWorkflow", () => {
    const stdout = execFileSync("node", ["--no-inspect", hookPath], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: {} }),
        encoding: "utf8",
    });
    assert.equal(stdout.trim(), "");
});

test("test_workflowLivenessHook_staysSilentWhenArgsTaskIsMissing", () => {
    const stdout = execFileSync("node", ["--no-inspect", hookPath], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Workflow", tool_input: { args: { tasksFile: "/some/.taskTools/tasks.json" } } }),
        encoding: "utf8",
    });
    assert.equal(stdout.trim(), "");
});

test("test_workflowLivenessHook_staysSilentWhenArgsTasksFileIsMissing", () => {
    const stdout = execFileSync("node", ["--no-inspect", hookPath], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Workflow", tool_input: { args: { task: 7 } } }),
        encoding: "utf8",
    });
    assert.equal(stdout.trim(), "");
});

test("test_workflowLivenessHook_reportsUnreadableForInvalidJson", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const stampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, "task-7-run-log.json"), "{not valid json");
    const stdout = runHook(workflowPayload(projectRoot, 7));
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /unreadable/);
});

test("test_workflowLivenessHook_reportsUnreadableForANonArray", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const stampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, "task-7-run-log.json"), JSON.stringify({ not: "an array" }));
    const stdout = runHook(workflowPayload(projectRoot, 7));
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /unreadable/);
});

test("test_workflowLivenessHook_reportsEmptyForAnEmptyArray", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const stampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, "task-7-run-log.json"), "[]");
    const stdout = runHook(workflowPayload(projectRoot, 7));
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /empty/);
});

test("test_workflowLivenessHook_reportsUnreadableWhenTheFirstEntryHasNoBlockField", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "workflow-liveness-"));
    const stampDir = join(runsDirFor(projectRoot), "2026-09-05T00-00-00-1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, "task-7-run-log.json"), JSON.stringify([{ duration: "1 ms" }]));
    const stdout = runHook(workflowPayload(projectRoot, 7));
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /unreadable/);
});
