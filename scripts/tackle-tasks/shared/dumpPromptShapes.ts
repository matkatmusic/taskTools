// Rewrites skeleton/rendered prompt-shape markdown for every builder input combo; run after tweaking a prompt, then diff.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPreparedTask, type PreparedTask } from "./preparedTask.ts";
import { planChoices, planPrompt, planPromptSkeleton } from "./planPrompt.ts";
import { fixConflictsCombos } from "./FixConflictsBodyEmitter.ts";
import { reviewTestsCombos } from "./CodexTestReviewBodyEmitter.ts";
import { planReviewPrompt, planReviewPromptCombos, reviewQuestionCombos } from "./CodexReviewBodyEmitter.ts";
import { buildImplementPrompt, implementPromptCombos } from "../implementTask/IMPLEMENT_TASK.ts";
import { buildFixTaskTestsPrompt, fixTaskTestsPromptCombos } from "../fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.ts";
import { writeTaskBriefFile } from "../../shared/prepareTasks.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import { suiteFixPromptCombos } from "../fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.ts";

const OUT_ROOT = fileURLToPath(new URL("../../../plans/prompt-shapes", import.meta.url));

// The same hand-built task planPrompt.test.ts uses; repoRoot never exists, so resumedRunSection stays "".
export const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
    files: ["src/thing.ts"],
    readOnlyFiles: ["*"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    readFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    createsFiles: [],
    difficulty: 1,
    clarifyRequest: "",
    testFilePaths: [],
    hasTests: true,
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    siblingTasks: [],
    blockedBy: [],
    blocks: [],
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

type Combo = { name: string; skeleton: string; rendered: string };

export function planPromptCombos(): Combo[] {
    const combos: Combo[] = [];
    for (const codexReviewNotes of ["", "Point one.\nPoint two."]) {
        for (const readOnlyFiles of [["*"], ["src/a.ts", "src/b.ts"]]) {
            for (const [hasTests, tests] of [[false, null], [true, "node --test tests/thing.test.ts"], [true, null]] as const) {
                const task = { ...fakeTask, codexReviewNotes, readOnlyFiles, hasTests, tests };
                const c = planChoices(task);
                const name = `codex-${c.hasCodexNotes ? "notes" : "none"}_read-${c.readsAnyFile ? "any" : "list"}_tests-${c.testsField}`;
                combos.push({ name, skeleton: planPromptSkeleton(c), rendered: planPrompt(task) });
            }
        }
    }
    return combos;
}

const BUILDERS: Record<string, () => Combo[]> = {
    planPrompt: planPromptCombos,
    fixConflictsPrompt: fixConflictsCombos,
    reviewTests: reviewTestsCombos,
    reviewQuestion: reviewQuestionCombos,
    planReviewPrompt: planReviewPromptCombos,
    implementPrompt: implementPromptCombos,
    fixTaskTestsPrompt: fixTaskTestsPromptCombos,
    suiteFixPrompt: suiteFixPromptCombos,
};

// `node dumpPromptShapes.ts <N>`: renders the task-driven prompts for real open task N into plans/prompt-shapes/task-N/.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== undefined) {
    const taskNumber = Number(process.argv[2]);
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
    const record = readTaskFile(resolveTaskFiles(repoRoot).tasksPath).find((entry) => entry.taskNumber === taskNumber);
    if (record === undefined) throw new Error(`task ${taskNumber} not found in tasks.json`);
    const briefFile = writeTaskBriefFile(record, repoRoot);
    const task = loadPreparedTask(taskNumber, repoRoot, repoRoot);
    const dir = `${OUT_ROOT}/task-${taskNumber}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    renameSync(briefFile, `${dir}/brief.md`);
    writeFileSync(`${dir}/planPrompt.md`, planPrompt(task));
    process.env.RUN_STEP_LOG ??= `${dir}/run-log.json`;
    writeFileSync(`${dir}/planReviewPrompt.md`, planReviewPrompt(task));
    writeFileSync(`${dir}/implementPrompt.md`, buildImplementPrompt(task, "npx tsc --noEmit", 3));
    writeFileSync(`${dir}/fixTaskTestsPrompt.md`, buildFixTaskTestsPrompt(task));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
    rmSync(OUT_ROOT, { recursive: true, force: true });
    for (const [builder, combos] of Object.entries(BUILDERS)) {
        for (const combo of combos()) {
            const dir = `${OUT_ROOT}/${builder}/${combo.name}`;
            mkdirSync(dir, { recursive: true });
            writeFileSync(`${dir}/skeleton.md`, combo.skeleton);
            writeFileSync(`${dir}/rendered.md`, combo.rendered);
        }
    }
}
