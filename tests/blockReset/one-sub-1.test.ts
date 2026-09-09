// Matrix 3 block reset, one-submodule shape, part 1: resets first half of pipeline blocks to their packet's rewind point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../support/gitFixtures.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/shared/createTaskWorktree.ts";
import { claimTask } from "../../scripts/tackle-tasks/shared/taskRunState.ts";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { generateSteps, resolveDiagramFolderSetting } from "../../scripts/tackle-tasks/generateSteps.ts";
import { resolveTaskFiles, taskWorkflowDirectory } from "../../scripts/shared/taskFiles.ts";

const TASK_NUMBER = 9002;
const SUBMODULE_PATHS: string[] = ["sub"];

test("test_resetTask_atEveryBlock_oneSubmodule_restoresRootAndSubmoduleToThatBlocksRewindPoint", async () => {
    const fixture = makeShapeFixture("one-submodule", "behind-head", TASK_NUMBER);
    const repoRoot = fixture.rootPath;
    const cwd = process.cwd();
    let worktreePath = "";
    try {
        mkdirSync(join(repoRoot, ".taskTools"), { recursive: true });
        writeFileSync(join(repoRoot, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: TASK_NUMBER, title: "t" }]));
        writeFileSync(join(repoRoot, ".taskTools", "completedTasks.json"), "[]");

        const runId = "r1";
        claimTask(TASK_NUMBER, runId, repoRoot);
        const { worktree } = createTaskWorktree(TASK_NUMBER, runId, repoRoot);
        worktreePath = worktree;

        // Real block list, pipeline order, same technique as resetTask.test.ts's atEveryBlock test.
        const stepsConfigPath = join(taskWorkflowDirectory(resolveTaskFiles(repoRoot).tasksPath, TASK_NUMBER), "steps.json");
        mkdirSync(dirname(stepsConfigPath), { recursive: true });
        const setting = resolveDiagramFolderSetting(repoRoot);
        const stepsByDiagram = generateSteps(setting.diagramFolder, setting.stepsRoot, stepsConfigPath, setting.allowStubs);
        const boxCounts = new Map<string, number>();
        for (const entry of Object.values(stepsByDiagram).flat()) boxCounts.set(entry.box, (boxCounts.get(entry.box) ?? 0) + 1);
        const allBlocks = [...boxCounts].filter(([, count]) => count === 1).map(([box]) => box);
        assert.ok(allBlocks.length > 10);
        const blocks = allBlocks.slice(0, Math.ceil(allBlocks.length / 2));

        const packetsFolder = join(repoRoot, ".taskTools", "runs", "0000", "packets");
        mkdirSync(packetsFolder, { recursive: true });
        const packetInput = JSON.stringify({ taskNumber: TASK_NUMBER, runId, worktree: worktreePath, projectRoot: repoRoot });

        const rewindPointsByBlock = new Map<string, Record<string, string>>();
        let counter = 0;
        for (const block of blocks) {
            counter += 1;
            const rewindPoints: Record<string, string> = { "": git(worktreePath, "rev-parse", "HEAD") };
            for (const relPath of SUBMODULE_PATHS) rewindPoints[relPath] = git(join(worktreePath, relPath), "rev-parse", "HEAD");
            rewindPointsByBlock.set(block, rewindPoints);
            writeFileSync(join(packetsFolder, `${counter}-${block}-0-1.json`), JSON.stringify({
                command: `node --no-inspect script.ts '${packetInput}'`,
                rewindPoints,
            }));

            writeFileSync(join(worktreePath, `${block}-change.txt`), `${block}\n`);
            git(worktreePath, "add", `${block}-change.txt`);
            git(worktreePath, "commit", "-q", "-m", `${block} root change`);
            for (const relPath of SUBMODULE_PATHS) {
                const subPath = join(worktreePath, relPath);
                writeFileSync(join(subPath, `${block}-change.txt`), `${block}\n`);
                git(subPath, "add", `${block}-change.txt`);
                git(subPath, "commit", "-q", "-m", `${block} change`);
            }
        }

        process.chdir(repoRoot);
        for (const block of blocks) {
            await resetTask(TASK_NUMBER, block);
            const expected = rewindPointsByBlock.get(block)!;
            assert.equal(git(worktreePath, "rev-parse", "HEAD"), expected[""], `${block}: root HEAD`);
            for (const relPath of SUBMODULE_PATHS) {
                assert.equal(git(join(worktreePath, relPath), "rev-parse", "HEAD"), expected[relPath], `${block}: ${relPath} HEAD`);
                assert.equal(git(join(worktreePath, relPath), "branch", "--show-current"), `task-${TASK_NUMBER}`, `${block}: ${relPath} branch`);
            }
        }
    } finally {
        process.chdir(cwd);
        if (worktreePath) rmSync(dirname(worktreePath), { recursive: true, force: true });
        for (const repo of fixture.repos) rmSync(repo.checkoutPath, { recursive: true, force: true });
    }
});
