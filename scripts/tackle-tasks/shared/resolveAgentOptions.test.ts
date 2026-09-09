// Behavioral checks for scripts/tackle-tasks/shared/resolveAgentOptions.ts.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentOptions, BAND_BLOCKS } from "./resolveAgentOptions.ts";
import type { StepConfig } from "../generateSteps.ts";

const CANONICAL_STEPS_CONFIG_PATH = fileURLToPath(new URL("../diagram-steps.json", import.meta.url));

function makeStepsConfig(): string {
    const folder = mkdtempSync(join(tmpdir(), "resolve-agent-options-steps-"));
    const configPath = join(folder, "steps.json");
    const config: StepConfig = {
        "one.mmd": [
            { box: "IMPLEMENT_TASK", script: "", template: "", producesPrompt: true, next: [] },
            { box: "PLAN_THE_TASK", script: "", template: "", producesPrompt: true, next: [] },
            { box: "CODEX_REVIEWS_PLAN", script: "", template: "", producesPrompt: true, next: [] },
            { box: "IS_DIFFICULTY_7_PLUS_Q", script: "", template: "", producesPrompt: false, next: [] },
            { box: "CODEX_REVIEW_FALLBACK_FABLE", script: "", template: "", producesPrompt: true, next: [] },
            { box: "CODEX_TEST_REVIEW_FALLBACK_OPUS", script: "", template: "", producesPrompt: true, next: [] },
        ],
    };
    writeFileSync(configPath, JSON.stringify(config, null, 4));
    return configPath;
}

function makeTasksFile(tasks: Record<string, unknown>[]): string {
    const folder = mkdtempSync(join(tmpdir(), "resolve-agent-options-tasks-"));
    const tasksPath = join(folder, "tasks.json");
    writeFileSync(tasksPath, JSON.stringify(tasks));
    return tasksPath;
}

function readConfig(configPath: string): StepConfig {
    return JSON.parse(readFileSync(configPath, "utf8"));
}

function findEntry(config: StepConfig, box: string) {
    for (const entries of Object.values(config)) {
        const entry = entries.find((candidate) => candidate.box === box);
        if (entry !== undefined) return entry;
    }
    throw new Error(`box ${box} not found`);
}

test("test_resolveAgentOptions_picksTheBandWithTheLargestMinDifficultyNotAboveTheTask", () => {
    const stepsConfigPath = makeStepsConfig();
    const tasksFile = makeTasksFile([
        { taskNumber: 1, difficulty: 4 },
        { taskNumber: 2, difficulty: 5 },
        { taskNumber: 3, difficulty: 7 },
        { taskNumber: 4, difficulty: 8 },
    ]);

    resolveAgentOptions(stepsConfigPath, tasksFile, 1);
    assert.deepEqual(findEntry(readConfig(stepsConfigPath), "PLAN_THE_TASK").agent, { model: "claude-opus-4-8[1m]", effort: "high", agentType: "task-1-plan-the-task" });
    assert.deepEqual(findEntry(readConfig(stepsConfigPath), "IMPLEMENT_TASK").agent, { model: "claude-sonnet-5[1m]", effort: "high", agentType: "task-1-implement-task" });

    resolveAgentOptions(stepsConfigPath, tasksFile, 2);
    assert.deepEqual(findEntry(readConfig(stepsConfigPath), "PLAN_THE_TASK").agent, { model: "claude-sonnet-5[1m]", effort: "high", agentType: "task-2-plan-the-task" });

    resolveAgentOptions(stepsConfigPath, tasksFile, 3);
    assert.deepEqual(findEntry(readConfig(stepsConfigPath), "PLAN_THE_TASK").agent, { model: "claude-fable-5-1[1m]", effort: "medium", agentType: "task-3-plan-the-task" });

    resolveAgentOptions(stepsConfigPath, tasksFile, 4);
    assert.deepEqual(findEntry(readConfig(stepsConfigPath), "PLAN_THE_TASK").agent, { model: "claude-fable-5-1[1m]", effort: "medium", agentType: "task-4-plan-the-task" });
});

test("test_resolveAgentOptions_usesTheTaskOverrideForThatBlockOnly", () => {
    const stepsConfigPath = makeStepsConfig();
    const tasksFile = makeTasksFile([
        { taskNumber: 1, difficulty: 4, agent: { PLAN_THE_TASK: { model: "custom-model", effort: "custom-effort" } } },
    ]);

    resolveAgentOptions(stepsConfigPath, tasksFile, 1);
    const config = readConfig(stepsConfigPath);
    assert.deepEqual(findEntry(config, "PLAN_THE_TASK").agent, { model: "custom-model", effort: "custom-effort", agentType: "task-1-plan-the-task" });
    assert.deepEqual(findEntry(config, "IMPLEMENT_TASK").agent, { model: "claude-sonnet-5[1m]", effort: "high", agentType: "task-1-implement-task" });
});

test("test_resolveAgentOptions_givesTheRelayAgentToEveryBlockOutsideTheBandSet", () => {
    const stepsConfigPath = makeStepsConfig();
    const tasksFile = makeTasksFile([{ taskNumber: 1, difficulty: 4 }]);

    resolveAgentOptions(stepsConfigPath, tasksFile, 1);
    const config = readConfig(stepsConfigPath);
    assert.deepEqual(findEntry(config, "IS_DIFFICULTY_7_PLUS_Q").agent, { model: "sonnet", effort: "low" });
    assert.deepEqual(findEntry(config, "CODEX_REVIEWS_PLAN").agent, { model: "sonnet", effort: "low" });
});

test("test_resolveAgentOptions_givesTheFallbackReviewersTheirOwnModelNotTheBand", () => {
    const stepsConfigPath = makeStepsConfig();
    const tasksFile = makeTasksFile([{ taskNumber: 1, difficulty: 4 }]);

    resolveAgentOptions(stepsConfigPath, tasksFile, 1);
    const config = readConfig(stepsConfigPath);
    assert.deepEqual(findEntry(config, "CODEX_REVIEW_FALLBACK_FABLE").agent, { model: "claude-fable-5-1[1m]", effort: "medium" });
    assert.deepEqual(findEntry(config, "CODEX_TEST_REVIEW_FALLBACK_OPUS").agent, { model: "claude-opus-4-8[1m]", effort: "high" });
});

test("test_resolveAgentOptions_throwsWhenTheTaskHasNoDifficulty", () => {
    const stepsConfigPath = makeStepsConfig();
    const tasksFile = makeTasksFile([{ taskNumber: 1 }]);

    assert.throws(() => resolveAgentOptions(stepsConfigPath, tasksFile, 1), /task 1 has no difficulty; run \/rate-task 1/);
});

test("test_bandBlocks_areAllPromptBlocksInTheRepoConfig", () => {
    const config: StepConfig = JSON.parse(readFileSync(CANONICAL_STEPS_CONFIG_PATH, "utf8"));
    for (const box of BAND_BLOCKS) {
        assert.equal(findEntry(config, box).producesPrompt, true, `${box} must be producesPrompt: true`);
    }
});

test("test_resolveAgentOptions_writesAFencedAgentFileForEveryBandBlock", () => {
    const stepsConfigPath = makeStepsConfig();
    const tasksFile = makeTasksFile([{ taskNumber: 1, difficulty: 4 }]);
    const projectRoot = dirname(tasksFile);

    resolveAgentOptions(stepsConfigPath, tasksFile, 1);

    const agentFile = join(projectRoot, ".claude", "agents", "task-1-implement-task.md");
    const content = readFileSync(agentFile, "utf8");
    assert.match(content, /name: task-1-implement-task/);
    // disallowedTools would strip Bash wholesale; the Bash hook filters commands instead.
    assert.doesNotMatch(content, /disallowedTools/);
    assert.match(content, /matcher: "Bash"\n      hooks:\n        - type: command\n          command: ".*agentBashHook\.ts\\""/);
    assert.match(content, /matcher: "Edit\|Write"/);
    assert.match(content, /agentFenceHook\.ts\\" 1 \\".*tasks\.json\\" IMPLEMENT_TASK"/);

    const plannerFile = join(projectRoot, ".claude", "agents", "task-1-plan-the-task.md");
    assert.match(readFileSync(plannerFile, "utf8"), /agentFenceHook\.ts\\" 1 \\".*tasks\.json\\" PLAN_THE_TASK"/);
    assert.equal(existsSync(join(projectRoot, ".claude", "agents", "task-1-codex-reviews-plan.md")), false);
});
