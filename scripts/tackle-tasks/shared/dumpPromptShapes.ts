// Rewrites plans/prompt-shapes/<builder>/<combo>/{skeleton,rendered}.md for every input combination of every prompt builder.
// Run after tweaking a prompt: `node scripts/tackle-tasks/shared/dumpPromptShapes.ts`, then `git diff plans/prompt-shapes`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PreparedTask } from "./preparedTask.ts";
import { planChoices, planPrompt, planPromptSkeleton } from "./planPrompt.ts";
import { fixConflictsCombos } from "./FixConflictsBodyEmitter.ts";
import { reviewTestsCombos } from "./CodexTestReviewBodyEmitter.ts";
import { planReviewPromptCombos, reviewQuestionCombos } from "./CodexReviewBodyEmitter.ts";
import { implementPromptCombos } from "../implementTask/IMPLEMENT_TASK.ts";
import { fixTaskTestsPromptCombos } from "../fixImplementTaskTests/FIX_IMPLEMENT_TASK_TESTS.ts";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
