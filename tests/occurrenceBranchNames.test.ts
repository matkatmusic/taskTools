// Behavioral checks for occurrenceBranchNames.ts: per-occurrence deterministic branch naming.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { occurrenceBranchNames } from "../scripts/occurrenceBranchNames.ts";

function assertValidBranchName(name: string): void {
    assert.doesNotThrow(() => execFileSync("git", ["check-ref-format", "--branch", name]));
}

const TMUX_LIB_OCCURRENCE_PATHS = [
    "tmux_lib",
    "jfred/external/tmux_lib",
    "jfred/jfredToolsPlugin/external/tmux_lib",
];

test("test_uniqueRepositoryGetsThePlainGroupBranchName", () => {
    const names = occurrenceBranchNames("task-group-1", ["only_one_lib"]);
    assert.equal(names.size, 1);
    assert.equal(names.get("only_one_lib"), "task-group-1");
});

test("test_threeTmuxLibOccurrencesGetThreeDistinctValidBranchNames", () => {
    const names = occurrenceBranchNames("task-group-1", TMUX_LIB_OCCURRENCE_PATHS);
    const values = [...names.values()];
    assert.equal(new Set(values).size, 3);
    for (const name of values) assertValidBranchName(name);
});

test("test_namesAreByteIdenticalAcrossRepeatedInvocations", () => {
    const first = occurrenceBranchNames("task-group-1", TMUX_LIB_OCCURRENCE_PATHS);
    const second = occurrenceBranchNames("task-group-1", TMUX_LIB_OCCURRENCE_PATHS);
    assert.deepEqual(Object.fromEntries(first), Object.fromEntries(second));
});

test("test_pathsThatSanitizeToTheSameStringStillDifferByHash", () => {
    const names = occurrenceBranchNames("task-group-1", ["a:b/c", "a?b/c"]);
    assert.notEqual(names.get("a:b/c"), names.get("a?b/c"));
});

test("test_everyGeneratedNamePassesGitCheckRefFormat", () => {
    const combined = [
        ...occurrenceBranchNames("task-group-1", ["only_one_lib"]).values(),
        ...occurrenceBranchNames("task-group-1", TMUX_LIB_OCCURRENCE_PATHS).values(),
        ...occurrenceBranchNames("task-group-1", ["a:b/c", "a?b/c"]).values(),
    ];
    for (const name of combined) assertValidBranchName(name);
});
