// Run: node --test tests/emitPipelineOutput.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { annotatedBody, matchPathNumber } from "../scripts/tackle-tasks/emitPipelineOutput.ts";
import { skillBody } from "../scripts/tackle-tasks/SkillBodyEmitter.ts";
import { traceTaskPipeline, readNamedPaths } from "../scripts/tracePipeline.ts";
import { resolveTaskWorktreeConventionDirectory } from "../scripts/prepareTasks.ts";

const temporaryDirectories: string[] = [];
after(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// A throwaway repository, so emitting a body never marks a real task active.
const makeTargetRepository = (taskNumber: number): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "emitPipelineOutput-")));
    temporaryDirectories.push(root, resolveTaskWorktreeConventionDirectory(root));
    const git = (...gitArguments: string[]) => execFileSync("git", ["-C", root, ...gitArguments], { encoding: "utf8" });
    git("init", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "Target task", files: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify([]));
    git("add", ".taskTools");
    git("commit", "-m", "initial");
    return root;
};

const stripAnnotations = (body: string): string =>
    body.split("\n").filter((line) => !/^<!-- SkillBodyEmitter\.ts:\d+ -->$/.test(line)).join("\n");

test("test_annotatedBody_leavesTheEmittedBodyByteFaithfulOnceCommentsAreStripped", () => {
    // The file is a thing to craft, so the annotations must add nothing the emitter did not print.
    assert.equal(stripAnnotations(annotatedBody(74, makeTargetRepository(74))), skillBody("[74]", makeTargetRepository(74)));
});

test("test_matchPathNumber_identifiesTheFixtureThatProducedAPipelineBlock", () => {
    // Setup: the block the invalid-number path prints for a real task number.
    const invalidNumber = readNamedPaths()["invalid-number"];
    const trace = traceTaskPipeline({ ...invalidNumber, taskNumber: 191 });

    // Verification: matching is by block, not by decisions, and the fixture's position is the number.
    assert.deepEqual(matchPathNumber(trace, 191), { number: 1, name: "invalid-number" });
});

test("test_matchPathNumber_refusesABlockNoFixtureProduces", () => {
    // A silent fallback would name a file after the wrong path, so an unknown block must stop the run.
    assert.throws(() => matchPathNumber(["not a pipeline block"], 191), /matches no known fixture/);
});
