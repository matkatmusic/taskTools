// Behavioral checks for runStartup.ts: read-only discovery, and the gate before every mutating step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    confirmTestHookEnabled,
    discoverStartupState,
    runGatedMutatingSteps,
    runStartup,
    type HookCheckResult,
} from "../scripts/runStartup.ts";

const RUN_STARTUP_SOURCE = readFileSync(join(import.meta.dirname, "..", "scripts", "runStartup.ts"), "utf8");
const HOOKS_JSON_PATH = join(import.meta.dirname, "..", "hooks", "hooks.json");

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-runStartup-"));
    writeFileSync(
        join(root, "tasks.json"),
        JSON.stringify([
            { taskNumber: 1, title: "open, unblocked" },
            { taskNumber: 2, title: "blocked by open task", blockedBy: [1] },
        ]),
    );
    writeFileSync(join(root, "completedTasks.json"), "[]");
    return root;
}

function makeHooksJson(dir: string, entryOptions: { present: boolean; enabled?: boolean }): string {
    const path = join(dir, "hooks.json");
    const hooks = entryOptions.present
        ? [
              {
                  matcher: "Edit|Write|NotebookEdit",
                  hooks: [
                      {
                          type: "command",
                          command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/relatedTests.ts"',
                          ...(entryOptions.enabled === undefined ? {} : { enabled: entryOptions.enabled }),
                      },
                  ],
              },
          ]
        : [];
    writeFileSync(path, JSON.stringify({ hooks: { PostToolUse: hooks } }));
    return path;
}

test("discovery reports blocked/unblocked open tasks and performs no writes", () => {
    const root = makeProjectRoot();
    const before = readFileSync(join(root, "tasks.json"), "utf8");
    const discovery = discoverStartupState(root);
    assert.deepEqual(discovery.unblockedTaskNumbers, [1]);
    assert.deepEqual(discovery.blockedTaskNumbers, [2]);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("confirmTestHookEnabled: missing entry point is not enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-hooks-"));
    const path = makeHooksJson(dir, { present: false });
    const result = confirmTestHookEnabled(path);
    assert.equal(result.enabled, false);
    assert.match(result.reason ?? "", /not registered/);
});

test("confirmTestHookEnabled: entry explicitly disabled is not enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-hooks-"));
    const path = makeHooksJson(dir, { present: true, enabled: false });
    const result = confirmTestHookEnabled(path);
    assert.equal(result.enabled, false);
    assert.match(result.reason ?? "", /disabled/);
});

test("confirmTestHookEnabled: registered entry with no enabled flag defaults to enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-hooks-"));
    const path = makeHooksJson(dir, { present: true });
    assert.equal(confirmTestHookEnabled(path).enabled, true);
});

type HookEntryFixture = { hooks?: { command?: string }[] };

test("hooks/hooks.json registers the copied relatedTests.ts entry point", () => {
    const parsed: { hooks: Record<string, HookEntryFixture[]> } = JSON.parse(readFileSync(HOOKS_JSON_PATH, "utf8"));
    const commands = Object.values(parsed.hooks)
        .flat()
        .flatMap((entry) => entry.hooks ?? [])
        .map((hook) => hook.command ?? "");
    assert.ok(
        commands.some((command) => command.includes("scripts/relatedTests.ts")),
        "expected an entry invoking scripts/relatedTests.ts",
    );
    assert.equal(confirmTestHookEnabled(HOOKS_JSON_PATH).enabled, true);
});

test("hook disabled: runStartup stops before any mutating step runs", () => {
    const worktreeCalls: string[] = [];
    const branchCalls: string[] = [];
    const result = runStartup({
        cwd: makeProjectRoot(),
        confirmHook: (): HookCheckResult => ({ enabled: false, reason: "test hook disabled" }),
        mutatingSteps: [() => worktreeCalls.push("worktree"), () => branchCalls.push("branch")],
    });
    assert.equal(result.stopped, true);
    assert.match(result.reason ?? "", /disabled/);
    assert.deepEqual(worktreeCalls, []);
    assert.deepEqual(branchCalls, []);
    assert.equal(result.stepsRun, 0);
});

test("gate precedes every mutating step individually, not just the first", () => {
    const callOrder: string[] = [];
    let hookCallCount = 0;
    const confirmHook = (): HookCheckResult => {
        hookCallCount++;
        callOrder.push(`gate-${hookCallCount}`);
        return { enabled: true };
    };
    const steps = [
        () => callOrder.push("step-1"),
        () => callOrder.push("step-2"),
        () => callOrder.push("step-3"),
    ];
    const result = runGatedMutatingSteps(steps, confirmHook);
    assert.equal(result.stopped, false);
    assert.equal(result.stepsRun, 3);
    assert.deepEqual(callOrder, ["gate-1", "step-1", "gate-2", "step-2", "gate-3", "step-3"]);
});

test("gate stopping mid-sequence prevents later steps from running", () => {
    const callOrder: string[] = [];
    let gateCallCount = 0;
    const confirmHook = (): HookCheckResult => {
        gateCallCount++;
        return { enabled: gateCallCount < 2 };
    };
    const steps = [() => callOrder.push("step-1"), () => callOrder.push("step-2"), () => callOrder.push("step-3")];
    const result = runGatedMutatingSteps(steps, confirmHook);
    assert.equal(result.stopped, true);
    assert.equal(result.stepsRun, 1);
    assert.deepEqual(callOrder, ["step-1"]);
});

test("runStartup's read-only discovery phase never calls the gate or a mutating step", () => {
    let confirmHookCalls = 0;
    const stepCalls: string[] = [];
    runStartup({
        cwd: makeProjectRoot(),
        confirmHook: () => {
            confirmHookCalls++;
            return { enabled: true };
        },
        mutatingSteps: [],
    });
    assert.equal(stepCalls.length, 0);
    assert.equal(confirmHookCalls, 0, "no mutating steps means the gate should never run");
});

test("runStartup.ts never references semantic-commit/push/merge/base-update/archival helpers", () => {
    const forbidden = [
        "archiveProcessed",
        "baseReconciliation",
        "repositoryIntegration",
        "mergeTaskWorktrees",
        "createBranchInEveryRepository",
    ];
    for (const name of forbidden) {
        assert.ok(!RUN_STARTUP_SOURCE.includes(name), `runStartup.ts must not reference ${name}`);
    }
});
