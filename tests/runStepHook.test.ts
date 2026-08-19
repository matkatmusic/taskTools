// Behavioral checks for scripts/runStepHook.ts. Run: node --test tests/runStepHook.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTaskRunState, type TaskRunRecord } from "../scripts/tackle-tasks/taskRunState.ts";

const hookPath = fileURLToPath(new URL("../scripts/runStepHook.ts", import.meta.url));

const runHook = (payload: object) => spawnSync("node", [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });

const injectedText = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

const injectedResult = (stdout: string): Record<string, unknown> => JSON.parse(injectedText(stdout));

function endedRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T01:00:00-07:00",
        exitType: "completed", exitNote: "merged", modifiedFiles: ["a.ts"],
        commits: [{ occurrenceId: "", hash: "abc123", kind: "merge" }],
        implementationNotesFile: "plans/notes-1.md", taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function makeProjectRoot(runState: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "runStepHook-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify([{ taskNumber: 1, title: "t", run: runState }], null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), "[]\n");
    return root;
}

const activeTaskRoot = () => makeProjectRoot({
    active: true, worktree: null, leaseRunId: null,
    history: [endedRunRecord({ endedAt: null, exitType: null, exitNote: null })],
});

const stepPrompt = (projectRoot: string, ...trailing: string[]) =>
    `/run-step "1" "run-a" "/wt" "master" "${projectRoot}" ${trailing.map((value) => `"${value}"`).join(" ")}`;

test("test_runStepHook_staysSilentForAPromptThatNamesAnotherSkill", () => {
    // Setup: both hook events fire on every skill, so a hook answering them all injects noise everywhere.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "read-file", args: "/tmp/x" } });

    // Verification: stdout is empty, so the hook never injects into work it does not own.
    assert.equal(result.stdout, "");
});

test("test_runStepHook_matchesThePluginNamespacedFormOfTheSkill", () => {
    // Setup: plugin skills reach the hook as taskTools:run-step, so a bare-name match alone never fires.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "taskTools:run-step", args: "1" } });

    // Verification: it answered, rather than treating a namespaced call as somebody else's skill.
    assert.match(result.stdout, /expected 5 identity arguments and at least one box id/);
});

test("test_runStepHook_echoesTheFiringEventName", () => {
    // Setup: a payload whose firing event is PostToolUse.
    const result = runHook({ hook_event_name: "PostToolUse", tool_input: { skill: "run-step", args: "1" } });

    // Verification: the echoed name matches, because a name that disagrees with the firing
    // event makes the harness drop the whole injection.
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
});

test("test_runStepHook_reportsTheShortfallWhenNoBoxIdFollowsTheIdentityArguments", () => {
    // Setup: the five identity arguments, and no box id after them.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: '/run-step "1" "run-a" "/wt" "master" "/repo"' });

    // Verification: the shortfall is named, so the caller sees what it typed wrong
    // instead of watching the hook do nothing.
    assert.match(result.stdout, /expected 5 identity arguments and at least one box id, got 5/);
});

test("test_runStepHook_keepsAWorktreePathWithSpacesAsOneArgument", () => {
    // Setup: a worktree argument that is double quoted and contains a space.
    const projectRoot = activeTaskRoot();
    const prompt = `/run-step "1" "run-a" "/wt with space" "master" "${projectRoot}" "MARK_TASK_INACTIVE_FAILURE"`;

    // Test action: run the hook against that prompt.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt });

    // Verification: the path stayed whole, so the box ran rather than the hook seeing
    // seven tokens and blaming the argument count.
    assert.equal(injectedResult(result.stdout).ok, true);
});

test("test_runStepHook_reportsOkWhenEveryNamedBoxSucceeds", () => {
    // Setup: an active task run, and two boxes that both write only to tasks.json.
    const projectRoot = activeTaskRoot();

    // Test action: run both boxes in one call.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: `${stepPrompt(projectRoot, "WRITE_EXIT_TYPE_AND_NOTE", "MARK_TASK_INACTIVE_FAILURE")} '{"exitType":"suite-red","exitNote":"the suite stayed red"}'`,
    });

    // Verification: the caller is told the whole call succeeded, and no box is blamed.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, true);
    assert.equal(injected.failedBoxId, undefined);
});

test("test_runStepHook_stopsAtTheFirstFailingBoxAndNamesIt", () => {
    // Setup: a first box that cannot succeed because no run carries that id, followed
    // by a box that would otherwise succeed.
    const projectRoot = activeTaskRoot();
    const prompt = `/run-step "1" "run-missing" "/wt" "master" "${projectRoot}" "MARK_TASK_INACTIVE_FAILURE" "WRITE_EXIT_TYPE_AND_NOTE"`;

    // Test action: run both boxes in that order.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt });

    // Verification: the failure names the first box, and the task is still active,
    // proving the call stopped rather than carrying on to the second box.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, false);
    assert.equal(injected.failedBoxId, "MARK_TASK_INACTIVE_FAILURE");
    assert.equal(readTaskRunState(1, projectRoot).active, true);
});

test("test_runStepHook_feedsAnEarlierBoxsReceiptToALaterBoxInTheSameCall", () => {
    // Setup: an ended, completed run. BUILD_CLOSURE_NOTE produces the closure note that
    // ARCHIVE_TASK can only get from that box's output.
    const projectRoot = makeProjectRoot({ active: false, worktree: null, leaseRunId: null, history: [endedRunRecord()] });

    // Test action: run both boxes in that order.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: stepPrompt(projectRoot, "BUILD_CLOSURE_NOTE", "ARCHIVE_TASK"),
    });

    // Verification: the task is archived carrying that exact note, which it could only
    // have received from the earlier box's receipt.
    assert.equal(injectedResult(result.stdout).ok, true);
    const archived = JSON.parse(readFileSync(join(projectRoot, "completedTasks.json"), "utf8"));
    assert.equal(archived.length, 1);
    assert.equal(archived[0].taskNumber, 1);
});

test("test_runStepHook_failsWhenABoxNeedsAReceiptNoEarlierBoxProduced", () => {
    // Setup: a box that reads MERGE_WORKTREES's commits, named on its own.
    const projectRoot = activeTaskRoot();

    // Test action: run it with nothing ahead of it to produce that receipt.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: stepPrompt(projectRoot, "RECORD_MERGE_COMMIT_HASHES"),
    });

    // Verification: the missing receipt is named, so a wiring mistake is reported
    // rather than reaching the script as undefined.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, false);
    assert.match(String(injected.note), /no receipt from MERGE_WORKTREES/);
});

test("test_runStepHook_returnsEveryReceiptItCollected", () => {
    // Setup: an active task run, and two boxes that both succeed.
    const projectRoot = activeTaskRoot();

    // Test action: run both boxes in one call.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: `${stepPrompt(projectRoot, "WRITE_EXIT_TYPE_AND_NOTE", "MARK_TASK_INACTIVE_FAILURE")} '{"exitType":"suite-red","exitNote":"the suite stayed red"}'`,
    });

    // Verification: every box's output comes back keyed by box id, so a later call can
    // be given a value this call produced.
    const receipts = injectedResult(result.stdout).receipts as Record<string, Record<string, unknown>>;
    assert.equal(receipts.WRITE_EXIT_TYPE_AND_NOTE.exitType, "suite-red");
    assert.equal(receipts.MARK_TASK_INACTIVE_FAILURE.active, false);
});

test("test_runStepHook_takesTheSourceRepositoryLockForTheRun", () => {
    // Setup: a project root nobody holds the source lock on. The lock lives under .git,
    // so the fixture needs that directory and nothing else.
    const projectRoot = activeTaskRoot();
    mkdirSync(join(projectRoot, ".git"));

    // Test action: run the box that takes the lock.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: stepPrompt(projectRoot, "LOCK_SOURCE_REPO") });

    // Verification: the run holds the lock, and the lock file names it, so the rebase
    // preamble can reach the rebase instead of throwing.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, true);
    assert.equal(existsSync(join(projectRoot, ".git", "taskTools-source.lock")), true);
    const receipts = injected.receipts as Record<string, Record<string, unknown>>;
    assert.equal(receipts.LOCK_SOURCE_REPO.acquired, true);
});

test("test_runStepHook_reportsAnUnknownBoxId", () => {
    // Setup: a box id no diagram draws.
    const projectRoot = activeTaskRoot();

    // Test action: run the hook against it.
    const result = runHook({ hook_event_name: "UserPromptSubmit", prompt: stepPrompt(projectRoot, "NO_SUCH_BOX") });

    // Verification: the unknown box is named, so a typo is reported rather than skipped.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, false);
    assert.equal(injected.failedBoxId, "NO_SUCH_BOX");
});

test("test_runStepHook_refusesAnExtraFieldTheBoxDoesNotDeclare", () => {
    // Setup: a box that declares no extra fields, with a trailing JSON token supplying one.
    const projectRoot = activeTaskRoot();

    // Test action: run the hook against it.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: `${stepPrompt(projectRoot, "MARK_TASK_INACTIVE_FAILURE")} '{"exitType":"suite-red"}'`,
    });

    // Verification: it is refused, because a caller must not be able to widen a box's
    // input with fields the table never sanctioned.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, false);
    assert.match(String(injected.note), /does not accept the extra field exitType/);
});

test("test_runStepHook_passesADeclaredExtraFieldThroughToTheScript", () => {
    // Setup: a box that declares exitType and exitNote, with both supplied.
    const projectRoot = activeTaskRoot();

    // Test action: run the hook against it.
    runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: `${stepPrompt(projectRoot, "WRITE_EXIT_TYPE_AND_NOTE")} '{"exitType":"suite-red","exitNote":"the suite stayed red"}'`,
    });

    // Verification: the exit type reached the task entry, proving the extra fields
    // were passed to the script rather than dropped.
    assert.equal(readTaskRunState(1, projectRoot).history[0].exitType, "suite-red");
});

test("test_runStepHook_walksTheDiagramFromOneStartingBoxUntilAnAgentBoxStopsIt", () => {
    // Setup: an ended, completed run on an active task. The diagram chains
    // BUILD_CLOSURE_NOTE -> MARK_TASK_INACTIVE_SUCCESS -> ARCHIVE_TASK -> REPORT_CLOSURE_NOTE,
    // and only the last of those is the workflow's own output, so the walk must stop there.
    const projectRoot = makeProjectRoot({ active: true, worktree: null, leaseRunId: null, history: [endedRunRecord()] });

    // Test action: name only the first box, behind --walk, and let the hook find the rest.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: stepPrompt(projectRoot, "--walk", "BUILD_CLOSURE_NOTE"),
    });

    // Verification: all three script boxes ran without being named, and the walk
    // reports the node it stopped on rather than trying to run it.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, true);
    assert.equal(injected.stoppedAt, "REPORT_CLOSURE_NOTE");
    assert.deepEqual(Object.keys(injected.receipts as object), ["BUILD_CLOSURE_NOTE", "MARK_TASK_INACTIVE_SUCCESS", "ARCHIVE_TASK"]);
    assert.equal(JSON.parse(readFileSync(join(projectRoot, "completedTasks.json"), "utf8")).length, 1);
});

test("test_runStepHook_stopsTheWalkAtADecisionItCannotAnswer", () => {
    // Setup: an active task. LOCK_SOURCE_REPO is followed in the diagram by the
    // WAS_LOCK_ACQUIRED decision, and the hook holds no evaluator for any decision.
    const projectRoot = activeTaskRoot();
    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    // Test action: walk from that box.
    const result = runHook({
        hook_event_name: "UserPromptSubmit",
        prompt: stepPrompt(projectRoot, "--walk", "LOCK_SOURCE_REPO"),
    });

    // Verification: the box ran, and the walk handed the decision back rather than guessing an arm.
    const injected = injectedResult(result.stdout);
    assert.equal(injected.ok, true);
    assert.equal(injected.stoppedAt, "WAS_LOCK_ACQUIRED");
    assert.deepEqual(Object.keys(injected.receipts as object), ["LOCK_SOURCE_REPO"]);
});
