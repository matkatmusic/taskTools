// Run: node --test tests/emitPipelineOutput.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { annotatedBody } from "../scripts/tackle-tasks/emitPipelineOutput.ts";
import { skillBody } from "../scripts/tackle-tasks/SkillBodyEmitter.ts";
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

// Each repository mints its own path and runId, so neither is part of what "byte-faithful" checks.
const normalize = (body: string, root: string): string =>
    body.replaceAll(root, "<root>")
        .replaceAll(resolveTaskWorktreeConventionDirectory(root), "<worktreeDir>")
        .replace(/"runId":"[^"]*"/, '"runId":"<runId>"');

test("test_annotatedBody_leavesTheEmittedBodyByteFaithfulOnceCommentsAreStripped", () => {
    const actualRoot = makeTargetRepository(74);
    const actual = normalize(stripAnnotations(annotatedBody(74, actualRoot)), actualRoot);
    const expectedRoot = makeTargetRepository(74);
    const expected = normalize(skillBody("[74]", expectedRoot), expectedRoot);
    // The file is a thing to craft, so the annotations must add nothing the emitter did not print.
    assert.equal(actual, expected);
});
